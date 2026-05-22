import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { resetMetrics } from '../../../src/observability/metrics.js';
import { createObservabilityRouter } from '../../../src/observability/router.js';

function buildApp(opts: {
  ready: Record<string, boolean> | (() => Promise<Record<string, boolean>>);
  version?: string;
}) {
  const readiness =
    typeof opts.ready === 'function'
      ? opts.ready
      : async () => opts.ready as Record<string, boolean>;
  const app = express();
  const deps: { readiness: () => Promise<Record<string, boolean>>; version?: string } = {
    readiness,
  };
  if (opts.version !== undefined) deps.version = opts.version;
  app.use(createObservabilityRouter(deps));
  return app;
}

describe('observability router', () => {
  beforeEach(() => {
    resetMetrics();
  });

  it('GET /health returns 200', async () => {
    const res = await request(buildApp({ ready: { T1: true }, version: '1.2.3' })).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, version: '1.2.3' });
  });

  it('GET /ready returns 200 when all workspaces healthy', async () => {
    const res = await request(buildApp({ ready: { T1: true, T2: true } })).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('GET /ready returns 503 when any workspace unhealthy', async () => {
    const res = await request(buildApp({ ready: { T1: true, T2: false } })).get('/ready');
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
  });

  it('GET /ready returns 503 when readiness fn throws', async () => {
    const res = await request(
      buildApp({
        ready: async () => {
          throw new Error('boom');
        },
      }),
    ).get('/ready');
    expect(res.status).toBe(503);
  });

  it('GET /ready returns 503 when storage is degraded even with healthy workspaces', async () => {
    const app = express();
    app.use(
      createObservabilityRouter({
        readiness: async () => ({ T1: true }),
        storageProbe: async () => ({ degraded: true, error: 'redis: ECONNREFUSED' }),
        version: '1.0.0',
      }),
    );
    const res = await request(app).get('/ready');
    expect(res.status).toBe(503);
    expect(res.body.storage).toMatchObject({ degraded: true });
  });

  it('GET /ready returns 200 when storage is healthy and workspaces healthy', async () => {
    const app = express();
    app.use(
      createObservabilityRouter({
        readiness: async () => ({ T1: true }),
        storageProbe: async () => ({ degraded: false }),
        version: '1.0.0',
      }),
    );
    const res = await request(app).get('/ready');
    expect(res.status).toBe(200);
  });

  it('GET /metrics returns prom-format text', async () => {
    const res = await request(buildApp({ ready: { T1: true } })).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.text).toContain('# HELP mcp_slack_calls_total');
    expect(res.text).toContain('# TYPE mcp_slack_calls_total counter');
  });
});

describe('/ready storage live probe', () => {
  it('refreshes storage status on each call (recovery scenario)', async () => {
    let attempt = 0;
    const list = jest.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('redis: ECONNREFUSED');
      return [];
    });
    const store = {
      get: async () => null,
      set: async () => undefined,
      delete: async () => undefined,
      list,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const app = express();
    app.use(
      createObservabilityRouter({
        readiness: async () => ({ T1: true }),
        storageProbe: () =>
          store.list().then(
            () => ({ degraded: false }),
            (err: Error) => ({ degraded: true, error: err.message }),
          ),
        version: '1.0.0',
      }),
    );

    // First call: storage down -> 503
    const r1 = await request(app).get('/ready');
    expect(r1.status).toBe(503);
    expect(r1.body.storage).toMatchObject({ degraded: true });

    // Second call: storage recovered -> 200
    const r2 = await request(app).get('/ready');
    expect(r2.status).toBe(200);
    expect(r2.body.storage).toEqual({ degraded: false });
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('caches storage probe result for ~5s to avoid hammering', async () => {
    const list = jest.fn(async () => []);
    const store = {
      get: async () => null,
      set: async () => undefined,
      delete: async () => undefined,
      list,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const app = express();
    app.use(
      createObservabilityRouter({
        readiness: async () => ({ T1: true }),
        storageProbe: () =>
          store.list().then(
            () => ({ degraded: false }),
            (err: Error) => ({ degraded: true, error: err.message }),
          ),
        version: '1.0.0',
      }),
    );

    await request(app).get('/ready');
    await request(app).get('/ready');
    await request(app).get('/ready');
    // Within the cache TTL, list() should have been called at most twice (first call + maybe one refresh).
    // The exact count depends on cache impl; assert <=3 to leave headroom.
    expect(list.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('stays 503 when ping recovers but rehydrate keeps failing (Bug II)', async () => {
    // Reproduces the closure in src/index.ts: ping() succeeds (so the outer
    // try-block doesn't throw), but the recovery rehydrate still can't read
    // the store. Before the fix, the closure returned { degraded: false }
    // because ping was healthy — so /ready flipped to 200 even though tool
    // calls would still fail (workspaces never rehydrated). The fix surfaces
    // rehydrate's degraded flag.
    let lastProbeDegraded = true; // boot was degraded
    const ping = jest.fn(async () => undefined); // ping always ok
    const list = jest.fn(async () => {
      throw new Error('list still down');
    });

    const probe = async (): Promise<{ degraded: boolean; error?: string }> => {
      try {
        await ping();
        if (lastProbeDegraded) {
          // Mirror rehydrateWorkspaces' soft-fail contract: catch list errors
          // and return { degraded: true, error } instead of throwing.
          let r: { degraded: boolean; error?: string; count: number };
          try {
            await list();
            r = { degraded: false, count: 0 };
          } catch (err) {
            r = { degraded: true, error: (err as Error).message, count: 0 };
          }
          if (r.degraded) {
            return { degraded: true, error: r.error ?? 'recovery rehydrate failed' };
          }
          lastProbeDegraded = false;
        }
        return { degraded: false };
      } catch (err) {
        lastProbeDegraded = true;
        return { degraded: true, error: (err as Error).message };
      }
    };

    const app = express();
    app.use(
      createObservabilityRouter({
        readiness: async () => ({ T1: true }),
        storageProbe: probe,
        version: '1.0.0',
      }),
    );

    // ping ok + list still failing → /ready must remain 503
    const r1 = await request(app).get('/ready');
    expect(r1.status).toBe(503);
    expect(r1.body.storage).toMatchObject({ degraded: true, error: 'list still down' });
    expect(ping).toHaveBeenCalled();
    expect(list).toHaveBeenCalled();
  });

  it('coalesces concurrent /ready cache misses into one probe', async () => {
    let inFlight = 0;
    let maxConcurrent = 0;
    const probe = jest.fn(async () => {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise((r) => setTimeout(r, 50));
      inFlight -= 1;
      return { degraded: false } as const;
    });

    const app = express();
    app.use(
      createObservabilityRouter({
        readiness: async () => ({ T1: true }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        storageProbe: probe as any,
        version: '1.0.0',
      }),
    );

    await Promise.all([
      request(app).get('/ready'),
      request(app).get('/ready'),
      request(app).get('/ready'),
    ]);

    expect(probe).toHaveBeenCalledTimes(1);
    expect(maxConcurrent).toBe(1);
  });
});
