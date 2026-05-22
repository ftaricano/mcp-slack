import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

import { permissionManager } from '../auth/permissions.js';
import { SlackMCPServer } from '../server.js';
import { logger } from '../utils/logger.js';
import { slackClientManager } from '../utils/slack-client.js';
import {
  validateSlackChannelId,
  validateSlackWorkspaceId,
  validateSlackFileUploadSchema,
  validateSlackFileFilterSchema,
  ValidationError,
} from '../utils/validators.js';

import { wrap } from './_wrap.js';

const DEFAULT_MAX_FILE_UPLOAD_BYTES = 10 * 1024 * 1024;

function filePathUploadsEnabled(): boolean {
  return process.env.MCP_SLACK_ALLOW_FILE_PATH_UPLOADS === 'true';
}

function maxFileUploadBytes(): number {
  const raw = process.env.MCP_SLACK_MAX_FILE_UPLOAD_BYTES;
  if (!raw) return DEFAULT_MAX_FILE_UPLOAD_BYTES;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_FILE_UPLOAD_BYTES;
}

function normalizeFileUploadArgs<
  T extends { file?: string | undefined; content?: string | undefined },
>(args: T): T {
  if (!args.file) return args;
  if (!filePathUploadsEnabled()) {
    throw new ValidationError(
      'File path uploads are disabled. Use content for text uploads or set MCP_SLACK_ALLOW_FILE_PATH_UPLOADS=true with MCP_SLACK_FILE_UPLOAD_ROOT.',
      [],
    );
  }

  const root = process.env.MCP_SLACK_FILE_UPLOAD_ROOT;
  if (!root) {
    throw new ValidationError(
      'MCP_SLACK_FILE_UPLOAD_ROOT is required when file path uploads are enabled.',
      [],
    );
  }
  if (args.file.includes('://')) {
    throw new ValidationError('Remote URLs are not supported for file uploads.', []);
  }

  let rootReal: string;
  let fileReal: string;
  try {
    rootReal = realpathSync(root);
    const requested = isAbsolute(args.file) ? resolve(args.file) : resolve(rootReal, args.file);
    fileReal = realpathSync(requested);
  } catch (err) {
    throw new ValidationError(`File upload path is not readable: ${(err as Error).message}`, []);
  }
  const rel = relative(rootReal, fileReal);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new ValidationError('File upload path must stay inside MCP_SLACK_FILE_UPLOAD_ROOT.', []);
  }

  const stat = statSync(fileReal);
  if (!stat.isFile()) {
    throw new ValidationError('File upload path must point to a regular file.', []);
  }
  const limit = maxFileUploadBytes();
  if (stat.size > limit) {
    throw new ValidationError(
      `File upload exceeds MCP_SLACK_MAX_FILE_UPLOAD_BYTES (${limit}).`,
      [],
    );
  }

  return { ...args, file: fileReal };
}

export function setupFileCapabilities(server: SlackMCPServer): void {
  // Tool: Upload File
  server.registerTool(
    {
      name: 'upload_file',
      description: 'Upload a file to Slack',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: {
            type: 'string',
            description: 'Slack workspace ID',
          },
          channels: {
            type: 'string',
            description: 'Comma-separated list of channel IDs to share the file to',
          },
          content: {
            type: 'string',
            description: 'File content (for text files)',
          },
          file: {
            type: 'string',
            description:
              'Local file path. Disabled by default; requires MCP_SLACK_ALLOW_FILE_PATH_UPLOADS=true and MCP_SLACK_FILE_UPLOAD_ROOT.',
          },
          filename: {
            type: 'string',
            description: 'Name of the file',
          },
          filetype: {
            type: 'string',
            description: 'File type (e.g., text, pdf, png)',
          },
          initial_comment: {
            type: 'string',
            description: 'Initial comment to add to the file',
          },
          thread_ts: {
            type: 'string',
            description: 'Thread timestamp to upload file to (optional)',
          },
          title: {
            type: 'string',
            description: 'Title of the file',
          },
          user_id: {
            type: 'string',
            description: 'User ID making the request',
          },
        },
        required: ['workspace_id', 'user_id'],
      },
    },
    wrap('upload_file', async (args) => {
      const { workspace_id, user_id, ...fileArgs } = args;

      // Validate permissions
      await permissionManager.requirePermission(workspace_id, user_id, 'upload_file');

      // Validate inputs
      validateSlackWorkspaceId(workspace_id);

      // Validate file upload parameters
      const validatedArgs = normalizeFileUploadArgs(
        validateSlackFileUploadSchema({
          channels: fileArgs.channels,
          content: fileArgs.content,
          file: fileArgs.file,
          filename: fileArgs.filename,
          filetype: fileArgs.filetype,
          initial_comment: fileArgs.initial_comment,
          thread_ts: fileArgs.thread_ts,
          title: fileArgs.title,
        }),
      );

      const result = await slackClientManager.apiCall(
        workspace_id,
        'files.upload',
        validatedArgs,
        user_id,
      );

      return {
        success: true,
        file: {
          id: result.file?.id,
          name: result.file?.name,
          title: result.file?.title,
          mimetype: result.file?.mimetype,
          size: result.file?.size,
          permalink: result.file?.permalink,
          url_private: result.file?.url_private,
          channels: result.file?.channels || [],
        },
      };
    }),
  );

  // Tool: Get File Info
  server.registerTool(
    {
      name: 'get_file_info',
      description: 'Get information about a file',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: {
            type: 'string',
            description: 'Slack workspace ID',
          },
          file: {
            type: 'string',
            description: 'File ID',
          },
          count: {
            type: 'number',
            description: 'Number of items to return (max 1000, default 100)',
            minimum: 1,
            maximum: 1000,
          },
          page: {
            type: 'number',
            description: 'Page number (default 1)',
            minimum: 1,
          },
          user_id: {
            type: 'string',
            description: 'User ID making the request',
          },
        },
        required: ['workspace_id', 'file', 'user_id'],
      },
    },
    wrap(
      'get_file_info',
      async (args) => {
        const { workspace_id, user_id, file, count = 100, page = 1 } = args;

        // Validate permissions
        await permissionManager.requirePermission(workspace_id, user_id, 'read_file');

        // Validate inputs
        validateSlackWorkspaceId(workspace_id);

        const result = await slackClientManager.apiCall(
          workspace_id,
          'files.info',
          {
            file,
            count: Math.min(count, 1000),
            page,
          },
          user_id,
        );

        return {
          success: true,
          file: result.file,
          comments: result.comments || [],
          paging: result.paging || {},
        };
      },
      { idempotent: true },
    ),
  );

  // Tool: List Files
  server.registerTool(
    {
      name: 'list_files',
      description: 'List files in the workspace with optional filtering',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: {
            type: 'string',
            description: 'Slack workspace ID',
          },
          user: {
            type: 'string',
            description: 'Filter by user ID (optional)',
          },
          channel: {
            type: 'string',
            description: 'Filter by channel ID (optional)',
          },
          ts_from: {
            type: 'string',
            description: 'Filter files created after this timestamp (optional)',
          },
          ts_to: {
            type: 'string',
            description: 'Filter files created before this timestamp (optional)',
          },
          types: {
            type: 'string',
            description: 'Filter by file types (e.g., images,pdfs,zips)',
          },
          count: {
            type: 'number',
            description: 'Number of files to return (max 1000, default 100)',
            minimum: 1,
            maximum: 1000,
          },
          page: {
            type: 'number',
            description: 'Page number (default 1)',
            minimum: 1,
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
      'list_files',
      async (args) => {
        const {
          workspace_id,
          user_id,
          user,
          channel,
          ts_from,
          ts_to,
          types,
          count = 100,
          page = 1,
        } = args;

        // Validate permissions
        await permissionManager.requirePermission(workspace_id, user_id, 'read_file');

        // Validate inputs
        validateSlackWorkspaceId(workspace_id);
        if (channel) validateSlackChannelId(channel);

        // Validate filter parameters
        const filterArgs = validateSlackFileFilterSchema({
          user,
          channel,
          ts_from,
          ts_to,
          types: types ? types.split(',') : undefined,
        });

        const result = await slackClientManager.apiCall(
          workspace_id,
          'files.list',
          {
            ...filterArgs,
            count: Math.min(count, 1000),
            page,
          },
          user_id,
        );

        return {
          success: true,
          files: result.files || [],
          paging: result.paging || {},
          total_count: result.files?.length || 0,
        };
      },
      { idempotent: true },
    ),
  );

  // Tool: Delete File
  server.registerTool(
    {
      name: 'delete_file',
      description: 'Delete a file',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: {
            type: 'string',
            description: 'Slack workspace ID',
          },
          file: {
            type: 'string',
            description: 'File ID to delete',
          },
          user_id: {
            type: 'string',
            description: 'User ID making the request',
          },
        },
        required: ['workspace_id', 'file', 'user_id'],
      },
    },
    wrap('delete_file', async (args) => {
      const { workspace_id, user_id, file } = args;

      // Validate permissions
      await permissionManager.requirePermission(workspace_id, user_id, 'upload_file');

      // Validate inputs
      validateSlackWorkspaceId(workspace_id);

      await slackClientManager.apiCall(workspace_id, 'files.delete', { file }, user_id);

      return {
        success: true,
        deleted_file: file,
      };
    }),
  );

  // Tool: Share File
  server.registerTool(
    {
      name: 'share_file',
      description: 'Share a file to channels',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: {
            type: 'string',
            description: 'Slack workspace ID',
          },
          file: {
            type: 'string',
            description: 'File ID to share',
          },
          channel: {
            type: 'string',
            description: 'Channel ID to share the file to',
          },
          user_id: {
            type: 'string',
            description: 'User ID making the request',
          },
        },
        required: ['workspace_id', 'file', 'channel', 'user_id'],
      },
    },
    wrap('share_file', async (args) => {
      const { workspace_id, user_id, file, channel } = args;

      // Validate permissions
      await permissionManager.requirePermission(workspace_id, user_id, 'upload_file');

      // Validate inputs
      validateSlackWorkspaceId(workspace_id);
      validateSlackChannelId(channel);

      const result = await slackClientManager.apiCall(
        workspace_id,
        'files.sharedPublicURL',
        { file },
        user_id,
      );

      return {
        success: true,
        file: result.file,
        public_url: result.file?.permalink_public,
      };
    }),
  );

  // Tool: Add File Comment
  server.registerTool(
    {
      name: 'add_file_comment',
      description: 'Add a comment to a file',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: {
            type: 'string',
            description: 'Slack workspace ID',
          },
          file: {
            type: 'string',
            description: 'File ID to comment on',
          },
          comment: {
            type: 'string',
            description: 'Comment text',
          },
          user_id: {
            type: 'string',
            description: 'User ID making the request',
          },
        },
        required: ['workspace_id', 'file', 'comment', 'user_id'],
      },
    },
    wrap('add_file_comment', async (args) => {
      const { workspace_id, user_id, file, comment } = args;

      // Validate permissions
      await permissionManager.requirePermission(workspace_id, user_id, 'send_message');

      // Validate inputs
      validateSlackWorkspaceId(workspace_id);

      const result = await slackClientManager.apiCall(
        workspace_id,
        'files.comments.add',
        {
          file,
          comment,
        },
        user_id,
      );

      return {
        success: true,
        comment: result.comment,
      };
    }),
  );

  // Tool: Get File Comments
  server.registerTool(
    {
      name: 'get_file_comments',
      description: 'Get comments for a file',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: {
            type: 'string',
            description: 'Slack workspace ID',
          },
          file: {
            type: 'string',
            description: 'File ID to get comments for',
          },
          count: {
            type: 'number',
            description: 'Number of comments to return (max 1000, default 100)',
            minimum: 1,
            maximum: 1000,
          },
          page: {
            type: 'number',
            description: 'Page number (default 1)',
            minimum: 1,
          },
          user_id: {
            type: 'string',
            description: 'User ID making the request',
          },
        },
        required: ['workspace_id', 'file', 'user_id'],
      },
    },
    wrap(
      'get_file_comments',
      async (args) => {
        const { workspace_id, user_id, file, count = 100, page = 1 } = args;

        // Validate permissions
        await permissionManager.requirePermission(workspace_id, user_id, 'read_file');

        // Validate inputs
        validateSlackWorkspaceId(workspace_id);

        // Note: This is handled by files.info with comments
        const result = await slackClientManager.apiCall(
          workspace_id,
          'files.info',
          {
            file,
            count: Math.min(count, 1000),
            page,
          },
          user_id,
        );

        return {
          success: true,
          file_id: file,
          comments: result.comments || [],
          paging: result.paging || {},
          total_comments: result.comments?.length || 0,
        };
      },
      { idempotent: true },
    ),
  );

  // Tool: Revoke File Public URL
  server.registerTool(
    {
      name: 'revoke_file_public_url',
      description: 'Revoke public URL for a file',
      inputSchema: {
        type: 'object',
        properties: {
          workspace_id: {
            type: 'string',
            description: 'Slack workspace ID',
          },
          file: {
            type: 'string',
            description: 'File ID to revoke public URL for',
          },
          user_id: {
            type: 'string',
            description: 'User ID making the request',
          },
        },
        required: ['workspace_id', 'file', 'user_id'],
      },
    },
    wrap('revoke_file_public_url', async (args) => {
      const { workspace_id, user_id, file } = args;

      // Validate permissions
      await permissionManager.requirePermission(workspace_id, user_id, 'upload_file');

      // Validate inputs
      validateSlackWorkspaceId(workspace_id);

      const result = await slackClientManager.apiCall(
        workspace_id,
        'files.revokePublicURL',
        { file },
        user_id,
      );

      return {
        success: true,
        file: result.file,
        public_url_revoked: true,
      };
    }),
  );

  logger.info('File capabilities registered', {
    tools: [
      'upload_file',
      'get_file_info',
      'list_files',
      'delete_file',
      'share_file',
      'add_file_comment',
      'get_file_comments',
      'revoke_file_public_url',
    ],
  });
}
