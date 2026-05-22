#!/usr/bin/env node

import { type Server as HttpServer } from 'node:http';

import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import helmet from 'helmet';

import { createOAuthManager } from './auth/oauth.js';
import { createObservabilityRouter, type StorageStatus } from './observability/router.js';
import { SlackMCPServer } from './server.js';
import { createDefaultTokenStore } from './storage/factory.js';
import { rehydrateWorkspaces } from './storage/rehydrate.js';
import { MCPServerConfig } from './types/mcp.js';
import { SlackOAuthConfig } from './types/slack.js';
import { logger, logAudit, createRequestLogger } from './utils/logger.js';
import { slackClientManager } from './utils/slack-client.js';

// Load environment variables
dotenv.config();

export interface BootstrapHandle {
  stop: () => Promise<void>;
  httpAddress: string | null;
}

// Validate required environment variables. Throws (does not exit) so callers
// can surface the failure cleanly — bootstrap() owns process.exit semantics.
function validateEnvironment(): void {
  const required = [
    'SLACK_CLIENT_ID',
    'SLACK_CLIENT_SECRET',
    'SLACK_SIGNING_SECRET',
    'JWT_SECRET',
    'OAUTH_STATE_SECRET',
  ];

  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    logger.error('Missing required environment variables', { missing });
    throw new Error(`missing env vars: ${missing.join(',')}`);
  }
}

export async function bootstrap(): Promise<BootstrapHandle> {
  validateEnvironment();

  // MCP Server configuration
  const mcpConfig: MCPServerConfig = {
    name: process.env.MCP_SERVER_NAME || 'mcp-slack',
    version: process.env.MCP_SERVER_VERSION || '1.0.0',
    capabilities: {
      resources: true,
      tools: true,
      prompts: false, // Will be implemented in future versions
      logging: true,
    },
  };

  // Slack OAuth configuration. tokenStore is sourced from the same factory the
  // CLI uses so `mcp-slack auth login` and the long-running `mcp-slack http`
  // server share installations when pointed at the same backend (file/Redis).
  const tokenStore = await createDefaultTokenStore();

  // Replay persisted installations into the in-memory slackClientManager BEFORE
  // any tool calls can land. Without this, /auth list shows the persisted teamIds
  // but every tool call fails with "No Slack client found for workspace: <id>"
  // until the next /oauth/callback re-registers them.
  //
  // The result captures whether the underlying store was reachable AT BOOT —
  // useful for startup logs only. The /ready endpoint uses a live probe (below)
  // so a Redis recovery after boot lifts the 503, and a Redis outage AFTER boot
  // is detected.
  const bootRehydration = await rehydrateWorkspaces(tokenStore);
  if (bootRehydration.degraded) {
    logger.warn('Token store degraded at boot', { error: bootRehydration.error });
  }

  const oauthConfig: SlackOAuthConfig = {
    clientId: process.env.SLACK_CLIENT_ID!,
    clientSecret: process.env.SLACK_CLIENT_SECRET!,
    redirectUri: process.env.OAUTH_REDIRECT_URI || 'http://localhost:3000/oauth/callback',
    scopes: [
      'channels:read',
      'channels:write',
      'channels:history',
      'chat:write',
      'files:read',
      'files:write',
      'users:read',
      'search:read',
      'reactions:write',
      'team:read',
      'usergroups:read',
      'conversations.connect:read',
      'conversations.connect:write',
    ],
    userScopes: ['channels:read', 'chat:write', 'files:read', 'users:read', 'search:read'],
    tokenStore,
  };

  const slackServer = new SlackMCPServer(mcpConfig);
  let httpServer: HttpServer | null = null;
  let httpAddress: string | null = null;

  if (process.env.ENABLE_HTTP_SERVER === 'true') {
    const app = express();
    const port = Number(process.env.PORT ?? 3000);

    // Security middleware
    app.use(
      helmet({
        contentSecurityPolicy: {
          directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            scriptSrc: ["'self'"],
            imgSrc: ["'self'", 'data:', 'https:'],
            connectSrc: ["'self'"],
            fontSrc: ["'self'"],
            objectSrc: ["'none'"],
            mediaSrc: ["'self'"],
            frameSrc: ["'none'"],
          },
        },
        crossOriginEmbedderPolicy: false,
      }),
    );

    app.use(
      cors({
        origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
        credentials: true,
      }),
    );

    app.use(express.json({ limit: '10mb' }));
    app.use(express.urlencoded({ extended: true, limit: '10mb' }));
    app.use(createRequestLogger());

    // OAuth routes
    const oauthManager = createOAuthManager(oauthConfig);
    app.use('/oauth', oauthManager.createRouter());

    // Observability (health/ready/metrics) — Task 2.6 router. Readiness is
    // sourced from slackClientManager so /ready reflects real workspace state.
    //
    // The `lastProbeDegraded` flag tracks the last *known* storage state across
    // probe calls. It seeds from boot: if rehydrate succeeded at boot we never
    // need to replay; if boot was degraded, the next healthy probe transitions
    // degraded → healthy and triggers `rehydrateWorkspaces` to replay persisted
    // installations into the in-memory client manager. Without this, a
    // post-boot Redis recovery flips /ready to 200 but every tool call still
    // fails with "No Slack client found for workspace: <id>".
    let lastProbeDegraded = bootRehydration.degraded;
    app.use(
      createObservabilityRouter({
        readiness: () => slackClientManager.healthCheck(),
        storageProbe: async (): Promise<StorageStatus> => {
          try {
            // Use the constant-time `ping()` rather than `list()`. `list()` on
            // Redis is `KEYS + MGET` (O(n) over workspaces), which makes
            // readiness latency grow with tenant count and flaps probes.
            await (tokenStore.ping?.() ?? Promise.resolve());
            if (lastProbeDegraded) {
              // Storage just came back up — replay persisted installations so
              // tool calls work without waiting for the next /oauth/callback.
              try {
                const r = await rehydrateWorkspaces(tokenStore);
                if (r.degraded) {
                  // Bug II: rehydrate's own `list()` failed even though `ping()`
                  // succeeded — partial recovery. Surface degraded so /ready
                  // stays 503 instead of falsely flipping to 200 while tool
                  // calls still hit "No Slack client found for workspace".
                  return {
                    degraded: true,
                    error: r.error ?? 'recovery rehydrate failed',
                  };
                }
                logger.info('Rehydrated workspaces after storage recovery', {
                  count: r.count,
                });
                lastProbeDegraded = false;
              } catch (err) {
                // Defensive: rehydrateWorkspaces is supposed to capture errors
                // into `RehydrationResult.degraded`, but if it throws anyway
                // (e.g. unexpected programmer error) we must keep /ready at
                // 503 rather than reporting healthy.
                const error = (err as Error).message;
                logger.warn('Recovery rehydrate failed', { error });
                return { degraded: true, error };
              }
            }
            return { degraded: false };
          } catch (err) {
            lastProbeDegraded = true;
            return { degraded: true, error: (err as Error).message };
          }
        },
        version: mcpConfig.version,
      }),
    );

    // Info endpoint (kept from previous bootstrap; complements /health).
    app.get('/info', (_req, res) => {
      const stats = slackServer.getStats();
      res.json({
        name: mcpConfig.name,
        version: mcpConfig.version,
        description: 'MCP Server para integração completa com Slack - Uso empresarial',
        capabilities: mcpConfig.capabilities,
        stats,
        oauth: {
          install_url: '/oauth/install',
          callback_url: '/oauth/callback',
        },
        documentation: {
          repository: 'https://github.com/grupocpz/mcp-slack',
          setup_guide: '/docs/setup',
        },
      });
    });

    // Error handling
    app.use((err: any, req: any, res: any, _next: any) => {
      logger.error('HTTP Server error', {
        error: err.message,
        stack: err.stack,
        url: req.url,
        method: req.method,
      });

      res.status(err.status || 500).json({
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong',
      });
    });

    httpServer = await new Promise<HttpServer>((resolve) => {
      const server = app.listen(port, () => {
        const addr = server.address();
        httpAddress =
          typeof addr === 'string' ? addr : addr ? `http://localhost:${addr.port}` : null;
        logger.info('HTTP server started', { port, httpAddress });
        resolve(server);
      });
    });
  }

  // Start MCP server (stdio transport)
  await slackServer.start();
  logger.info('mcp-slack started', { httpAddress });

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info('Shutting down mcp-slack...');

    // Hard-kill safety net: if any cleanup stalls past 5s, force exit. The
    // timer is unref()'d so it never blocks a successful shutdown itself.
    const hardKill = setTimeout(() => {
      logger.error('Shutdown stalled past 5s — forcing exit');
      process.exit(1);
    }, 5000);
    hardKill.unref();

    try {
      if (httpServer) {
        await new Promise<void>((resolve, reject) => {
          httpServer!.close((err) => (err ? reject(err) : resolve()));
        });
      }
      await slackServer.stop();
      // Release backing resources (e.g. Redis socket) so the process can exit.
      try {
        await tokenStore.close?.();
      } catch (err) {
        logger.warn('tokenStore.close failed', { error: (err as Error).message });
      }
      logAudit({
        user: 'system',
        action: 'server_shutdown',
        resource: 'mcp-server',
        details: { name: mcpConfig.name, graceful: true },
        status: 'success',
      });
      logger.info('mcp-slack stopped gracefully');
    } finally {
      clearTimeout(hardKill);
    }
  };

  return { stop, httpAddress };
}

function attachSignalHandlers(handle: BootstrapHandle): void {
  let shuttingDown = false;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Received signal', { signal });
    handle.stop().then(
      () => process.exit(0),
      (err: unknown) => {
        logger.error('Shutdown error', { error: (err as Error).message });
        process.exit(1);
      },
    );
  };

  // .once() so a second SIGTERM during shutdown doesn't re-enter; the
  // hard-kill timer in stop() handles a stalled shutdown.
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  process.once('SIGQUIT', onSignal);

  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', { error: error.message, stack: error.stack });
    process.exit(1);
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled promise rejection', {
      reason,
      promise: promise.toString(),
    });
    process.exit(1);
  });
}

// Entrypoint guard: only auto-bootstrap when invoked directly (not under test).
if (import.meta.url === `file://${process.argv[1]}`) {
  bootstrap()
    .then((handle) => {
      attachSignalHandlers(handle);
    })
    .catch((error: unknown) => {
      const err = error as Error;
      logger.error('Startup error', { error: err.message, stack: err.stack });
      process.exit(1);
    });
}
