import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { setupChannelCapabilities } from './capabilities/channels.js';
import { setupFileCapabilities } from './capabilities/files.js';
import { setupMessageCapabilities } from './capabilities/messages.js';
import { setupUserCapabilities } from './capabilities/users.js';
import {
  AuthError,
  NotFoundError,
  RateLimitError,
  SlackApiError,
  SlackMcpError,
  ValidationError as TypedValidationError,
} from './errors/index.js';
import { SlackResource, SlackTool, MCPServerConfig } from './types/mcp.js';
import { logger, logAudit } from './utils/logger.js';
import { slackClientManager } from './utils/slack-client.js';
import { ValidationError } from './utils/validators.js';

// Import capabilities

export class SlackMCPServer {
  private server: Server;
  private resources: Map<string, SlackResource> = new Map();
  private tools: Map<string, SlackTool> = new Map();

  constructor(private config: MCPServerConfig) {
    this.server = new Server(
      {
        name: config.name,
        version: config.version,
      },
      {
        capabilities: {
          resources: config.capabilities.resources ? {} : undefined,
          tools: config.capabilities.tools ? {} : undefined,
          prompts: config.capabilities.prompts ? {} : undefined,
          logging: config.capabilities.logging ? {} : undefined,
        },
      },
    );

    this.setupHandlers();
    this.setupCapabilities();

    logger.info('SlackMCPServer initialized', {
      name: config.name,
      version: config.version,
      capabilities: config.capabilities,
    });
  }

  private setupHandlers(): void {
    // Resource handlers
    if (this.config.capabilities.resources) {
      this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
        logger.debug('Listing resources', { count: this.resources.size });

        return {
          resources: Array.from(this.resources.values()).map((resource) => ({
            uri: resource.uri,
            name: resource.name,
            description: resource.description,
            mimeType: resource.mimeType,
          })),
        };
      });

      this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
        const { uri } = request.params;

        logger.debug('Reading resource', { uri });

        const resource = this.resources.get(uri);
        if (!resource) {
          throw new McpError(ErrorCode.InvalidRequest, `Resource not found: ${uri}`);
        }

        try {
          const content = await this.readResourceContent(uri);

          logAudit({
            user: 'mcp-client',
            action: 'read_resource',
            resource: uri,
            details: { uri },
            status: 'success',
          });

          return {
            contents: [
              {
                uri: resource.uri,
                mimeType: resource.mimeType || 'application/json',
                text: JSON.stringify(content, null, 2),
              },
            ],
          };
        } catch (error) {
          logger.error('Failed to read resource', { uri, error });
          throw new McpError(
            ErrorCode.InternalError,
            `Failed to read resource: ${(error as Error).message}`,
          );
        }
      });
    }

    // Tool handlers
    if (this.config.capabilities.tools) {
      this.server.setRequestHandler(ListToolsRequestSchema, async () => {
        logger.debug('Listing tools', { count: this.tools.size });

        return {
          tools: Array.from(this.tools.values()).map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        };
      });

      this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;

        logger.debug('Calling tool', { name, args });

        const tool = this.tools.get(name);
        if (!tool) {
          throw new McpError(ErrorCode.InvalidRequest, `Tool not found: ${name}`);
        }

        try {
          const result = await this.callTool(name, args || {});

          logAudit({
            user: 'mcp-client',
            action: 'call_tool',
            resource: `tool:${name}`,
            details: { tool: name, arguments: args },
            status: 'success',
          });

          return {
            content: [
              {
                type: 'text',
                text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
              },
            ],
          };
        } catch (error) {
          let mcpError: McpError;

          if (error instanceof McpError) {
            mcpError = error;
          } else if (error instanceof TypedValidationError) {
            mcpError = new McpError(ErrorCode.InvalidParams, error.message);
          } else if (error instanceof AuthError) {
            // No native MCP code for auth — InvalidRequest is the closest
            // semantic fit (the request was rejected, not server-broken).
            mcpError = new McpError(ErrorCode.InvalidRequest, error.message);
          } else if (error instanceof NotFoundError) {
            // The resource the caller named doesn't exist; surface as bad
            // params rather than generic InternalError.
            mcpError = new McpError(ErrorCode.InvalidParams, error.message);
          } else if (error instanceof RateLimitError) {
            // MCP has no standard rate-limit code; preserve retryAfter via
            // the structured `data` payload so clients can react.
            mcpError = new McpError(ErrorCode.InternalError, error.message, {
              code: 'RATE_LIMIT',
              retryAfter: error.retryAfter,
            });
          } else if (error instanceof SlackApiError) {
            mcpError = new McpError(ErrorCode.InternalError, error.message, {
              code: 'SLACK_API',
            });
          } else if (error instanceof SlackMcpError) {
            mcpError = new McpError(ErrorCode.InternalError, error.message, {
              code: error.code,
            });
          } else if (error instanceof ValidationError) {
            // Legacy validators still throw the older ValidationError shape.
            mcpError = new McpError(ErrorCode.InvalidParams, error.message);
          } else {
            mcpError = new McpError(
              ErrorCode.InternalError,
              `Tool execution failed: ${(error as Error).message}`,
            );
          }

          logAudit({
            user: 'mcp-client',
            action: 'call_tool',
            resource: `tool:${name}`,
            details: {
              tool: name,
              arguments: args,
              error: mcpError.message,
            },
            status: 'error',
          });

          throw mcpError;
        }
      });
    }

    // Error handling
    this.server.onerror = (error) => {
      logger.error('MCP Server error', { error: error.message, stack: error.stack });
    };
  }

  private setupCapabilities(): void {
    // Setup all capability modules
    setupChannelCapabilities(this);
    setupMessageCapabilities(this);
    setupUserCapabilities(this);
    setupFileCapabilities(this);

    // Setup default resources
    this.setupDefaultResources();

    logger.info('All capabilities set up', {
      resources: this.resources.size,
      tools: this.tools.size,
    });
  }

  private setupDefaultResources(): void {
    // Channels resource - lists all channels for a workspace
    this.registerResource({
      uri: 'slack://channels/{workspace_id}',
      name: 'Slack Channels',
      description: 'List all channels in a Slack workspace',
      mimeType: 'application/json',
    });

    // Specific channel resource
    this.registerResource({
      uri: 'slack://channels/{workspace_id}/{channel_id}',
      name: 'Slack Channel',
      description: 'Information about a specific Slack channel',
      mimeType: 'application/json',
    });

    // Users resource - lists all users for a workspace
    this.registerResource({
      uri: 'slack://users/{workspace_id}',
      name: 'Slack Users',
      description: 'List all users in a Slack workspace',
      mimeType: 'application/json',
    });

    // Specific user resource
    this.registerResource({
      uri: 'slack://users/{workspace_id}/{user_id}',
      name: 'Slack User',
      description: 'Information about a specific Slack user',
      mimeType: 'application/json',
    });

    // Messages resource - channel messages
    this.registerResource({
      uri: 'slack://messages/{workspace_id}/{channel_id}',
      name: 'Slack Channel Messages',
      description: 'Messages from a specific Slack channel',
      mimeType: 'application/json',
    });

    // Specific message thread resource
    this.registerResource({
      uri: 'slack://messages/{workspace_id}/{channel_id}/{thread_ts}',
      name: 'Slack Message Thread',
      description: 'Messages from a specific thread in a Slack channel',
      mimeType: 'application/json',
    });

    logger.info('Default resources registered', {
      totalResources: this.resources.size,
    });
  }

  // Resource management
  registerResource(resource: SlackResource): void {
    this.resources.set(resource.uri, resource);
    logger.debug('Resource registered', { uri: resource.uri, name: resource.name });
  }

  unregisterResource(uri: string): void {
    this.resources.delete(uri);
    logger.debug('Resource unregistered', { uri });
  }

  // Tool management
  registerTool(tool: SlackTool, handler: (args: any) => Promise<any>): void {
    this.tools.set(tool.name, tool);
    this.toolHandlers.set(tool.name, handler);
    logger.debug('Tool registered', { name: tool.name });
  }

  listToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  private toolHandlers: Map<string, (args: any) => Promise<any>> = new Map();

  unregisterTool(name: string): void {
    this.tools.delete(name);
    this.toolHandlers.delete(name);
    logger.debug('Tool unregistered', { name });
  }

  // Resource content reader
  private async readResourceContent(uri: string): Promise<any> {
    // Parse Slack URI: slack://type/workspace/resource
    const match = uri.match(/^slack:\/\/([^/]+)\/([^/]+)(?:\/(.+))?$/);
    if (!match) {
      throw new Error(`Invalid Slack resource URI: ${uri}`);
    }

    const [, type, workspaceId, resourceId] = match;

    if (!workspaceId) {
      throw new Error('Workspace ID is required in URI');
    }

    // Skip template URIs (those with {workspace_id} etc.)
    if (workspaceId.includes('{') || workspaceId.includes('}')) {
      throw new Error(
        `Resource URI contains templates. Please use actual workspace and resource IDs.`,
      );
    }

    // Validate workspace exists
    if (!slackClientManager.listWorkspaces().includes(workspaceId)) {
      throw new Error(`Workspace not found or not authenticated: ${workspaceId}`);
    }

    switch (type) {
      case 'channels':
        if (resourceId && !resourceId.includes('{')) {
          // Get specific channel info
          const result = await slackClientManager.apiCall(workspaceId, 'conversations.info', {
            channel: resourceId,
          });
          return {
            channel: result.channel,
            members: await this.getChannelMembers(workspaceId, resourceId),
            metadata: {
              uri,
              type: 'channel',
              workspace_id: workspaceId,
              channel_id: resourceId,
            },
          };
        } else {
          // List all channels
          const result = await slackClientManager.apiCall(workspaceId, 'conversations.list', {
            limit: 100,
            types: 'public_channel,private_channel',
          });
          return {
            channels: result.channels || [],
            metadata: {
              uri,
              type: 'channels_list',
              workspace_id: workspaceId,
              count: (result.channels || []).length,
            },
          };
        }

      case 'users':
        if (resourceId && !resourceId.includes('{')) {
          // Get specific user info
          const result = await slackClientManager.apiCall(workspaceId, 'users.info', {
            user: resourceId,
          });
          return {
            user: result.user,
            metadata: {
              uri,
              type: 'user',
              workspace_id: workspaceId,
              user_id: resourceId,
            },
          };
        } else {
          // List all users
          const result = await slackClientManager.apiCall(workspaceId, 'users.list', {
            limit: 100,
          });
          return {
            users: (result.members || []).filter((user: any) => !user.deleted),
            metadata: {
              uri,
              type: 'users_list',
              workspace_id: workspaceId,
              count: (result.members || []).filter((user: any) => !user.deleted).length,
            },
          };
        }

      case 'messages':
        if (resourceId && !resourceId.includes('{')) {
          const parts = resourceId.split('/');
          const channelId = parts[0];
          const threadTs = parts[1];

          if (threadTs) {
            // Get specific message thread
            const result = await slackClientManager.apiCall(workspaceId, 'conversations.replies', {
              channel: channelId,
              ts: threadTs,
              limit: 100,
            });
            return {
              messages: result.messages || [],
              thread_ts: threadTs,
              metadata: {
                uri,
                type: 'message_thread',
                workspace_id: workspaceId,
                channel_id: channelId,
                thread_ts: threadTs,
                count: (result.messages || []).length,
              },
            };
          } else {
            // Get channel message history
            const result = await slackClientManager.apiCall(workspaceId, 'conversations.history', {
              channel: channelId,
              limit: 50,
            });
            return {
              messages: result.messages || [],
              metadata: {
                uri,
                type: 'channel_messages',
                workspace_id: workspaceId,
                channel_id: channelId,
                count: (result.messages || []).length,
              },
            };
          }
        }
        throw new Error('Messages resource requires channel ID');

      default:
        throw new Error(`Unsupported resource type: ${type}`);
    }
  }

  // Helper method to get channel members
  private async getChannelMembers(workspaceId: string, channelId: string): Promise<string[]> {
    try {
      const result = await slackClientManager.apiCall(workspaceId, 'conversations.members', {
        channel: channelId,
        limit: 100,
      });
      return result.members || [];
    } catch (error) {
      logger.warn('Failed to get channel members', { workspaceId, channelId, error });
      return [];
    }
  }

  // Tool execution
  async callTool(name: string, args: any): Promise<any> {
    const handler = this.toolHandlers.get(name);
    if (!handler) {
      throw new Error(`No handler found for tool: ${name}`);
    }

    return handler(args);
  }

  // Server lifecycle
  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    logger.info('SlackMCPServer started', {
      transport: 'stdio',
      resources: this.resources.size,
      tools: this.tools.size,
    });

    logAudit({
      user: 'system',
      action: 'server_started',
      resource: 'mcp-server',
      details: {
        name: this.config.name,
        version: this.config.version,
        capabilities: this.config.capabilities,
      },
      status: 'success',
    });
  }

  async stop(): Promise<void> {
    await this.server.close();

    logger.info('SlackMCPServer stopped');

    logAudit({
      user: 'system',
      action: 'server_stopped',
      resource: 'mcp-server',
      details: { name: this.config.name },
      status: 'success',
    });
  }

  // Health check
  async healthCheck(): Promise<{ status: string; workspaces: Record<string, boolean> }> {
    const workspaces = await slackClientManager.healthCheck();
    const allHealthy = Object.values(workspaces).every(Boolean);

    return {
      status: allHealthy ? 'healthy' : 'partial',
      workspaces,
    };
  }

  // Get server stats
  getStats(): {
    resources: number;
    tools: number;
    workspaces: string[];
    uptime: number;
  } {
    return {
      resources: this.resources.size,
      tools: this.tools.size,
      workspaces: slackClientManager.listWorkspaces(),
      uptime: process.uptime(),
    };
  }
}

export { SlackMCPServer as default };
