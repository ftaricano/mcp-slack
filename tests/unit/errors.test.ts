import {
  SlackMcpError,
  ValidationError,
  AuthError,
  NotFoundError,
  RateLimitError,
  SlackApiError,
  mapSlackError,
} from '../../src/errors/index.js';

describe('error hierarchy', () => {
  it('SlackMcpError sets code SLACK_MCP and name', () => {
    const e = new SlackMcpError('boom');
    expect(e.code).toBe('SLACK_MCP');
    expect(e.name).toBe('SlackMcpError');
    expect(e.message).toBe('boom');
    expect(e).toBeInstanceOf(Error);
  });

  it('ValidationError sets code VALIDATION and name', () => {
    const e = new ValidationError('bad');
    expect(e.code).toBe('VALIDATION');
    expect(e.name).toBe('ValidationError');
    expect(e).toBeInstanceOf(SlackMcpError);
  });

  it('AuthError sets code AUTH and name', () => {
    const e = new AuthError('nope');
    expect(e.code).toBe('AUTH');
    expect(e.name).toBe('AuthError');
    expect(e).toBeInstanceOf(SlackMcpError);
  });

  it('NotFoundError sets code NOT_FOUND and name', () => {
    const e = new NotFoundError('missing');
    expect(e.code).toBe('NOT_FOUND');
    expect(e.name).toBe('NotFoundError');
    expect(e).toBeInstanceOf(SlackMcpError);
  });

  it('SlackApiError sets code SLACK_API and name', () => {
    const e = new SlackApiError('api');
    expect(e.code).toBe('SLACK_API');
    expect(e.name).toBe('SlackApiError');
    expect(e).toBeInstanceOf(SlackMcpError);
  });

  it('RateLimitError sets code RATE_LIMIT, name and retryAfter', () => {
    const e = new RateLimitError('slow', 10);
    expect(e.code).toBe('RATE_LIMIT');
    expect(e.name).toBe('RateLimitError');
    expect(e.retryAfter).toBe(10);
    expect(e).toBeInstanceOf(SlackMcpError);
  });

  it('toJSON has name + code + message for base errors', () => {
    const e = new ValidationError('x');
    expect(e.toJSON()).toEqual({
      name: 'ValidationError',
      code: 'VALIDATION',
      message: 'x',
    });
  });

  it('RateLimitError.toJSON includes retryAfter', () => {
    const e = new RateLimitError('rl', 5);
    expect(e.toJSON()).toEqual({
      name: 'RateLimitError',
      code: 'RATE_LIMIT',
      message: 'rl',
      retryAfter: 5,
    });
  });

  it('preserves cause when provided', () => {
    const orig = new Error('orig');
    const e = new SlackMcpError('wrap', { cause: orig });
    expect(e.cause).toBe(orig);
  });

  it('has a stack trace', () => {
    const e = new SlackMcpError('trace');
    expect(typeof e.stack).toBe('string');
  });
});

describe('mapSlackError', () => {
  it('passes through existing SlackMcpError', () => {
    const e = new ValidationError('x');
    expect(mapSlackError(e)).toBe(e);
  });

  it('maps ratelimited with numeric retry-after', () => {
    const r = mapSlackError({
      data: { error: 'ratelimited' },
      headers: { 'retry-after': '7' },
    });
    expect(r).toBeInstanceOf(RateLimitError);
    expect((r as RateLimitError).retryAfter).toBe(7);
    expect(r.code).toBe('RATE_LIMIT');
  });

  it('defaults retryAfter to 1 when header missing', () => {
    const r = mapSlackError({ data: { error: 'ratelimited' } });
    expect(r).toBeInstanceOf(RateLimitError);
    expect((r as RateLimitError).retryAfter).toBe(1);
  });

  it('defaults retryAfter to 1 when header garbage', () => {
    const r = mapSlackError({
      data: { error: 'ratelimited' },
      headers: { 'retry-after': 'not-a-number' },
    });
    expect(r).toBeInstanceOf(RateLimitError);
    expect((r as RateLimitError).retryAfter).toBe(1);
  });

  it('defaults retryAfter to 1 when header is 0 or negative', () => {
    const r = mapSlackError({
      data: { error: 'ratelimited' },
      headers: { 'retry-after': '0' },
    });
    expect((r as RateLimitError).retryAfter).toBe(1);
  });

  it('handles legacy code: "rate_limited" shape (no data.error)', () => {
    const r = mapSlackError({ code: 'rate_limited', headers: { 'retry-after': '3' } });
    expect(r).toBeInstanceOf(RateLimitError);
    expect((r as RateLimitError).retryAfter).toBe(3);
  });

  it.each([
    'invalid_auth',
    'token_revoked',
    'token_expired',
    'not_authed',
    'account_inactive',
    'no_permission',
    'missing_scope',
  ])('maps %s -> AuthError', (code) => {
    const r = mapSlackError({ data: { error: code } });
    expect(r).toBeInstanceOf(AuthError);
    expect(r.code).toBe('AUTH');
    expect(r.message).toContain(code);
  });

  it.each(['channel_not_found', 'user_not_found', 'file_not_found', 'message_not_found'])(
    'maps %s -> NotFoundError',
    (code) => {
      const r = mapSlackError({ data: { error: code } });
      expect(r).toBeInstanceOf(NotFoundError);
      expect(r.code).toBe('NOT_FOUND');
      expect(r.message).toContain(code);
    },
  );

  it('maps any other slack error -> SlackApiError', () => {
    const r = mapSlackError({ data: { error: 'something_weird' } });
    expect(r).toBeInstanceOf(SlackApiError);
    expect(r.code).toBe('SLACK_API');
    expect(r.message).toContain('something_weird');
  });

  it('maps a plain Error -> SlackMcpError preserving message + cause', () => {
    const orig = new Error('boom');
    const r = mapSlackError(orig);
    expect(r).toBeInstanceOf(SlackMcpError);
    expect(r.message).toBe('boom');
    expect(r.cause).toBe(orig);
  });

  it.each([['string-error'], [null], [undefined], [42]])(
    'maps %p -> SlackMcpError unknown',
    (v) => {
      const r = mapSlackError(v);
      expect(r).toBeInstanceOf(SlackMcpError);
      expect(r.code).toBe('SLACK_MCP');
    },
  );

  it('preserves the original error as cause when wrapping', () => {
    const raw = { data: { error: 'channel_not_found' } };
    const r = mapSlackError(raw);
    expect(r.cause).toBe(raw);
  });
});
