import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(process.cwd());
const BIN = resolve(ROOT, 'bin/mcp-slack.js');
const DIST_INDEX = resolve(ROOT, 'dist/cli/index.js');

function ensureBuild(): void {
  if (existsSync(DIST_INDEX)) return;
  const r = spawnSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) throw new Error('npm run build failed');
}

function runCli(args: string[], env: NodeJS.ProcessEnv = {}): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [BIN, ...args], {
    env: {
      PATH: process.env.PATH ?? '',
      // HOME is required so the FileTokenStore default path
      // (~/.config/mcp-slack/tokens.json) resolves to a writable location
      // when the new `token_store.reachable` doctor check runs.
      HOME: process.env.HOME ?? '/tmp',
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      ...env,
    },
    encoding: 'utf8',
    timeout: 15_000,
  });
}

describe('mcp-slack CLI (integration)', () => {
  beforeAll(() => {
    ensureBuild();
  }, 120_000);

  it('--help exits 0 and lists all commands', () => {
    const r = runCli(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Usage: mcp-slack/);
    for (const cmd of ['serve', 'http', 'doctor', 'auth', 'tool']) {
      expect(r.stdout).toContain(cmd);
    }
  });

  it('--version prints the package version', () => {
    const r = runCli(['--version']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('doctor exits 1 when env vars are missing', () => {
    const r = runCli(['doctor']);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/✗ env:SLACK_CLIENT_ID/);
    expect(r.stdout).toMatch(/✗ env:JWT_SECRET/);
  });

  it('doctor exits 0 with all required env + 32-char secrets', () => {
    const r = runCli(['doctor'], {
      SLACK_CLIENT_ID: 'x',
      SLACK_CLIENT_SECRET: 'y',
      SLACK_SIGNING_SECRET: 'z',
      JWT_SECRET: 'a'.repeat(32),
      OAUTH_STATE_SECRET: 'b'.repeat(32),
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/✓ env:SLACK_CLIENT_ID/);
    expect(r.stdout).toMatch(/✓ env:JWT_SECRET/);
    expect(r.stdout).toMatch(/✓ JWT_SECRET\.length>=32/);
    expect(r.stdout).not.toMatch(/✗ /);
  });

  it('doctor flags short JWT_SECRET as failing', () => {
    const r = runCli(['doctor'], {
      SLACK_CLIENT_ID: 'x',
      SLACK_CLIENT_SECRET: 'y',
      SLACK_SIGNING_SECRET: 'z',
      JWT_SECRET: 'too-short',
      OAUTH_STATE_SECRET: 'b'.repeat(32),
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/✗ JWT_SECRET\.length>=32/);
  });

  it('doctor fails when OAUTH_REDIRECT_URI is malformed', () => {
    const r = runCli(['doctor'], {
      SLACK_CLIENT_ID: 'x',
      SLACK_CLIENT_SECRET: 'y',
      SLACK_SIGNING_SECRET: 'z',
      JWT_SECRET: 'a'.repeat(32),
      OAUTH_STATE_SECRET: 'b'.repeat(32),
      OAUTH_REDIRECT_URI: 'not-a-url',
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/✗ OAUTH_REDIRECT_URI\.valid/);
  });

  it('doctor passes when OAUTH_REDIRECT_URI is a valid http URL', () => {
    const r = runCli(['doctor'], {
      SLACK_CLIENT_ID: 'x',
      SLACK_CLIENT_SECRET: 'y',
      SLACK_SIGNING_SECRET: 'z',
      JWT_SECRET: 'a'.repeat(32),
      OAUTH_STATE_SECRET: 'b'.repeat(32),
      OAUTH_REDIRECT_URI: 'https://example.com/oauth/callback',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/✓ OAUTH_REDIRECT_URI\.valid/);
  });

  it('doctor exercises the token store via ping', () => {
    const r = runCli(['doctor'], {
      SLACK_CLIENT_ID: 'x',
      SLACK_CLIENT_SECRET: 'y',
      SLACK_SIGNING_SECRET: 'z',
      JWT_SECRET: 'a'.repeat(32),
      OAUTH_STATE_SECRET: 'b'.repeat(32),
      // Force the FileTokenStore at a tmp path so the test is hermetic.
      MCP_SLACK_TOKEN_STORE_PATH: '/tmp/mcp-slack-doctor-probe.json',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/✓ token_store\.reachable/);
  });

  it('tool list prints ≥37 tool names', () => {
    const r = runCli(['tool', 'list'], {
      SLACK_CLIENT_ID: 'x',
      SLACK_CLIENT_SECRET: 'y',
      SLACK_SIGNING_SECRET: 'z',
      JWT_SECRET: 'a'.repeat(32),
      OAUTH_STATE_SECRET: 'b'.repeat(32),
    });
    expect(r.status).toBe(0);
    const names = r.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    // The CLI may also log winston "initialized" lines — filter to MCP tool names by shape:
    const toolNames = names.filter((n) => /^[a-z_]+$/.test(n));
    expect(toolNames.length).toBeGreaterThanOrEqual(37);
    expect(toolNames).toContain('send_message');
    expect(toolNames).toContain('list_channels');
  });
});
