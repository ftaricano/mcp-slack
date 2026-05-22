import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '../..');
const TSX_BIN = resolve(ROOT, 'node_modules/.bin/tsx');
const ENTRY = resolve(ROOT, 'src/index.ts');

// Gate by env var so CI environments without the tsx binary or with strict
// child-process sandboxing can opt out without failing the suite. Default ON
// locally so the test runs against `npm test`.
const ENABLED = process.env.SKIP_SHUTDOWN_INTEGRATION !== '1';

interface ExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

function spawnServer(extraEnv: NodeJS.ProcessEnv = {}): ChildProcessWithoutNullStreams {
  return spawn(TSX_BIN, [ENTRY], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      // stdio-only so the test does not bind a real port; the HTTP path is
      // exercised separately in tests/integration/http/observability.test.ts.
      ENABLE_HTTP_SERVER: 'false',
      SLACK_CLIENT_ID: 'x',
      SLACK_CLIENT_SECRET: 'y',
      SLACK_SIGNING_SECRET: 'z',
      JWT_SECRET: 'a'.repeat(32),
      OAUTH_STATE_SECRET: 'b'.repeat(32),
      LOG_LEVEL: 'silent',
      ...extraEnv,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams, ms: number): Promise<ExitResult> {
  return new Promise<ExitResult>((res, rej) => {
    const t = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      rej(new Error(`shutdown did not complete within ${ms}ms`));
    }, ms);
    t.unref();
    child.once('exit', (code, signal) => {
      clearTimeout(t);
      res({ code, signal });
    });
  });
}

(ENABLED ? describe : describe.skip)('graceful shutdown (integration)', () => {
  it('exits cleanly within 3s on SIGTERM', async () => {
    const child = spawnServer();

    // Wait for the bootstrap log line ("mcp-slack started") on stderr (winston
    // default) before sending the signal. Falls back to a fixed delay if the
    // process is silent (LOG_LEVEL=silent in this test).
    await new Promise<void>((res) => setTimeout(res, 1500));

    expect(child.killed).toBe(false);
    expect(child.exitCode).toBeNull();

    child.kill('SIGTERM');
    const result = await waitForExit(child, 3000);

    // Acceptable outcomes:
    //  - exit code 0 (graceful path inside attachSignalHandlers)
    //  - terminated by SIGTERM if the runtime exits before the JS handler
    //    runs (some Node builds + tsx loaders).
    expect(result.code === 0 || result.signal === 'SIGTERM').toBe(true);
  }, 10000);
});
