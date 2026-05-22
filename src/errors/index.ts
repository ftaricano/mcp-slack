export class SlackMcpError extends Error {
  readonly code: string = 'SLACK_MCP';
  readonly cause?: unknown;
  constructor(message: string, opts: { cause?: unknown } = {}) {
    super(message);
    this.name = this.constructor.name;
    if (opts.cause !== undefined) this.cause = opts.cause;
    // Preserve V8 stack
    if (typeof (Error as any).captureStackTrace === 'function') {
      (Error as any).captureStackTrace(this, this.constructor);
    }
  }
  toJSON() {
    return { name: this.name, code: this.code, message: this.message };
  }
}

export class ValidationError extends SlackMcpError {
  override readonly code = 'VALIDATION';
}

export class AuthError extends SlackMcpError {
  override readonly code = 'AUTH';
}

export class NotFoundError extends SlackMcpError {
  override readonly code = 'NOT_FOUND';
}

export class RateLimitError extends SlackMcpError {
  override readonly code = 'RATE_LIMIT';
  constructor(
    message: string,
    public readonly retryAfter: number,
    opts: { cause?: unknown } = {},
  ) {
    super(message, opts);
  }
  override toJSON() {
    return { ...super.toJSON(), retryAfter: this.retryAfter };
  }
}

export class SlackApiError extends SlackMcpError {
  override readonly code = 'SLACK_API';
}

interface SlackLikeError {
  data?: { error?: string };
  headers?: Record<string, string | undefined>;
  message?: string;
  code?: string;
}

const NOT_FOUND_ERRORS = new Set([
  'channel_not_found',
  'user_not_found',
  'file_not_found',
  'message_not_found',
]);

const AUTH_ERRORS = new Set([
  'invalid_auth',
  'token_revoked',
  'token_expired',
  'not_authed',
  'account_inactive',
  'no_permission',
  'missing_scope',
]);

export function mapSlackError(err: unknown): SlackMcpError {
  if (err instanceof SlackMcpError) return err;

  const e = (typeof err === 'object' && err !== null ? err : {}) as SlackLikeError;
  const slackCode = e.data?.error;

  if (slackCode === 'ratelimited' || e.code === 'rate_limited') {
    const retryAfter = parseRetryAfter(e.headers?.['retry-after']);
    return new RateLimitError(`slack rate limited (retry in ${retryAfter}s)`, retryAfter, {
      cause: err,
    });
  }

  if (slackCode && AUTH_ERRORS.has(slackCode)) {
    return new AuthError(`slack auth error: ${slackCode}`, { cause: err });
  }

  if (slackCode && NOT_FOUND_ERRORS.has(slackCode)) {
    return new NotFoundError(`slack: ${slackCode}`, { cause: err });
  }

  if (slackCode) {
    return new SlackApiError(`slack: ${slackCode}`, { cause: err });
  }

  if (err instanceof Error) {
    return new SlackMcpError(err.message, { cause: err });
  }

  return new SlackMcpError('unknown error', { cause: err });
}

function parseRetryAfter(value: string | number | undefined): number {
  if (value === undefined) return 1;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return n;
}
