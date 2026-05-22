import { permissionManager } from '../auth/permissions.js';
import { SlackMCPServer } from '../server.js';
import { logger } from '../utils/logger.js';
import { slackClientManager } from '../utils/slack-client.js';
import { validateSlackUserId, validateSlackWorkspaceId } from '../utils/validators.js';

import { wrap } from './_wrap.js';

export function setupUserCapabilities(server: SlackMCPServer): void {
  // Tool: List Users
  server.registerTool(
    {
      name: 'list_users',
      description: 'List all users in the workspace',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: {
            type: 'string',
            description: 'Slack workspace ID',
          },
          limit: {
            type: 'number',
            description: 'Number of users to return (max 1000, default 100)',
            minimum: 1,
            maximum: 1000,
          },
          cursor: {
            type: 'string',
            description: 'Pagination cursor',
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
        required: ['workspace_id', 'user_id'],
      },
    },
    wrap(
      'list_users',
      async (args) => {
        const { workspace_id, user_id, limit = 100, cursor, include_locale = false } = args;

        // Validate permissions
        await permissionManager.requirePermission(workspace_id, user_id, 'list_users');

        // Validate inputs
        validateSlackWorkspaceId(workspace_id);

        const result = await slackClientManager.apiCall(
          workspace_id,
          'users.list',
          {
            limit: Math.min(limit, 1000),
            ...(cursor && { cursor }),
            include_locale,
          },
          user_id,
        );

        return {
          success: true,
          members: result.members || [],
          response_metadata: result.response_metadata || {},
          cache_ts: result.cache_ts,
          total_count: result.members?.length || 0,
        };
      },
      { idempotent: true },
    ),
  );

  // Tool: Get User Info
  server.registerTool(
    {
      name: 'get_user_info',
      description: 'Get detailed information about a specific user',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: {
            type: 'string',
            description: 'Slack workspace ID',
          },
          user: {
            type: 'string',
            description: 'User ID to get information for',
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
        required: ['workspace_id', 'user', 'user_id'],
      },
    },
    wrap(
      'get_user_info',
      async (args) => {
        const { workspace_id, user_id, user, include_locale = false } = args;

        // Validate permissions
        await permissionManager.requirePermission(workspace_id, user_id, 'get_user_info');

        // Validate inputs
        validateSlackWorkspaceId(workspace_id);
        validateSlackUserId(user);

        const result = await slackClientManager.apiCall(
          workspace_id,
          'users.info',
          {
            user,
            include_locale,
          },
          user_id,
        );

        return {
          success: true,
          user: result.user,
        };
      },
      { idempotent: true },
    ),
  );

  // Tool: Get User Presence
  server.registerTool(
    {
      name: 'get_user_presence',
      description: 'Get presence information for a user',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: {
            type: 'string',
            description: 'Slack workspace ID',
          },
          user: {
            type: 'string',
            description: 'User ID to get presence for',
          },
          user_id: {
            type: 'string',
            description: 'User ID making the request',
          },
        },
        required: ['workspace_id', 'user', 'user_id'],
      },
    },
    wrap(
      'get_user_presence',
      async (args) => {
        const { workspace_id, user_id, user } = args;

        // Validate permissions
        await permissionManager.requirePermission(workspace_id, user_id, 'get_user_info');

        // Validate inputs
        validateSlackWorkspaceId(workspace_id);
        validateSlackUserId(user);

        const result = await slackClientManager.apiCall(
          workspace_id,
          'users.getPresence',
          { user },
          user_id,
        );

        return {
          success: true,
          user,
          presence: result.presence,
          online: result.online,
          auto_away: result.auto_away,
          manual_away: result.manual_away,
          connection_count: result.connection_count,
          last_activity: result.last_activity,
        };
      },
      { idempotent: true },
    ),
  );

  // Tool: Set User Status
  server.registerTool(
    {
      name: 'set_user_status',
      description: 'Set custom status for the authenticated user',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: {
            type: 'string',
            description: 'Slack workspace ID',
          },
          status_text: {
            type: 'string',
            description: 'Custom status text (max 100 characters)',
            maxLength: 100,
          },
          status_emoji: {
            type: 'string',
            description: 'Status emoji (e.g., :coffee:)',
          },
          status_expiration: {
            type: 'number',
            description: 'Unix timestamp for when status expires (0 for no expiration)',
          },
          user_id: {
            type: 'string',
            description: 'User ID making the request',
          },
        },
        required: ['workspace_id', 'user_id'],
      },
    },
    wrap('set_user_status', async (args) => {
      const {
        workspace_id,
        user_id,
        status_text = '',
        status_emoji = '',
        status_expiration = 0,
      } = args;

      // Validate permissions
      await permissionManager.requirePermission(workspace_id, user_id, 'get_user_info');

      // Validate inputs
      validateSlackWorkspaceId(workspace_id);

      const profile = {
        status_text: status_text.substring(0, 100),
        status_emoji: status_emoji.replace(/:/g, ''), // Remove colons if present
        ...(status_expiration > 0 && { status_expiration }),
      };

      const result = await slackClientManager.apiCall(
        workspace_id,
        'users.profile.set',
        { profile },
        user_id,
      );

      return {
        success: true,
        profile: result.profile,
      };
    }),
  );

  // Tool: Get User Profile
  server.registerTool(
    {
      name: 'get_user_profile',
      description: 'Get profile information for a user',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: {
            type: 'string',
            description: 'Slack workspace ID',
          },
          user: {
            type: 'string',
            description: 'User ID to get profile for (optional, defaults to authenticated user)',
          },
          include_labels: {
            type: 'boolean',
            description: 'Include profile field labels (default: false)',
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
      'get_user_profile',
      async (args) => {
        const { workspace_id, user_id, user, include_labels = false } = args;

        // Validate permissions
        await permissionManager.requirePermission(workspace_id, user_id, 'get_user_info');

        // Validate inputs
        validateSlackWorkspaceId(workspace_id);
        if (user) validateSlackUserId(user);

        const result = await slackClientManager.apiCall(
          workspace_id,
          'users.profile.get',
          {
            ...(user && { user }),
            include_labels,
          },
          user_id,
        );

        return {
          success: true,
          profile: result.profile,
        };
      },
      { idempotent: true },
    ),
  );

  // Tool: Set User Presence
  server.registerTool(
    {
      name: 'set_user_presence',
      description: 'Set presence for the authenticated user',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: {
            type: 'string',
            description: 'Slack workspace ID',
          },
          presence: {
            type: 'string',
            enum: ['auto', 'away'],
            description: 'Presence status (auto or away)',
          },
          user_id: {
            type: 'string',
            description: 'User ID making the request',
          },
        },
        required: ['workspace_id', 'presence', 'user_id'],
      },
    },
    wrap('set_user_presence', async (args) => {
      const { workspace_id, user_id, presence } = args;

      // Validate permissions
      await permissionManager.requirePermission(workspace_id, user_id, 'get_user_info');

      // Validate inputs
      validateSlackWorkspaceId(workspace_id);

      await slackClientManager.apiCall(workspace_id, 'users.setPresence', { presence }, user_id);

      return {
        success: true,
        presence,
      };
    }),
  );

  // Tool: Lookup User by Email
  server.registerTool(
    {
      name: 'lookup_user_by_email',
      description: 'Find a user by their email address',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: {
            type: 'string',
            description: 'Slack workspace ID',
          },
          email: {
            type: 'string',
            format: 'email',
            description: 'Email address to search for',
          },
          user_id: {
            type: 'string',
            description: 'User ID making the request',
          },
        },
        required: ['workspace_id', 'email', 'user_id'],
      },
    },
    wrap(
      'lookup_user_by_email',
      async (args) => {
        const { workspace_id, user_id, email } = args;

        // Validate permissions
        await permissionManager.requirePermission(workspace_id, user_id, 'list_users');

        // Validate inputs
        validateSlackWorkspaceId(workspace_id);

        const result = await slackClientManager.apiCall(
          workspace_id,
          'users.lookupByEmail',
          { email },
          user_id,
        );

        return {
          success: true,
          user: result.user,
        };
      },
      { idempotent: true },
    ),
  );

  // Tool: Get User Groups (User Groups the user belongs to)
  server.registerTool(
    {
      name: 'get_user_groups',
      description: 'Get list of user groups in the workspace',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: {
            type: 'string',
            description: 'Slack workspace ID',
          },
          include_disabled: {
            type: 'boolean',
            description: 'Include disabled user groups (default: false)',
          },
          include_count: {
            type: 'boolean',
            description: 'Include user count for each group (default: false)',
          },
          include_users: {
            type: 'boolean',
            description: 'Include list of users in each group (default: false)',
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
      'get_user_groups',
      async (args) => {
        const {
          workspace_id,
          user_id,
          include_disabled = false,
          include_count = false,
          include_users = false,
        } = args;

        // Validate permissions
        await permissionManager.requirePermission(workspace_id, user_id, 'list_users');

        // Validate inputs
        validateSlackWorkspaceId(workspace_id);

        const result = await slackClientManager.apiCall(
          workspace_id,
          'usergroups.list',
          {
            include_disabled,
            include_count,
            include_users,
          },
          user_id,
        );

        return {
          success: true,
          usergroups: result.usergroups || [],
        };
      },
      { idempotent: true },
    ),
  );

  // Tool: Get Conversations for User (DMs, Group DMs)
  server.registerTool(
    {
      name: 'get_user_conversations',
      description: 'Get conversations (channels, DMs) that a user is a member of',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: {
            type: 'string',
            description: 'Slack workspace ID',
          },
          types: {
            type: 'string',
            description: 'Conversation types to include (public_channel,private_channel,mpim,im)',
            default: 'public_channel,private_channel,mpim,im',
          },
          exclude_archived: {
            type: 'boolean',
            description: 'Exclude archived conversations (default: false)',
          },
          limit: {
            type: 'number',
            description: 'Number of conversations to return (max 1000, default 100)',
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
      'get_user_conversations',
      async (args) => {
        const {
          workspace_id,
          user_id,
          types = 'public_channel,private_channel,mpim,im',
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
          'users.conversations',
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

  // Tool: Get Team Info
  server.registerTool(
    {
      name: 'get_team_info',
      description: 'Get information about the Slack workspace/team',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: {
            type: 'string',
            description: 'Slack workspace ID',
          },
          team: {
            type: 'string',
            description: 'Team ID (optional, defaults to current team)',
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
      'get_team_info',
      async (args) => {
        const { workspace_id, user_id, team } = args;

        // Validate permissions
        await permissionManager.requirePermission(workspace_id, user_id, 'get_user_info');

        // Validate inputs
        validateSlackWorkspaceId(workspace_id);

        const result = await slackClientManager.apiCall(
          workspace_id,
          'team.info',
          {
            ...(team && { team }),
          },
          user_id,
        );

        return {
          success: true,
          team: result.team,
        };
      },
      { idempotent: true },
    ),
  );

  logger.info('User capabilities registered', {
    tools: [
      'list_users',
      'get_user_info',
      'get_user_presence',
      'set_user_status',
      'get_user_profile',
      'set_user_presence',
      'lookup_user_by_email',
      'get_user_groups',
      'get_user_conversations',
      'get_team_info',
    ],
  });
}
