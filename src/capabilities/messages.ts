import { permissionManager } from '../auth/permissions.js';
import { SlackMCPServer } from '../server.js';
import { logger } from '../utils/logger.js';
import { slackClientManager } from '../utils/slack-client.js';
import {
  validateSlackChannelId,
  validateSlackMessageSendSchema,
  validateSlackTimestamp,
  sanitizeSlackMessage,
} from '../utils/validators.js';

import { wrap } from './_wrap.js';

export function setupMessageCapabilities(server: SlackMCPServer): void {
  // Tool: Send Message
  server.registerTool(
    {
      name: 'send_message',
      description: 'Send a message to a Slack channel or direct message',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: {
            type: 'string',
            description: 'Slack workspace ID',
          },
          channel: {
            type: 'string',
            description: 'Channel ID or name (e.g., #general, @username, or C1234567890)',
          },
          text: {
            type: 'string',
            description: 'Message text (supports Slack formatting)',
          },
          thread_ts: {
            type: 'string',
            description: 'Thread timestamp to reply to (optional)',
          },
          reply_broadcast: {
            type: 'boolean',
            description: 'Whether to broadcast thread reply to channel (default: false)',
          },
          unfurl_links: {
            type: 'boolean',
            description: 'Whether to unfurl links (default: true)',
          },
          unfurl_media: {
            type: 'boolean',
            description: 'Whether to unfurl media (default: true)',
          },
          user_id: {
            type: 'string',
            description: 'User ID making the request (for permission checking)',
          },
        },
        required: ['workspace_id', 'channel', 'text', 'user_id'],
      },
    },
    wrap('send_message', async (args) => {
      const { workspace_id, user_id, ...messageArgs } = args;

      // Validate permissions
      await permissionManager.requirePermission(workspace_id, user_id, 'send_message');

      // Validate input
      const validatedArgs = validateSlackMessageSendSchema({
        channel: messageArgs.channel,
        text: sanitizeSlackMessage(messageArgs.text),
        thread_ts: messageArgs.thread_ts,
        reply_broadcast: messageArgs.reply_broadcast,
        unfurl_links: messageArgs.unfurl_links ?? true,
        unfurl_media: messageArgs.unfurl_media ?? true,
      });

      const result = await slackClientManager.apiCall(
        workspace_id,
        'chat.postMessage',
        validatedArgs,
        user_id,
      );

      return {
        success: true,
        message: {
          ts: result.ts,
          channel: result.channel,
          text: validatedArgs.text,
        },
        thread_ts: result.message?.thread_ts,
      };
    }),
  );

  // Tool: Update Message
  server.registerTool(
    {
      name: 'update_message',
      description: 'Update an existing Slack message',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: {
            type: 'string',
            description: 'Slack workspace ID',
          },
          channel: {
            type: 'string',
            description: 'Channel ID where the message is located',
          },
          ts: {
            type: 'string',
            description: 'Message timestamp to update',
          },
          text: {
            type: 'string',
            description: 'New message text',
          },
          user_id: {
            type: 'string',
            description: 'User ID making the request',
          },
        },
        required: ['workspace_id', 'channel', 'ts', 'text', 'user_id'],
      },
    },
    wrap('update_message', async (args) => {
      const { workspace_id, user_id, channel, ts, text } = args;

      // Validate permissions
      await permissionManager.requirePermission(workspace_id, user_id, 'send_message');

      // Validate inputs
      validateSlackChannelId(channel);
      validateSlackTimestamp(ts);

      const result = await slackClientManager.apiCall(
        workspace_id,
        'chat.update',
        {
          channel,
          ts,
          text: sanitizeSlackMessage(text),
        },
        user_id,
      );

      return {
        success: true,
        message: {
          ts: result.ts,
          channel: result.channel,
          text: text,
        },
      };
    }),
  );

  // Tool: Delete Message
  server.registerTool(
    {
      name: 'delete_message',
      description: 'Delete a Slack message',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: {
            type: 'string',
            description: 'Slack workspace ID',
          },
          channel: {
            type: 'string',
            description: 'Channel ID where the message is located',
          },
          ts: {
            type: 'string',
            description: 'Message timestamp to delete',
          },
          user_id: {
            type: 'string',
            description: 'User ID making the request',
          },
        },
        required: ['workspace_id', 'channel', 'ts', 'user_id'],
      },
    },
    wrap('delete_message', async (args) => {
      const { workspace_id, user_id, channel, ts } = args;

      // Validate permissions
      await permissionManager.requirePermission(workspace_id, user_id, 'send_message');

      // Validate inputs
      validateSlackChannelId(channel);
      validateSlackTimestamp(ts);

      await slackClientManager.apiCall(workspace_id, 'chat.delete', { channel, ts }, user_id);

      return {
        success: true,
        deleted: true,
        channel,
        ts,
      };
    }),
  );

  // Tool: Get Channel History
  server.registerTool(
    {
      name: 'get_channel_history',
      description: 'Get message history from a Slack channel',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: {
            type: 'string',
            description: 'Slack workspace ID',
          },
          channel: {
            type: 'string',
            description: 'Channel ID to get history from',
          },
          latest: {
            type: 'string',
            description: 'Latest message timestamp (end of range)',
          },
          oldest: {
            type: 'string',
            description: 'Oldest message timestamp (start of range)',
          },
          limit: {
            type: 'number',
            description: 'Number of messages to return (max 1000, default 100)',
            minimum: 1,
            maximum: 1000,
          },
          inclusive: {
            type: 'boolean',
            description: 'Include messages with latest/oldest timestamps (default: false)',
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
      'get_channel_history',
      async (args) => {
        const {
          workspace_id,
          user_id,
          channel,
          latest,
          oldest,
          limit = 100,
          inclusive = false,
        } = args;

        // Validate permissions
        await permissionManager.requirePermission(workspace_id, user_id, 'get_channel_history');

        // Validate inputs
        validateSlackChannelId(channel);
        if (latest) validateSlackTimestamp(latest);
        if (oldest) validateSlackTimestamp(oldest);

        const result = await slackClientManager.apiCall(
          workspace_id,
          'conversations.history',
          {
            channel,
            ...(latest && { latest }),
            ...(oldest && { oldest }),
            limit: Math.min(limit, 1000),
            inclusive,
          },
          user_id,
        );

        return {
          success: true,
          messages: result.messages || [],
          has_more: result.has_more || false,
          pin_count: result.pin_count || 0,
          channel_actions_ts: result.channel_actions_ts,
          channel_actions_count: result.channel_actions_count || 0,
        };
      },
      { idempotent: true },
    ),
  );

  // Tool: Search Messages
  server.registerTool(
    {
      name: 'search_messages',
      description: 'Search for messages across the workspace',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: {
            type: 'string',
            description: 'Slack workspace ID',
          },
          query: {
            type: 'string',
            description: 'Search query',
          },
          sort: {
            type: 'string',
            enum: ['timestamp', 'score'],
            description: 'Sort results by timestamp or relevance score (default: score)',
          },
          sort_dir: {
            type: 'string',
            enum: ['asc', 'desc'],
            description: 'Sort direction (default: desc)',
          },
          highlight: {
            type: 'boolean',
            description: 'Highlight search terms in results (default: false)',
          },
          count: {
            type: 'number',
            description: 'Number of results to return (max 100, default 20)',
            minimum: 1,
            maximum: 100,
          },
          page: {
            type: 'number',
            description: 'Page number for pagination (default: 1)',
            minimum: 1,
          },
          user_id: {
            type: 'string',
            description: 'User ID making the request',
          },
        },
        required: ['workspace_id', 'query', 'user_id'],
      },
    },
    wrap(
      'search_messages',
      async (args) => {
        const {
          workspace_id,
          user_id,
          query,
          sort = 'score',
          sort_dir = 'desc',
          highlight = false,
          count = 20,
          page = 1,
        } = args;

        // Validate permissions
        await permissionManager.requirePermission(workspace_id, user_id, 'search_messages');

        const result = await slackClientManager.apiCall(
          workspace_id,
          'search.messages',
          {
            query,
            sort,
            sort_dir,
            highlight,
            count: Math.min(count, 100),
            page,
          },
          user_id,
        );

        return {
          success: true,
          query,
          total: result.messages?.total || 0,
          pagination: result.messages?.pagination || {},
          matches: result.messages?.matches || [],
        };
      },
      { idempotent: true },
    ),
  );

  // Tool: Add Reaction
  server.registerTool(
    {
      name: 'add_reaction',
      description: 'Add an emoji reaction to a message',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: {
            type: 'string',
            description: 'Slack workspace ID',
          },
          channel: {
            type: 'string',
            description: 'Channel ID where the message is located',
          },
          timestamp: {
            type: 'string',
            description: 'Message timestamp to react to',
          },
          name: {
            type: 'string',
            description: 'Emoji name (without colons, e.g., "thumbsup", "smile")',
          },
          user_id: {
            type: 'string',
            description: 'User ID making the request',
          },
        },
        required: ['workspace_id', 'channel', 'timestamp', 'name', 'user_id'],
      },
    },
    wrap(
      'add_reaction',
      async (args) => {
        const { workspace_id, user_id, channel, timestamp, name } = args;

        // Validate permissions
        await permissionManager.requirePermission(workspace_id, user_id, 'add_reaction');

        // Validate inputs
        validateSlackChannelId(channel);
        validateSlackTimestamp(timestamp);

        await slackClientManager.apiCall(
          workspace_id,
          'reactions.add',
          {
            channel,
            timestamp,
            name: name.replace(/:/g, ''), // Remove colons if present
          },
          user_id,
        );

        return {
          success: true,
          channel,
          timestamp,
          reaction: name,
        };
      },
      // NOT idempotent: Slack returns `already_reacted` on replay even though
      // the desired state was achieved on the first attempt. Retrying turns a
      // successful add into a reported failure. Default (no retry) is correct.
    ),
  );

  // Tool: Remove Reaction
  server.registerTool(
    {
      name: 'remove_reaction',
      description: 'Remove an emoji reaction from a message',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: {
            type: 'string',
            description: 'Slack workspace ID',
          },
          channel: {
            type: 'string',
            description: 'Channel ID where the message is located',
          },
          timestamp: {
            type: 'string',
            description: 'Message timestamp to remove reaction from',
          },
          name: {
            type: 'string',
            description: 'Emoji name to remove (without colons)',
          },
          user_id: {
            type: 'string',
            description: 'User ID making the request',
          },
        },
        required: ['workspace_id', 'channel', 'timestamp', 'name', 'user_id'],
      },
    },
    wrap(
      'remove_reaction',
      async (args) => {
        const { workspace_id, user_id, channel, timestamp, name } = args;

        // Validate permissions
        await permissionManager.requirePermission(workspace_id, user_id, 'remove_reaction');

        // Validate inputs
        validateSlackChannelId(channel);
        validateSlackTimestamp(timestamp);

        await slackClientManager.apiCall(
          workspace_id,
          'reactions.remove',
          {
            channel,
            timestamp,
            name: name.replace(/:/g, ''), // Remove colons if present
          },
          user_id,
        );

        return {
          success: true,
          channel,
          timestamp,
          reaction_removed: name,
        };
      },
      // NOT idempotent: Slack returns `no_reaction` on replay after a
      // successful remove. Retrying flips the success into a reported error.
    ),
  );

  // Tool: Get Message Permalink
  server.registerTool(
    {
      name: 'get_message_permalink',
      description: 'Get a permanent link to a specific message',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: {
            type: 'string',
            description: 'Slack workspace ID',
          },
          channel: {
            type: 'string',
            description: 'Channel ID where the message is located',
          },
          message_ts: {
            type: 'string',
            description: 'Message timestamp',
          },
          user_id: {
            type: 'string',
            description: 'User ID making the request',
          },
        },
        required: ['workspace_id', 'channel', 'message_ts', 'user_id'],
      },
    },
    wrap(
      'get_message_permalink',
      async (args) => {
        const { workspace_id, user_id, channel, message_ts } = args;

        // Validate permissions
        await permissionManager.requirePermission(workspace_id, user_id, 'get_channel_history');

        // Validate inputs
        validateSlackChannelId(channel);
        validateSlackTimestamp(message_ts);

        const result = await slackClientManager.apiCall(
          workspace_id,
          'chat.getPermalink',
          {
            channel,
            message_ts,
          },
          user_id,
        );

        return {
          success: true,
          permalink: result.permalink,
          channel,
          message_ts,
        };
      },
      { idempotent: true },
    ),
  );

  logger.info('Message capabilities registered', {
    tools: [
      'send_message',
      'update_message',
      'delete_message',
      'get_channel_history',
      'search_messages',
      'add_reaction',
      'remove_reaction',
      'get_message_permalink',
    ],
  });
}
