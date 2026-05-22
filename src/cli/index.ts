import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SlackOAuthManager } from '../auth/oauth.js';
import { bootstrap } from '../index.js';
import { SlackMCPServer } from '../server.js';
import { createDefaultTokenStore } from '../storage/factory.js';
import { rehydrateWorkspaces } from '../storage/rehydrate.js';
import type { TokenStore } from '../storage/token-store.js';
import { logger, redactForLogging } from '../utils/logger.js';

import { buildProgram, type CliDeps, type DoctorCheck, type DoctorReport } from './program.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkgPath = resolve(here, '../../package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };

let cachedServer: SlackMCPServer | null = null;
let cachedStorePromise: Promise<TokenStore> | null = null;

function getTokenStore(): Promise<TokenStore> {
  if (!cachedStorePromise) cachedStorePromise = createDefaultTokenStore();
  return cachedStorePromise;
}

/**
 * Release backing resources for one-shot CLI commands so the process can exit
 * cleanly. RedisTokenStore opens a long-lived ioredis socket that otherwise
 * keeps the event loop alive past `auth login/list/revoke`. We also clear the
 * cached promise so a subsequent in-process invocation gets a fresh store.
 *
 * Long-running commands (`serve`, `http`) must NOT call this — bootstrap()
 * owns the store lifetime there and disposes it on graceful shutdown.
 */
async function closeStore(store: TokenStore): Promise<void> {
  try {
    await store.close?.();
  } finally {
    cachedStorePromise = null;
  }
}

async function ensureServer(): Promise<SlackMCPServer> {
  if (!cachedServer) {
    cachedServer = new SlackMCPServer({
      name: process.env.MCP_SERVER_NAME ?? 'mcp-slack',
      version: process.env.MCP_SERVER_VERSION ?? pkg.version,
      capabilities: { resources: true, tools: true, prompts: false, logging: true },
    });
    // Replay persisted installations into slackClientManager so `tool invoke`
    // can dispatch against any registered workspace immediately. Without this
    // every invoke fails with "No Slack client found for workspace: <teamId>"
    // because cli/index.ts is a fresh process that doesn't share memory with
    // `mcp-slack http`. Best-effort: a degraded store (e.g. Redis offline)
    // logs a warning but does not crash the CLI — the user still gets a
    // useful error from the eventual tool call.
    try {
      const store = await getTokenStore();
      await rehydrateWorkspaces(store);
    } catch (err) {
      logger.warn('cli rehydrate failed (continuing)', {
        error: (err as Error).message,
      });
    }
  }
  return cachedServer;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var: ${name}`);
  return v;
}

async function doctorChecks(): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const required = [
    'SLACK_CLIENT_ID',
    'SLACK_CLIENT_SECRET',
    'SLACK_SIGNING_SECRET',
    'JWT_SECRET',
    'OAUTH_STATE_SECRET',
  ];
  for (const k of required) {
    const v = process.env[k];
    const check: DoctorCheck = { name: `env:${k}`, ok: !!v };
    if (!v) check.detail = 'not set';
    checks.push(check);
  }
  for (const k of ['JWT_SECRET', 'OAUTH_STATE_SECRET']) {
    const v = process.env[k];
    if (v) {
      const ok = v.length >= 32;
      const check: DoctorCheck = { name: `${k}.length>=32`, ok };
      if (!ok) check.detail = `length=${v.length}`;
      checks.push(check);
    }
  }

  // OAUTH_REDIRECT_URI: parseable URL with http/https. Empty is acceptable —
  // the OAuth flow falls back to http://localhost:3000/oauth/callback at use
  // time. We only fail if a value was provided and is malformed, since silently
  // accepting `not-a-url` would let `mcp-slack doctor` go green right before
  // /oauth/install hands Slack a bogus redirect.
  const redirectRaw = process.env.OAUTH_REDIRECT_URI;
  if (redirectRaw) {
    let parsed: URL | null = null;
    try {
      parsed = new URL(redirectRaw);
    } catch {
      parsed = null;
    }
    if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
      checks.push({
        name: 'OAUTH_REDIRECT_URI.valid',
        ok: false,
        detail: parsed
          ? `unsupported protocol: ${parsed.protocol}`
          : `not a parseable URL: ${redirectRaw}`,
      });
    } else {
      checks.push({ name: 'OAUTH_REDIRECT_URI.valid', ok: true });
    }
  }

  // Token store reachability. Default backend is the file store at
  // ~/.config/mcp-slack/tokens.json — `ping()` on the file impl is
  // mkdir-recursive, so it succeeds on fresh installs. Redis backend issues a
  // SET+DEL+SCAN sentinel which exercises the same ACL surface as list().
  // Failures here mean every OAuth callback / rehydrate is going to fail at
  // runtime, so we want them visible BEFORE the server boots.
  let store: TokenStore | null = null;
  try {
    store = await createDefaultTokenStore();
    await (store.ping?.() ?? Promise.resolve());
    const detail = process.env.REDIS_URL
      ? `redis: ${redactForLogging(process.env.REDIS_URL)}`
      : 'file';
    checks.push({ name: 'token_store.reachable', ok: true, detail });
  } catch (err) {
    checks.push({
      name: 'token_store.reachable',
      ok: false,
      detail: (err as Error).message,
    });
  } finally {
    if (store) await store.close?.().catch(() => undefined);
  }

  return { ok: checks.every((c) => c.ok), checks };
}

const deps: CliDeps = {
  serve: async () => {
    const handle = await bootstrap();
    process.once('SIGINT', () => {
      void handle.stop().then(() => process.exit(0));
    });
    process.once('SIGTERM', () => {
      void handle.stop().then(() => process.exit(0));
    });
  },
  http: async ({ port }) => {
    process.env.ENABLE_HTTP_SERVER = 'true';
    process.env.PORT = String(port);
    const handle = await bootstrap();
    process.once('SIGINT', () => {
      void handle.stop().then(() => process.exit(0));
    });
    process.once('SIGTERM', () => {
      void handle.stop().then(() => process.exit(0));
    });
  },
  doctor: doctorChecks,
  authLogin: async () => {
    const store = await getTokenStore();
    try {
      const oauth = new SlackOAuthManager({
        clientId: requireEnv('SLACK_CLIENT_ID'),
        clientSecret: requireEnv('SLACK_CLIENT_SECRET'),
        redirectUri: process.env.OAUTH_REDIRECT_URI ?? 'http://localhost:3000/oauth/callback',
        scopes: (process.env.SLACK_SCOPES ?? 'chat:write,channels:read').split(',').filter(Boolean),
        tokenStore: store,
      });
      const url = await oauth.generateInstallUrl();
      return { url };
    } finally {
      await closeStore(store);
    }
  },
  authList: async () => {
    const store = await getTokenStore();
    try {
      const list = await store.list();
      return list.map((t) => ({ teamId: t.teamId, installedAt: t.installedAt }));
    } finally {
      await closeStore(store);
    }
  },
  authRevoke: async (teamId) => {
    const store = await getTokenStore();
    try {
      await store.delete(teamId);
    } finally {
      await closeStore(store);
    }
  },
  // Mirror auth-* commands: close the cached token store on the way out so
  // RedisTokenStore's long-lived ioredis socket releases the event loop and
  // the one-shot CLI can exit cleanly. Without this the process appears hung
  // after the JSON output is printed.
  toolList: async () => {
    try {
      return (await ensureServer()).listToolNames();
    } finally {
      if (cachedStorePromise) {
        const store = await cachedStorePromise;
        await closeStore(store);
      }
    }
  },
  toolInvoke: async (name, args) => {
    try {
      return await (await ensureServer()).callTool(name, args);
    } finally {
      if (cachedStorePromise) {
        const store = await cachedStorePromise;
        await closeStore(store);
      }
    }
  },
};

export async function run(argv: string[]): Promise<void> {
  try {
    const program = buildProgram(deps, pkg.version);
    await program.parseAsync(argv);
  } catch (err) {
    logger.error('cli error', { error: (err as Error).message });
    throw err;
  }
}
