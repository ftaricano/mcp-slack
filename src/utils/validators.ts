import { z } from 'zod';

import { ErrorResponse } from '../types/mcp.js';

export class ValidationError extends Error {
  constructor(
    message: string,
    public readonly issues: z.ZodIssue[],
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

export function createValidator<T>(schema: z.ZodSchema<T>) {
  return (data: unknown): T => {
    const result = schema.safeParse(data);

    if (!result.success) {
      throw new ValidationError('Validation failed', result.error.issues);
    }

    return result.data;
  };
}

// Common validation schemas
export const SlackChannelIdSchema = z
  .string()
  .min(1, 'Channel ID cannot be empty')
  .regex(/^[A-Z0-9]+$/, 'Invalid channel ID format');

export const SlackChannelNameSchema = z
  .string()
  .min(1, 'Channel name cannot be empty')
  .max(21, 'Channel name cannot exceed 21 characters')
  .regex(/^[a-z0-9\-_]+$/, 'Channel name must be lowercase alphanumeric with dashes/underscores');

export const SlackUserIdSchema = z
  .string()
  .min(1, 'User ID cannot be empty')
  .regex(/^[A-Z0-9]+$/, 'Invalid user ID format');

export const SlackWorkspaceIdSchema = z
  .string()
  .min(1, 'Workspace ID cannot be empty')
  .regex(/^[A-Z0-9]+$/, 'Invalid workspace ID format');

export const SlackTimestampSchema = z
  .string()
  .regex(/^\d+\.\d{6}$/, 'Invalid Slack timestamp format');

// URI validation for MCP resources
export const SlackResourceUriSchema = z
  .string()
  .regex(/^slack:\/\/[a-zA-Z]+\/[A-Z0-9]+/, 'Invalid Slack resource URI format');

// Pagination schema
export const PaginationSchema = z.object({
  limit: z.number().min(1).max(1000).optional().default(100),
  cursor: z.string().optional(),
});

// Search schema
export const SearchSchema = z.object({
  query: z.string().min(1).max(500),
  sort: z.enum(['timestamp', 'relevance']).optional().default('relevance'),
  sort_dir: z.enum(['asc', 'desc']).optional().default('desc'),
  limit: z.number().min(1).max(100).optional().default(20),
});

// Message filtering schema
export const MessageFilterSchema = z.object({
  user: SlackUserIdSchema.optional(),
  after: SlackTimestampSchema.optional(),
  before: SlackTimestampSchema.optional(),
  inclusive: z.boolean().optional().default(true),
  has_reactions: z.boolean().optional(),
  has_attachments: z.boolean().optional(),
  is_thread: z.boolean().optional(),
});

// Message send schema
export const SlackMessageSendSchema = z.object({
  channel: z.string().min(1, 'Channel is required'),
  text: z.string().min(1, 'Message text is required').max(4000, 'Message text too long'),
  thread_ts: SlackTimestampSchema.optional(),
  reply_broadcast: z.boolean().optional().default(false),
  unfurl_links: z.boolean().optional().default(true),
  unfurl_media: z.boolean().optional().default(true),
  parse: z.enum(['full', 'none']).optional(),
  link_names: z.boolean().optional().default(true),
  attachments: z.array(z.any()).optional(),
  blocks: z.array(z.any()).optional(),
});

// Channel creation schema
export const SlackChannelCreateSchema = z.object({
  name: z.string().min(1).max(21),
  is_private: z.boolean().optional(),
});

// File upload schema
export const SlackFileUploadSchema = z
  .object({
    channels: z.string().optional(),
    content: z.string().max(1_000_000, 'File content cannot exceed 1MB').optional(),
    file: z.string().optional(),
    filename: z.string().optional(),
    filetype: z.string().optional(),
    initial_comment: z.string().max(4000, 'Initial comment too long').optional(),
    thread_ts: SlackTimestampSchema.optional(),
    title: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.content && !value.file) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['content'],
        message: 'Either content or file is required',
      });
    }
    if (value.content && value.file) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['file'],
        message: 'Provide either content or file, not both',
      });
    }
  });

// File filtering schema
export const FileFilterSchema = z.object({
  user: SlackUserIdSchema.optional(),
  channel: SlackChannelIdSchema.optional(),
  ts_from: SlackTimestampSchema.optional(),
  ts_to: SlackTimestampSchema.optional(),
  types: z.array(z.string()).optional(),
});

// User search schema
export const SlackUserSearchSchema = z.object({
  query: z.string().min(1),
  limit: z.number().min(1).max(100).optional(),
});

// Workflow configuration schema
export const WorkflowConfigSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  trigger: z.object({
    type: z.enum(['schedule', 'event', 'webhook']),
    config: z.record(z.any()),
  }),
  steps: z
    .array(
      z.object({
        type: z.string(),
        config: z.record(z.any()),
      }),
    )
    .min(1),
  enabled: z.boolean().default(true),
});

// OAuth state validation
export const OAuthStateSchema = z.object({
  state: z.string().min(32),
  code_verifier: z.string().min(43).max(128).optional(),
  redirect_uri: z.string().url(),
  scopes: z.array(z.string()),
  user_scopes: z.array(z.string()).optional(),
});

// Audit log validation
export const AuditLogEntrySchema = z.object({
  user: z.string(),
  action: z.string(),
  resource: z.string(),
  details: z.record(z.any()),
  status: z.enum(['success', 'error', 'warning']),
  ip: z.string().ip().optional(),
  userAgent: z.string().optional(),
});

// Create validator functions
export const validateSlackChannelId = createValidator(SlackChannelIdSchema);
export const validateSlackChannelName = createValidator(SlackChannelNameSchema);
export const validateSlackChannelCreateSchema = createValidator(SlackChannelCreateSchema);
export const validateSlackUserId = createValidator(SlackUserIdSchema);
export const validateSlackWorkspaceId = createValidator(SlackWorkspaceIdSchema);
export const validateSlackTimestamp = createValidator(SlackTimestampSchema);
export const validateSlackResourceUri = createValidator(SlackResourceUriSchema);
export const validatePagination = createValidator(PaginationSchema);
export const validateSearch = createValidator(SearchSchema);
export const validateMessageFilter = createValidator(MessageFilterSchema);
export const validateSlackMessageSendSchema = createValidator(SlackMessageSendSchema);
export const validateSlackFileUploadSchema = createValidator(SlackFileUploadSchema);
export const validateSlackFileFilterSchema = createValidator(FileFilterSchema);
export const validateSlackUserSearchSchema = createValidator(SlackUserSearchSchema);
export const validateWorkflowConfig = createValidator(WorkflowConfigSchema);
export const validateOAuthState = createValidator(OAuthStateSchema);
export const validateAuditLogEntry = createValidator(AuditLogEntrySchema);

// Sanitization helpers
export function sanitizeHtml(input: string): string {
  return input
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;');
}

export function sanitizeSlackMessage(message: string): string {
  // Strip only broadcast mentions (<!here>, <!channel>, <!everyone>, <!subteam^…>)
  // — they spam the whole channel/workspace and are an easy footgun.
  // Individual user (<@U…>) and channel (<#C…>) mentions are first-class Slack
  // syntax and must pass through intact, otherwise notifications never fire.
  return message.replace(/<![^>]*>/g, '').trim();
}

// Error response helper
export function createErrorResponse(code: number, message: string, data?: any): ErrorResponse {
  return {
    code,
    message,
    ...(data && { data }),
  };
}

// Validation error to MCP error
export function validationErrorToMcpError(error: ValidationError): ErrorResponse {
  return createErrorResponse(
    -32602, // Invalid params
    'Validation failed: ' + error.issues.map((i) => i.message).join(', '),
    { issues: error.issues },
  );
}
