import type Redis from 'ioredis';

import type { InstalledToken, TokenStore } from './token-store.js';

export class RedisTokenStore implements TokenStore {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = 'mcp-slack:token:',
  ) {}

  private key(teamId: string): string {
    return `${this.prefix}${teamId}`;
  }

  async get(teamId: string): Promise<InstalledToken | null> {
    const raw = await this.redis.get(this.key(teamId));
    return raw ? (JSON.parse(raw) as InstalledToken) : null;
  }

  async set(token: InstalledToken): Promise<void> {
    await this.redis.set(this.key(token.teamId), JSON.stringify(token));
  }

  async delete(teamId: string): Promise<void> {
    await this.redis.del(this.key(teamId));
  }

  async list(): Promise<InstalledToken[]> {
    const matched = new Set<string>();
    let cursor = '0';
    // Walk the keyspace incrementally. SCAN COUNT 100 keeps each round-trip bounded
    // and avoids the production-unsafe KEYS command. Loop stops when cursor returns
    // to '0'. Aligns with ping()'s SCAN surface so /ready and list() share the same
    // ACL dependency — no more "ping healthy but list broken" contradictions.
    // Dedupe via Set: SCAN may return the same key across rounds when the keyspace
    // is rehashing or being mutated mid-iteration (Redis docs guarantee no missed
    // keys, not no duplicates). Without this, MGET counts a workspace twice.
    do {
      const [next, batch] = await this.redis.scan(cursor, 'MATCH', `${this.prefix}*`, 'COUNT', 100);
      for (const k of batch) matched.add(k);
      cursor = next;
    } while (cursor !== '0');

    if (matched.size === 0) return [];
    const keys = [...matched];
    const values = await this.redis.mget(keys);
    return values
      .filter((v): v is string => v !== null && v !== undefined)
      .map((v) => JSON.parse(v) as InstalledToken);
  }

  async ping(): Promise<void> {
    // Exercise the actual write surface (SET + DEL) AND the list surface (SCAN).
    // SET/DEL are the most-restrictive permissions: if they work, OAuth callbacks
    // can persist installations. SCAN with COUNT 1 instead of KEYS — KEYS is O(N)
    // over the entire DB even when the pattern matches nothing, while SCAN bounds
    // work to roughly COUNT keys and shares the same ACL surface needed for
    // rehydrate. Fail fast on any of these so /ready reflects real store usability.
    const sentinel = `${this.prefix}__healthcheck__`;
    await this.redis.set(sentinel, '1', 'EX', 30);
    await this.redis.del(sentinel);
    await this.redis.scan(0, 'MATCH', `${this.prefix}*`, 'COUNT', 1);
  }

  /**
   * Quit the underlying ioredis connection so CLI one-shots can exit cleanly.
   * Without this the Redis socket keeps the event loop alive and `auth login`,
   * `auth list`, `auth revoke` hang past their work.
   */
  async close(): Promise<void> {
    await this.redis.quit();
  }

  /**
   * Raw KV primitives for short-lived blobs (e.g. OAuth state). Keys are NOT
   * prefixed by the token namespace — callers pass full keys (typically with
   * their own prefix like `oauth-state:`) so token enumeration via SCAN
   * MATCH `${tokenPrefix}*` does not accidentally surface state entries.
   */
  async setRaw(key: string, value: string, ttlSec?: number): Promise<void> {
    if (typeof ttlSec === 'number' && ttlSec > 0) {
      await this.redis.set(key, value, 'EX', ttlSec);
    } else {
      await this.redis.set(key, value);
    }
  }

  async getRaw(key: string): Promise<string | null> {
    return await this.redis.get(key);
  }

  async delRaw(key: string): Promise<void> {
    await this.redis.del(key);
  }
}
