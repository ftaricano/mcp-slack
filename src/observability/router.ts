import express, { type Router } from 'express';

import { registry } from './metrics.js';

export interface StorageStatus {
  degraded: boolean;
  error?: string;
}

export interface ObservabilityDeps {
  /** Function returning per-workspace health (true=healthy). */
  readiness: () => Promise<Record<string, boolean>>;
  /**
   * Optional live storage probe. Invoked on each /ready call (with a small
   * in-router cache) so the endpoint reflects the *current* state of the
   * backing store — not a boot-time snapshot. Without this, a Redis outage
   * after boot stays invisible to /ready (and orchestrators), and a Redis
   * recovery after a degraded boot never lifts the 503.
   */
  storageProbe?: () => Promise<StorageStatus>;
  version?: string;
}

const STORAGE_PROBE_CACHE_MS = 5000;

export function createObservabilityRouter(deps: ObservabilityDeps): Router {
  const router = express.Router();

  // Per-router cache so multiple /ready hits don't hammer Redis if the endpoint
  // is polled aggressively (k8s readinessProbe defaults to every 10s, but ALBs
  // can hit faster). 5s TTL keeps recovery latency bounded while shielding the
  // backend.
  //
  // Important: only cache *healthy* results. A cached `degraded: true` would
  // delay recovery detection by up to 5s on every flap, which defeats the
  // whole point of switching from a boot snapshot to a live probe — we want
  // fast recovery once the store is back. Failures bypass the cache so the
  // very next /ready call re-probes.
  //
  // Two more correctness rules baked in here:
  //   1. The cache timestamp is captured *after* the probe resolves, not
  //      before the await. Otherwise a slow probe would shorten the effective
  //      TTL — e.g. a 4s probe + 5s TTL would only protect the backend for 1s.
  //   2. Concurrent cache misses are coalesced via an `inflight` promise so a
  //      burst of /ready calls (k8s + LB + sidecar) fans into a single probe.
  let cached: { at: number; result: StorageStatus } | null = null;
  let inflight: Promise<StorageStatus> | null = null;
  const cachedStorageProbe = async (): Promise<StorageStatus> => {
    const now = Date.now();
    if (cached && now - cached.at < STORAGE_PROBE_CACHE_MS) return cached.result;
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const result = await deps.storageProbe!();
        if (!result.degraded) {
          // Timestamp captured AFTER await so the TTL covers the full
          // post-resolve window, not whatever was left after the probe ran.
          cached = { at: Date.now(), result };
        } else {
          cached = null;
        }
        return result;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  };

  router.get('/health', (_req, res) => {
    res.json({ ok: true, version: deps.version ?? 'unknown' });
  });

  router.get('/ready', async (_req, res) => {
    try {
      const [workspaces, storage] = await Promise.all([
        deps.readiness(),
        deps.storageProbe ? cachedStorageProbe() : Promise.resolve(null),
      ]);
      const workspacesOk = Object.values(workspaces).every((v) => v === true);
      const storageOk = !storage || !storage.degraded;
      const ok = workspacesOk && storageOk;
      const body: Record<string, unknown> = { ok, workspaces };
      if (storage) body.storage = storage;
      res.status(ok ? 200 : 503).json(body);
    } catch (err) {
      res.status(503).json({ ok: false, error: (err as Error).message });
    }
  });

  router.get('/metrics', async (_req, res) => {
    try {
      res.setHeader('Content-Type', registry.contentType);
      res.send(await registry.metrics());
    } catch (err) {
      res.status(500).send((err as Error).message);
    }
  });

  return router;
}
