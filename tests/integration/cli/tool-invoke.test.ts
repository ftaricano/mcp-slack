import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      ...env,
    },
    encoding: 'utf8',
    timeout: 20_000,
  });
}

describe('mcp-slack tool invoke (integration; rehydrate from token store)', () => {
  beforeAll(() => {
    ensureBuild();
  }, 120_000);

  it('rehydrates persisted workspaces so tool invoke does NOT error with "No Slack client found" (Bug X)', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'mcp-tool-invoke-'));
    const tokenPath = join(tmpDir, 'tokens.json');
    // Pre-seed the file token store with a fake installation. The CLI process
    // is fresh — without rehydrate, slackClientManager is empty and every
    // tool dispatch throws "No Slack client found for workspace: T1".
    writeFileSync(
      tokenPath,
      JSON.stringify({
        T1: {
          teamId: 'T1',
          userId: 'U1',
          botToken: 'bot-token-fake-but-shaped-like-real',
          scopes: ['chat:write', 'channels:read', 'users:read'],
          installedAt: Date.now(),
        },
      }),
    );

    try {
      const r = runCli(
        ['tool', 'invoke', 'list_users', '--args', '{"workspace_id":"T1","user_id":"U1"}'],
        {
          SLACK_CLIENT_ID: 'x',
          SLACK_CLIENT_SECRET: 'y',
          SLACK_SIGNING_SECRET: 'z',
          JWT_SECRET: 'a'.repeat(32),
          OAUTH_STATE_SECRET: 'b'.repeat(32),
          MCP_SLACK_TOKEN_STORE_PATH: tokenPath,
        },
      );
      // The fake token will fail downstream at Slack (network or invalid_auth)
      // and the CLI may exit non-zero. The point of Bug X's regression is the
      // workspace IS registered: stderr/stdout must NOT contain the
      // "No Slack client found" string.
      const combined = `${r.stdout}\n${r.stderr}`;
      expect(combined).not.toMatch(/No Slack client found/i);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);
});
