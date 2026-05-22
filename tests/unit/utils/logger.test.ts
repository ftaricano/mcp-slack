import { redactForLogging } from '../../../src/utils/logger.js';

describe('redactForLogging', () => {
  it('redacts tokens and content-like fields recursively', () => {
    const redacted = redactForLogging({
      token: 'bot-token-real-looking-token',
      nested: {
        text: 'sensitive message body',
        url: '/oauth/callback?code=abc123&state=def456',
      },
    }) as any;

    expect(redacted.token).toBe('[REDACTED]');
    expect(redacted.nested.text).toMatch(/^\[REDACTED length=/);
    expect(redacted.nested.url).toBe('/oauth/callback?code=<REDACTED>&state=<REDACTED>');
  });

  it('redacts OAuth callback state and verifier fields by key', () => {
    const redacted = redactForLogging({
      state: 'state-value',
      stateSecret: 'state-secret-value',
      code_verifier: 'verifier-value',
      oauth_code: 'code-value',
      error_code: 'invalid_auth',
    }) as any;

    expect(redacted.state).toBe('[REDACTED]');
    expect(redacted.stateSecret).toBe('[REDACTED]');
    expect(redacted.code_verifier).toBe('[REDACTED]');
    expect(redacted.oauth_code).toBe('[REDACTED]');
    expect(redacted.error_code).toBe('invalid_auth');
  });

  it('redacts Slack token-shaped strings without keeping token fixtures in source', () => {
    const token = ['xoxb', 'runtime-token'].join('-');
    const redacted = redactForLogging({ message: `received ${token}` }) as any;

    expect(redacted.message).toBe('received xox<REDACTED>');
  });
});
