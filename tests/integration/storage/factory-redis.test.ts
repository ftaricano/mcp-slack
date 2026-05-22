import { jest } from '@jest/globals';

// Fake Redis ctor — captures (url, options) so the test can assert the
// fast-fail config the factory passes through. Emits 'ready' on next tick
// so the factory's `await ready` resolves synchronously in tests.
function makeFakeClient(): any {
  const handlers: Record<string, Array<(...a: any[]) => void>> = {};
  const client: any = {
    once(event: string, fn: (...a: any[]) => void) {
      (handlers[event] ||= []).push(fn);
      return client;
    },
    on(event: string, fn: (...a: any[]) => void) {
      (handlers[event] ||= []).push(fn);
      return client;
    },
    off(event: string, fn: (...a: any[]) => void) {
      handlers[event] = (handlers[event] || []).filter((h) => h !== fn);
      return client;
    },
    emit(event: string, ...args: any[]) {
      (handlers[event] || []).slice().forEach((fn) => fn(...args));
    },
    ping: async () => undefined,
    set: async () => undefined,
    del: async () => undefined,
    scan: async () => ['0', []],
    get: async () => null,
    mget: async () => [],
    quit: async () => 'OK',
  };
  setImmediate(() => client.emit('ready'));
  return client;
}

const ctor = jest.fn().mockImplementation(() => makeFakeClient());

jest.unstable_mockModule('ioredis', () => ({
  default: ctor,
}));

const { createDefaultTokenStore } = await import('../../../src/storage/factory.js');

describe('createDefaultTokenStore (Redis branch)', () => {
  beforeEach(() => {
    ctor.mockClear();
  });

  it('configures ioredis for fast-fail (no offline queue, 2s connect, no retry)', async () => {
    await createDefaultTokenStore({ env: { REDIS_URL: 'redis://localhost:6379' } });
    expect(ctor).toHaveBeenCalledTimes(1);
    const [url, opts] = ctor.mock.calls[0]!;
    expect(url).toBe('redis://localhost:6379');
    expect(opts).toEqual(
      expect.objectContaining({
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        connectTimeout: 2000,
        lazyConnect: false,
      }),
    );
    // retryStrategy must be a function that returns null (no reconnect).
    expect(typeof (opts as { retryStrategy?: unknown }).retryStrategy).toBe('function');
    expect((opts as { retryStrategy: () => unknown }).retryStrategy()).toBeNull();
  });
});
