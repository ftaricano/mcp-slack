import { jest } from '@jest/globals';

import { RedisTokenStore } from '../../../src/storage/redis-token-store.js';
import type { InstalledToken } from '../../../src/storage/token-store.js';

const mkToken = (teamId: string): InstalledToken => ({
  teamId,
  userId: 'U1',
  botToken: 'xoxb',
  scopes: ['chat:write'],
  installedAt: 100,
});

function makeRedisStub() {
  const map = new Map<string, string>();
  return {
    get: jest.fn(async (k: string) => map.get(k) ?? null),
    set: jest.fn(async (k: string, v: string) => {
      map.set(k, v);
      return 'OK' as const;
    }),
    del: jest.fn(async (k: string) => {
      const had = map.has(k);
      map.delete(k);
      return had ? 1 : 0;
    }),
    keys: jest.fn(async (pattern: string) => {
      const prefix = pattern.replace(/\*$/, '');
      return [...map.keys()].filter((k) => k.startsWith(prefix));
    }),
    scan: jest.fn(
      async (
        cursor: string | number,
        _match: 'MATCH',
        pattern: string,
        _count: 'COUNT',
        _n: number,
      ) => {
        // Single-round stub: return all matches and cursor='0' to terminate the loop.
        const cur = String(cursor);
        if (cur !== '0') return [cur === '1' ? '0' : cur, []] as [string, string[]];
        const prefix = pattern.replace(/\*$/, '');
        const matches = [...map.keys()].filter((k) => k.startsWith(prefix));
        return ['0', matches] as [string, string[]];
      },
    ),
    mget: jest.fn(async (...args: any[]) => {
      const keys: string[] = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
      return keys.map((k) => map.get(k) ?? null);
    }),
    _map: map,
  };
}

describe('RedisTokenStore', () => {
  let redis: ReturnType<typeof makeRedisStub>;
  let store: RedisTokenStore;

  beforeEach(() => {
    redis = makeRedisStub();
    store = new RedisTokenStore(redis as any);
  });

  it('uses the configured prefix', async () => {
    await store.set(mkToken('T1'));
    expect([...redis._map.keys()][0]).toMatch(/^mcp-slack:token:T1$/);
  });

  it('honors a custom prefix', async () => {
    const custom = new RedisTokenStore(redis as any, 'tenant-x:');
    await custom.set(mkToken('T1'));
    expect([...redis._map.keys()][0]).toBe('tenant-x:T1');
  });

  it('get returns null when key absent', async () => {
    expect(await store.get('T-missing')).toBeNull();
  });

  it('set + get round-trips', async () => {
    await store.set(mkToken('T1'));
    expect(await store.get('T1')).toMatchObject({ teamId: 'T1', botToken: 'xoxb' });
  });

  it('list returns [] when no keys', async () => {
    expect(await store.list()).toEqual([]);
  });

  it('list returns all stored tokens', async () => {
    await store.set(mkToken('T1'));
    await store.set(mkToken('T2'));
    const list = await store.list();
    expect(list.map((t) => t.teamId).sort()).toEqual(['T1', 'T2']);
  });

  it('delete removes a token', async () => {
    await store.set(mkToken('T1'));
    await store.delete('T1');
    expect(await store.get('T1')).toBeNull();
  });

  it('handles mget returning null entries', async () => {
    redis.mget.mockResolvedValueOnce([null, JSON.stringify(mkToken('T2'))] as never);
    (redis as any).scan = jest.fn(async () => [
      '0',
      ['mcp-slack:token:T1', 'mcp-slack:token:T2'],
    ]) as any;
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.teamId).toBe('T2');
  });

  it('list() iterates SCAN cursor across multiple rounds without using KEYS', async () => {
    // Force two SCAN rounds: first returns cursor='1' + [T1], second returns cursor='0' + [T2].
    (redis as any).scan = jest
      .fn()
      .mockResolvedValueOnce(['1', ['mcp-slack:token:T1']] as never)
      .mockResolvedValueOnce(['0', ['mcp-slack:token:T2']] as never) as any;
    redis.mget = jest.fn(async () => [
      JSON.stringify(mkToken('T1')),
      JSON.stringify(mkToken('T2')),
    ]) as any;
    // KEYS must not be called — it's the production-unsafe primitive we just removed.
    redis.keys = jest.fn(async () => {
      throw new Error('KEYS should not be called');
    }) as any;

    const list = await store.list();
    expect(list.map((t) => t.teamId).sort()).toEqual(['T1', 'T2']);
    expect((redis as any).scan).toHaveBeenCalledTimes(2);
    expect(redis.keys).not.toHaveBeenCalled();
  });

  it('list() dedupes keys returned by SCAN across rounds (rehash safety)', async () => {
    (redis as any).scan = jest
      .fn()
      .mockResolvedValueOnce(['1', ['mcp-slack:token:T1', 'mcp-slack:token:T2']] as never)
      .mockResolvedValueOnce(['0', ['mcp-slack:token:T2', 'mcp-slack:token:T3']] as never) as any;
    // mget will be called once with the deduped key set; capture order-insensitive.
    const mget = jest.fn(async (...args: any[]) => {
      const keys: string[] = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
      return keys.map((k) => JSON.stringify(mkToken(k.replace('mcp-slack:token:', ''))));
    }) as any;
    redis.mget = mget;

    const list = await store.list();
    // Three distinct teams (T1, T2, T3) — T2 must not appear twice.
    expect(list.map((t) => t.teamId).sort()).toEqual(['T1', 'T2', 'T3']);
    expect(list).toHaveLength(3);
    // mget called with exactly 3 unique keys
    const lastCall = mget.mock.calls.at(-1)!;
    const callKeys: string[] =
      lastCall.length === 1 && Array.isArray(lastCall[0]) ? lastCall[0] : lastCall;
    expect(new Set(callKeys).size).toBe(3);
  });

  it('close() calls redis.quit() so CLI one-shots can exit cleanly', async () => {
    (redis as any).quit = jest.fn(async () => 'OK' as const);
    await store.close!();
    expect((redis as any).quit).toHaveBeenCalled();
  });

  it('ping() exercises SET + DEL + SCAN so ACL gaps surface as degraded', async () => {
    redis.set = jest.fn(async () => 'OK' as const) as any;
    redis.del = jest.fn(async () => 1) as any;
    (redis as any).scan = jest.fn(async () => ['0', []]) as any;
    await store.ping!();
    expect(redis.set).toHaveBeenCalledWith(
      expect.stringMatching(/^mcp-slack:token:.*__healthcheck__$/),
      expect.any(String),
      'EX',
      expect.any(Number),
    );
    expect(redis.del).toHaveBeenCalledWith(
      expect.stringMatching(/^mcp-slack:token:.*__healthcheck__$/),
    );
    expect((redis as any).scan).toHaveBeenCalledWith(
      0,
      'MATCH',
      expect.stringMatching(/^mcp-slack:token:\*$/),
      'COUNT',
      1,
    );
  });

  it('ping() rejects when SET is denied (write-ACL gap)', async () => {
    redis.set = jest.fn(async () => {
      throw new Error('NOPERM');
    }) as any;
    redis.del = jest.fn(async () => 1) as any;
    (redis as any).scan = jest.fn(async () => ['0', []]) as any;
    await expect(store.ping!()).rejects.toThrow(/NOPERM/);
  });

  it('ping() rejects when SCAN is denied (rehydrate-ACL gap)', async () => {
    redis.set = jest.fn(async () => 'OK' as const) as any;
    redis.del = jest.fn(async () => 1) as any;
    (redis as any).scan = jest.fn(async () => {
      throw new Error('NOPERM scan');
    }) as any;
    await expect(store.ping!()).rejects.toThrow(/NOPERM scan/);
  });
});
