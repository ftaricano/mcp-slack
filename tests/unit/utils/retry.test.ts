import { jest } from '@jest/globals';

import { AuthError, NotFoundError, ValidationError } from '../../../src/errors/index.js';
import { withRetry } from '../../../src/utils/retry.js';

describe('withRetry', () => {
  it('returns value on first success without retry', async () => {
    const fn = jest.fn(async () => 'ok');
    await expect(withRetry(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries transient errors and eventually succeeds', async () => {
    let n = 0;
    const fn = jest.fn(async () => {
      if (++n < 3) throw new Error('transient boom');
      return 'ok';
    });
    await expect(withRetry(fn, { retries: 5, minTimeoutMs: 1, maxTimeoutMs: 5 })).resolves.toBe(
      'ok',
    );
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('aborts on ValidationError without retrying', async () => {
    const fn = jest.fn(async () => {
      throw new ValidationError('bad input');
    });
    await expect(withRetry(fn, { retries: 5, minTimeoutMs: 1 })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('aborts on AuthError without retrying', async () => {
    const fn = jest.fn(async () => {
      throw new AuthError('invalid_auth');
    });
    await expect(withRetry(fn, { retries: 5, minTimeoutMs: 1 })).rejects.toBeInstanceOf(AuthError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('honors RateLimitError.retryAfter and retries', async () => {
    let n = 0;
    const fn = jest.fn(async () => {
      if (++n < 2) {
        // Simulate Slack ratelimited error shape — gets mapped to RateLimitError.
        const e: any = new Error('rl');
        e.data = { error: 'ratelimited' };
        e.headers = { 'retry-after': '0' };
        throw e;
      }
      return 'ok';
    });
    const start = Date.now();
    await expect(withRetry(fn, { retries: 3, minTimeoutMs: 1, maxTimeoutMs: 5 })).resolves.toBe(
      'ok',
    );
    expect(fn).toHaveBeenCalledTimes(2);
    expect(Date.now() - start).toBeLessThan(2000); // sanity bound
  });

  it('retries NotFoundError (transient — entity may exist later)', async () => {
    let n = 0;
    const fn = jest.fn(async () => {
      if (++n < 2) throw new NotFoundError('channel_not_found');
      return 'ok';
    });
    await expect(withRetry(fn, { retries: 3, minTimeoutMs: 1 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('eventually rethrows after max retries', async () => {
    const fn = jest.fn(async () => {
      throw new Error('always fails');
    });
    await expect(withRetry(fn, { retries: 2, minTimeoutMs: 1, maxTimeoutMs: 5 })).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(3); // 1 + 2 retries
  });

  it('aborts on Zod ValidationError — preserves the original instance through retry abort', async () => {
    const { ValidationError: ZodValidationError } =
      await import('../../../src/utils/validators.js');
    const original = new ZodValidationError('zod failed', []);
    const fn = jest.fn(async () => {
      throw original;
    });
    await expect(withRetry(fn, { retries: 3, minTimeoutMs: 1 })).rejects.toBe(original);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
