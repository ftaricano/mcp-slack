import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';

import { MemoryTokenStore } from './memory-token-store.js';
import { RedisTokenStore } from './redis-token-store.js';
import type { InstalledToken, TokenStore } from './token-store.js';

export interface FactoryOptions {
  env?: NodeJS.ProcessEnv;
}

/**
 * Build the default {@link TokenStore} for the running process.
 *
 * Selection order:
 *   1. `REDIS_URL` set       -> {@link RedisTokenStore} (lazy ioredis import).
 *   2. `MCP_SLACK_TOKEN_STORE_PATH=:memory:` -> {@link MemoryTokenStore}.
 *   3. otherwise             -> {@link FileTokenStore} at the configured path
 *      (or `~/.config/mcp-slack/tokens.json` by default).
 *
 * Centralised so CLI processes (`mcp-slack auth login/list/revoke`) and the
 * long-running `mcp-slack http` server share the same persisted state when
 * pointed at the same backend. Without this, both ends instantiate their own
 * in-memory store and never see each other.
 */
export async function createDefaultTokenStore(opts: FactoryOptions = {}): Promise<TokenStore> {
  const env = opts.env ?? process.env;

  if (env.REDIS_URL) {
    // Lazy import keeps ioredis off the cold path when unused.
    const { default: Redis } = await import('ioredis');
    // Fast-fail config. ioredis defaults retry connections forever and queue
    // commands offline, which makes a bad URL or a down Redis hang `list()`
    // and `ping()` ~10s before rejecting — that flaps /ready, blocks boot
    // rehydrate, and produces opaque CLI hangs.
    //
    //   enableOfflineQueue: false  -> commands fail immediately when the
    //                                 socket isn't connected (no buffering).
    //   maxRetriesPerRequest: 1    -> a single in-flight retry, not 20.
    //   connectTimeout: 2000       -> 2s TCP/TLS handshake budget.
    //   lazyConnect: false         -> connect eagerly so failures surface at
    //                                 boot, not on first command.
    //   retryStrategy: () => null  -> do not auto-reconnect; let the operator
    //                                 (or a supervisor) decide.
    //
    // Operators who want fault-tolerant reconnect can layer their own ioredis
    // options via a future MCP_SLACK_REDIS_OPTIONS env override — for now we
    // optimize for fast feedback in dev/test and clear failure modes in prod.
    const client = new Redis(env.REDIS_URL, {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      lazyConnect: false,
      retryStrategy: () => null,
    });

    // Wait for the connection to be ready, but bound by the connectTimeout.
    // With `enableOfflineQueue: false`, ioredis rejects commands while the
    // socket is still in 'connecting' state — so the very next list()/ping()
    // (boot rehydrate / CLI) races against the connect handshake and fails
    // with ECONNREFUSED or "Stream isn't writeable" even on healthy Redis.
    // Awaiting 'ready' here makes the factory's contract: "the returned
    // store is usable immediately."
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Redis connect timeout (2s)'));
      }, 2500);
      function cleanup(): void {
        clearTimeout(timer);
        client.off('ready', onReady);
        client.off('error', onError);
      }
      function onReady(): void {
        cleanup();
        resolve();
      }
      function onError(err: Error): void {
        cleanup();
        reject(err);
      }
      client.once('ready', onReady);
      client.once('error', onError);
    });

    return new RedisTokenStore(client, env.MCP_SLACK_REDIS_PREFIX);
  }

  const path = env.MCP_SLACK_TOKEN_STORE_PATH ?? defaultPath();
  if (path === ':memory:') return new MemoryTokenStore();
  return new FileTokenStore(path);
}

function defaultPath(): string {
  return join(os.homedir(), '.config', 'mcp-slack', 'tokens.json');
}

/**
 * Simple JSON-on-disk {@link TokenStore}. Single-process safe; not designed
 * for concurrent writers across processes — for that, use Redis.
 */
export class FileTokenStore implements TokenStore {
  constructor(private readonly path: string) {}

  private read(): Record<string, InstalledToken> {
    if (!existsSync(this.path)) return {};
    // Surface I/O and parse failures distinctly. The previous catch-all
    // `return {}` swallowed corrupt-file errors, so the very next `set()`
    // would overwrite the broken JSON with a fresh map and silently drop
    // every previously installed workspace. Boot rehydrate already has its
    // own try/catch that converts a thrown error to `degraded`; the CLI
    // (`auth list/revoke`) will now error explicitly instead of returning
    // empty results that look like a successful no-op.
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch (err) {
      throw new Error(`token store unreadable at ${this.path}: ${(err as Error).message}`);
    }
    if (!raw) return {};
    try {
      return JSON.parse(raw) as Record<string, InstalledToken>;
    } catch (err) {
      throw new Error(`token store corrupt at ${this.path}: ${(err as Error).message}`);
    }
  }

  private write(map: Record<string, InstalledToken>): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(map, null, 2), { mode: 0o600 });
  }

  async get(teamId: string): Promise<InstalledToken | null> {
    return this.read()[teamId] ?? null;
  }

  async set(token: InstalledToken): Promise<void> {
    const map = this.read();
    map[token.teamId] = token;
    this.write(map);
  }

  async delete(teamId: string): Promise<void> {
    const map = this.read();
    delete map[teamId];
    this.write(map);
  }

  async list(): Promise<InstalledToken[]> {
    return Object.values(this.read());
  }

  /**
   * Constant-time liveness probe. On a fresh deploy the parent directory may
   * not exist yet — `set()` would create it on first install via
   * `mkdirSync({ recursive: true })`, so we do exactly that here at boot.
   * Idempotent: succeeds if the dir already exists, creates it otherwise,
   * throws only when the path is genuinely unwritable.
   */
  async ping(): Promise<void> {
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    } catch (err) {
      throw new Error(`token store unreachable: ${(err as Error).message}`);
    }
  }

  // Raw KV used for OAuth state (and any future short-lived blobs). Stored in
  // a sibling file `<tokens.json>.kv.json` keyed by the caller's full key. We
  // record an `expiresAt` epoch ms when ttlSec is provided and lazily evict on
  // read — avoids spawning a sweep timer.
  private rawPath(): string {
    return `${this.path}.kv.json`;
  }
  private readRaw(): Record<string, { value: string; expiresAt?: number }> {
    if (!existsSync(this.rawPath())) return {};
    try {
      const raw = readFileSync(this.rawPath(), 'utf8');
      return raw ? (JSON.parse(raw) as Record<string, { value: string; expiresAt?: number }>) : {};
    } catch {
      return {};
    }
  }
  private writeRaw(map: Record<string, { value: string; expiresAt?: number }>): void {
    mkdirSync(dirname(this.rawPath()), { recursive: true });
    writeFileSync(this.rawPath(), JSON.stringify(map, null, 2), { mode: 0o600 });
  }

  async setRaw(key: string, value: string, ttlSec?: number): Promise<void> {
    const map = this.readRaw();
    const entry: { value: string; expiresAt?: number } = { value };
    if (typeof ttlSec === 'number' && ttlSec > 0) {
      entry.expiresAt = Date.now() + ttlSec * 1000;
    }
    map[key] = entry;
    this.writeRaw(map);
  }
  async getRaw(key: string): Promise<string | null> {
    const map = this.readRaw();
    const entry = map[key];
    if (!entry) return null;
    if (entry.expiresAt && entry.expiresAt < Date.now()) {
      delete map[key];
      this.writeRaw(map);
      return null;
    }
    return entry.value;
  }
  async delRaw(key: string): Promise<void> {
    const map = this.readRaw();
    if (map[key]) {
      delete map[key];
      this.writeRaw(map);
    }
  }
}
