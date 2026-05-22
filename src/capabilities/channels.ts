import { permissionManager } from '../auth/permissions.js';
import { SlackMCPServer } from '../server.js';
import { logger } from '../utils/logger.js';
import { slackClientManager } from '../utils/slack-client.js';
import {
  validateSlackChannelId,
  validateSlackChannelCreateSchema,
  validateSlackWorkspaceId,
} from '../utils/validators.js';

import { wrap } from './_wrap.js';

export function setupChannelCapabilities(server: SlackMCPServer): void {
  // Tool: List Channels
  server.registerTool(
    {
      name: 'list_channels',
      description: 'List all channels in the workspace',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: {
            type: 'string',
            description: 'Slack workspace ID',
          },
          types: {
            type: 'string',
            description: 'Channel types to include (public_channel,private_channel,mpim,im)',
            default: 'public_channel,private_channel',
          },
          exclude_archived: {
            type: 'boolean',
            description: 'Exclude archived channels (default: false)',
          },
          limit: {
            type: 'number',
            description: 'Number of channels to return (max 1000, default 100)',
            minimum: 1,
            maximum: 1000,
          },
          cursor: {
            type: 'string',
            description: 'Pagination cursor',
          },
          user_id: {
            type: 'string',
            description: 'User ID making the request',
          },
        },
        required: ['workspace_id', 'user_id'],
      },
    },
    wrap(
      'list_channels',
      async (args) => {
        const {
          workspace_id,
          user_id,
          types = 'public_channel,private_channel',
          exclude_archived = false,
          limit = 100,
          cursor,
        } = args;

        // Validate permissions
        await permissionManager.requirePermission(workspace_id, user_id, 'list_channels');

        // Validate inputs
        validateSlackWorkspaceId(workspace_id);

        const result = await slackClientManager.apiCall(
          workspace_id,
          'conversations.list',
          {
            types,
            exclude_archived,
            limit: Math.min(limit, 1000),
            ...(cursor && { cursor }),
          },
          user_id,
        );

        return {
          success: true,
          channels: result.channels || [],
          response_metadata: result.response_metadata || {},
          total_count: result.channels?.length || 0,
        };
      },
      { idempotent: true },
    ),
  );

  // Tool: Create Channel
  server.registerTool(
    {
      name: 'create_channel',
      description: 'Create a new Slack channel',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: {
            type: 'string',
            description: 'Slack workspace ID',
          },
          name: {
            type: 'string',
            description: 'Channel name (lowercase, no spaces, max 21 characters)',
            maxLength: 21,
          },
          is_private: {
            type: 'boolean',
            description: 'Create as private channel (default: false)',
            default: false,
          },
          user_id: {
            type: 'string',
            description: 'User ID making the request',
          },
        },
        required: ['workspace_id', 'name', 'user_id'],
      },
    },
    wrap('create_channel', async (args) => {
      const { workspace_id, user_id, name, is_private = false } = args;

      // Validate permissions
      await permissionManager.requirePermission(workspace_id, user_id, 'create_channel');

      // Validate inputs
      validateSlackWorkspaceId(workspace_id);
      const validatedArgs = validateSlackChannelCreateSchema({
        name: name.toLowerCase().replace(/[^a-z0-9-_]/g, ''),
        is_private,
      });

      const result = await slackClientManager.apiCall(
        workspace_id,
        'conversations.create',
        validatedArgs,
        user_id,
      );

      return {
        success: true,
        channel: {
          id: result.channel?.id,
          name: result.channel?.name,
          is_private: result.channel?.is_private,
          created: result.channel?.created,
          creator: result.channel?.creator,
        },
      };
    }),
  );

  // Tool: Get Channel Info
  server.registerTool(
    {
      name: 'get_channel_info',
      description: 'Get detailed information about a specific channel',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: {
            type: 'string',
            description: 'Slack workspace ID',
          },
          channel: {
            type: 'string',
            description: 'Channel ID or name',
          },
          include_locale: {
            type: 'boolean',
            description: 'Include locale information (default: false)',
          },
          user_id: {
            type: 'string',
            description: 'User ID making the request',
          },
        },
        required: ['workspace_id', 'channel', 'user_id'],
      },
    },
    wrap(
      'get_channel_info',
      async (args) => {
        const { workspace_id, user_id, channel, include_locale = false } = args;

        // Validate permissions
        await permissionManager.requirePermission(workspace_id, user_id, 'get_channel_info');

        // Validate inputs
        validateSlackWorkspaceId(workspace_id);

        const result = await slackClientManager.apiCall(
          workspace_id,
          'conversations.info',
          {
            channel,
            include_locale,
          },
          user_id,
        );

        return {
          success: true,
          channel: result.channel,
        };
      },
      { idempotent: true },
    ),
  );

  // Tool: Join Channel
  server.registerTool(
    {
      name: 'join_channel',
      description: 'Join a channel',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: {
            type: 'string',
            description: 'Slack workspace ID',
          },
          channel: {
            type: 'string',
            description: 'Channel ID or name to join',
          },
          user_id: {
            type: 'string',
            description: 'User ID making the request',
          },
        },
        required: ['workspace_id', 'channel', 'user_id'],
      },
    },
    wrap('join_channel', async (args) => {
      const { workspace_id, user_id, channel } = args;

      // Validate permissions
      await permissionManager.requirePermission(workspace_id, user_id, 'list_channels');

      // Validate inputs
      validateSlackWorkspaceId(workspace_id);

      const result = await slackClientManager.apiCall(
        workspace_id,
        'conversations.join',
        { channel },
        user_id,
      );

      return {
        success: true,
        channel: {
          id: result.channel?.id,
          name: result.channel?.name,
          is_member: true,
        },
      };
    }),
  );

  // Tool: Leave Channel
  server.registerTool(
    {
      name: 'leave_channel',
      description: 'Leave a channel',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: {
            type: 'string',
            description: 'Slack workspace ID',
          },
          channel: {
            type: 'string',
            description: 'Channel ID or name to leave',
          },
          user_id: {
            type: 'string',
            description: 'User ID making the request',
          },
        },
        required: ['workspace_id', 'channel', 'user_id'],
      },
    },
    wrap('leave_channel', async (args) => {
      const { workspace_id, user_id, channel } = args;

      // Validate permissions
      await permissionManager.requirePermission(workspace_id, user_id, 'list_channels');

      // Validate inputs
      validateSlackWorkspaceId(workspace_id);

      await slackClientManager.apiCall(workspace_id, 'conversations.leave', { channel }, user_id);

      return {
        success: true,
        left_channel: channel,
        is_member: false,
      };
    }),
  );

  // Tool: Archive Channel
  server.registerTool(
    {
      name: 'archive_channel',
      description: 'Archive a channel',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: {
            type: 'string',
            description: 'Slack workspace ID',
          },
          channel: {
            type: 'string',
            description: 'Channel ID to archive',
          },
          user_id: {
            type: 'string',
            description: 'User ID making the request (requires admin privileges)',
          },
        },
        required: ['workspace_id', 'channel', 'user_id'],
      },
    },
    wrap('archive_channel', async (args) => {
      const { workspace_id, user_id, channel } = args;

      // Validate permissions (admin required for archiving)
      await permissionManager.requirePermission(workspace_id, user_id, 'manage_users');

      // Validate inputs
      validateSlackWorkspaceId(workspace_id);
      validateSlackChannelId(channel);

      await slackClientManager.apiCall(workspace_id, 'conversations.archive', { channel }, user_id);

      return {
        success: true,
        archived_channel: channel,
        is_archived: true,
      };
    }),
  );

  // Tool: Unarchive Channel
  server.registerTool(
    {
      name: 'unarchive_channel',
      description: 'Unarchive a channel',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: {
            type: 'string',
            description: 'Slack workspace ID',
          },
          channel: {
            type: 'string',
            description: 'Channel ID to unarchive',
          },
          user_id: {
            type: 'string',
            description: 'User ID making the request (requires admin privileges)',
          },
        },
        required: ['workspace_id', 'channel', 'user_id'],
      },
    },
    wrap('unarchive_channel', async (args) => {
      const { workspace_id, user_id, channel } = args;

      // Validate permissions (admin required for unarchiving)
      await permissionManager.requirePermission(workspace_id, user_id, 'manage_users');

      // Validate inputs
      validateSlackWorkspaceId(workspace_id);
      validateSlackChannelId(channel);

      await slackClientManager.apiCall(
        workspace_id,
        'conversations.unarchive',
        { channel },
        user_id,
      );

      return {
        success: true,
        unarchived_channel: channel,
        is_archived: false,
      };
    }),
  );

  // Tool: Set Channel Topic
  server.registerTool(
    {
      name: 'set_channel_topic',
      description: 'Set the topic for a channel',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: {
            type: 'string',
            description: 'Slack workspace ID',
          },
          channel: {
            type: 'string',
            description: 'Channel ID',
          },
          topic: {
            type: 'string',
            description: 'New channel topic (max 250 characters)',
            maxLength: 250,
          },
          user_id: {
            type: 'string',
            description: 'User ID making the request',
          },
        },
        required: ['workspace_id', 'channel', 'topic', 'user_id'],
      },
    },
    wrap('set_channel_topic', async (args) => {
      const { workspace_id, user_id, channel, topic } = args;

      // Validate permissions
      await permissionManager.requirePermission(workspace_id, user_id, 'create_channel');

      // Validate inputs
      validateSlackWorkspaceId(workspace_id);
      validateSlackChannelId(channel);

      const result = await slackClientManager.apiCall(
        workspace_id,
        'conversations.setTopic',
        {
          channel,
          topic: topic.substring(0, 250), // Ensure max length
        },
        user_id,
      );

      return {
        success: true,
        channel,
        topic: result.topic,
      };
    }),
  );

  // Tool: Set Channel Purpose
  server.registerTool(
    {
      name: 'set_channel_purpose',
      description: 'Set the purpose for a channel',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: {
            type: 'string',
            description: 'Slack workspace ID',
          },
          channel: {
            type: 'string',
            description: 'Channel ID',
          },
          purpose: {
            type: 'string',
            description: 'New channel purpose (max 250 characters)',
            maxLength: 250,
          },
          user_id: {
            type: 'string',
            description: 'User ID making the request',
          },
        },
        required: ['workspace_id', 'channel', 'purpose', 'user_id'],
      },
    },
    wrap('set_channel_purpose', async (args) => {
      const { workspace_id, user_id, channel, purpose } = args;

      // Validate permissions
      await permissionManager.requirePermission(workspace_id, user_id, 'create_channel');

      // Validate inputs
      validateSlackWorkspaceId(workspace_id);
      validateSlackChannelId(channel);

      const result = await slackClientManager.apiCall(
        workspace_id,
        'conversations.setPurpose',
        {
          channel,
          purpose: purpose.substring(0, 250), // Ensure max length
        },
        user_id,
      );

      return {
        success: true,
        channel,
        purpose: result.purpose,
      };
    }),
  );

  // Tool: Invite Users to Channel
  server.registerTool(
    {
      name: 'invite_to_channel',
      description: 'Invite users to a channel',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: {
            type: 'string',
            description: 'Slack workspace ID',
          },
          channel: {
            type: 'string',
            description: 'Channel ID to invite users to',
          },
          users: {
            type: 'string',
            description: 'Comma-separated list of user IDs to invite',
          },
          user_id: {
            type: 'string',
            description: 'User ID making the request',
          },
        },
        required: ['workspace_id', 'channel', 'users', 'user_id'],
      },
    },
    wrap('invite_to_channel', async (args) => {
      const { workspace_id, user_id, channel, users } = args;

      // Validate permissions
      await permissionManager.requirePermission(workspace_id, user_id, 'create_channel');

      // Validate inputs
      validateSlackWorkspaceId(workspace_id);
      validateSlackChannelId(channel);

      const result = await slackClientManager.apiCall(
        workspace_id,
        'conversations.invite',
        {
          channel,
          users,
        },
        user_id,
      );

      return {
        success: true,
        channel,
        invited_users: users.split(','),
        channel_info: result.channel,
      };
    }),
  );

  // Tool: Get Channel Members
  server.registerTool(
    {
      name: 'get_channel_members',
      description: 'Get list of members in a channel',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: {
            type: 'string',
            description: 'Slack workspace ID',
          },
          channel: {
            type: 'string',
            description: 'Channel ID',
          },
          limit: {
            type: 'number',
            description: 'Number of members to return (max 1000, default 100)',
            minimum: 1,
            maximum: 1000,
          },
          cursor: {
            type: 'string',
            description: 'Pagination cursor',
          },
          user_id: {
            type: 'string',
            description: 'User ID making the request',
          },
        },
        required: ['workspace_id', 'channel', 'user_id'],
      },
    },
    wrap(
      'get_channel_members',
      async (args) => {
        const { workspace_id, user_id, channel, limit = 100, cursor } = args;

        // Validate permissions
        await permissionManager.requirePermission(workspace_id, user_id, 'list_channels');

        // Validate inputs
        validateSlackWorkspaceId(workspace_id);
        validateSlackChannelId(channel);

        const result = await slackClientManager.apiCall(
          workspace_id,
          'conversations.members',
          {
            channel,
            limit: Math.min(limit, 1000),
            ...(cursor && { cursor }),
          },
          user_id,
        );

        return {
          success: true,
          channel,
          members: result.members || [],
          response_metadata: result.response_metadata || {},
          total_count: result.members?.length || 0,
        };
      },
      { idempotent: true },
    ),
  );

  logger.info('Channel capabilities registered', {
    tools: [
      'list_channels',
      'create_channel',
      'get_channel_info',
      'join_channel',
      'leave_channel',
      'archive_channel',
      'unarchive_channel',
      'set_channel_topic',
      'set_channel_purpose',
      'invite_to_channel',
      'get_channel_members',
    ],
  });
}
