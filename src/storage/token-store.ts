export interface InstalledToken {
  teamId: string;
  enterpriseId?: string;
  userId: string;
  botToken: string;
  userToken?: string;
  /** Scopes granted to the bot token only. */
  scopes: string[];
  /** Scopes granted to the user token, when present. */
  userScopes?: string[];
  installedAt: number;
  appId?: string;
  /** Free-form metadata for callers (e.g. team name). Optional. */
  metadata?: Record<string, unknown>;
}

export interface TokenStore {
  get(teamId: string): Promise<InstalledToken | null>;
  set(token: InstalledToken): Promise<void>;
  delete(teamId: string): Promise<void>;
  list(): Promise<InstalledToken[]>;
  /**
   * Cheap liveness probe (constant time, independent of stored count). Used by
   * `/ready` so readiness latency does not grow with the number of workspaces
   * — `list()` over Redis is `KEYS + MGET`, which is O(n) and unsafe for hot
   * paths. Throws on backend failure so the probe can flip /ready to 503.
   */
  ping?(): Promise<void>;
  /** Optional: release backing resources (network sockets, file handles). */
  close?(): Promise<void>;
  /**
   * Optional raw key/value primitives for callers that need to persist short-
   * lived blobs alongside tokens (e.g. OAuth state during install handshake).
   * Implementations that don't expose these (memory store today) cause the
   * caller to fall back to in-process state — which only works in single-
   * replica deployments. Redis and File stores implement these.
   */
  setRaw?(key: string, value: string, ttlSec?: number): Promise<void>;
  getRaw?(key: string): Promise<string | null>;
  delRaw?(key: string): Promise<void>;
}
