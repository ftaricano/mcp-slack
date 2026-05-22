import { jest } from '@jest/globals';

import { buildProgram, type CliDeps } from '../../../src/cli/program.js';

function makeDeps(
  overrides: Partial<CliDeps> = {},
): CliDeps & { spies: Record<keyof CliDeps, jest.Mock> } {
  const spies = {
    serve: jest.fn(async () => undefined),
    http: jest.fn(async () => undefined),
    doctor: jest.fn(async () => ({ ok: true, checks: [{ name: 'env:JWT_SECRET', ok: true }] })),
    authLogin: jest.fn(async () => ({ url: 'https://slack.com/oauth/v2/authorize?x=1' })),
    authList: jest.fn(async () => [{ teamId: 'T1', installedAt: 1700000000000 }]),
    authRevoke: jest.fn(async () => undefined),
    toolList: jest.fn(async () => ['send_message', 'list_channels']),
    toolInvoke: jest.fn(async () => ({ ok: true })),
    ...overrides,
  } as any;
  return { ...spies, spies } as any;
}

function makeIo() {
  const out: string[] = [];
  const err: string[] = [];
  const exitCalls: number[] = [];
  return {
    out: (l: string) => out.push(l),
    err: (l: string) => err.push(l),
    exit: (c: number) => exitCalls.push(c),
    captured: { out, err, exitCalls },
  };
}

interface Captured {
  out: string[];
  err: string[];
  exitCalls: number[];
}

async function run(
  argv: string[],
  deps?: any,
  io?: any,
): Promise<{ deps: any; captured: Captured }> {
  const d = deps ?? makeDeps();
  const i = io ?? makeIo();
  const program = buildProgram(d, '0.0.0-test', { out: i.out, err: i.err, exit: i.exit });
  await program.parseAsync(['node', 'mcp-slack', ...argv]);
  return { deps: d, captured: i.captured as Captured };
}

describe('buildProgram — basic shape', () => {
  it('exposes name + version', () => {
    const program = buildProgram(makeDeps(), '1.2.3');
    expect(program.name()).toBe('mcp-slack');
    expect(program.version()).toBe('1.2.3');
  });

  it('lists all top-level commands', () => {
    const program = buildProgram(makeDeps(), '0.0.0');
    const names = program.commands.map((c) => c.name()).sort();
    expect(names).toEqual(['auth', 'doctor', 'http', 'serve', 'tool']);
  });

  it('auth subcommands', () => {
    const program = buildProgram(makeDeps(), '0.0.0');
    const auth = program.commands.find((c) => c.name() === 'auth')!;
    expect(auth.commands.map((c) => c.name()).sort()).toEqual(['list', 'login', 'revoke']);
  });

  it('tool subcommands', () => {
    const program = buildProgram(makeDeps(), '0.0.0');
    const tool = program.commands.find((c) => c.name() === 'tool')!;
    expect(tool.commands.map((c) => c.name()).sort()).toEqual(['invoke', 'list']);
  });
});

describe('serve', () => {
  it('calls deps.serve()', async () => {
    const { deps } = await run(['serve']);
    expect(deps.spies.serve).toHaveBeenCalled();
  });
});

describe('http', () => {
  it('uses default port 3000', async () => {
    const { deps } = await run(['http']);
    expect(deps.spies.http).toHaveBeenCalledWith({ port: 3000 });
  });
  it('parses --port', async () => {
    const { deps } = await run(['http', '--port', '4040']);
    expect(deps.spies.http).toHaveBeenCalledWith({ port: 4040 });
  });
  it('parses -p shorthand', async () => {
    const { deps } = await run(['http', '-p', '5050']);
    expect(deps.spies.http).toHaveBeenCalledWith({ port: 5050 });
  });
});

describe('doctor', () => {
  it('prints all checks and exits 0 when ok', async () => {
    const deps = makeDeps({
      doctor: jest.fn(async () => ({
        ok: true,
        checks: [
          { name: 'env:JWT_SECRET', ok: true },
          { name: 'env:OAUTH_STATE_SECRET', ok: true, detail: 'set' },
        ],
      })) as any,
    });
    const { captured } = await run(['doctor'], deps);
    expect(captured.out.some((l) => l.startsWith('✓ env:JWT_SECRET'))).toBe(true);
    expect(captured.out.some((l) => l.includes('✓ env:OAUTH_STATE_SECRET'))).toBe(true);
    expect(captured.out.some((l) => l.includes('— set'))).toBe(true);
    expect(captured.exitCalls).toEqual([0]);
  });

  it('exits 1 when any check fails', async () => {
    const deps = makeDeps({
      doctor: jest.fn(async () => ({
        ok: false,
        checks: [
          { name: 'env:SLACK_CLIENT_ID', ok: false, detail: 'not set' },
          { name: 'env:JWT_SECRET', ok: true },
        ],
      })) as any,
    });
    const { captured } = await run(['doctor'], deps);
    expect(captured.out.some((l) => l.startsWith('✗ env:SLACK_CLIENT_ID'))).toBe(true);
    expect(captured.exitCalls).toEqual([1]);
  });

  it('prints JSON when requested', async () => {
    const { captured } = await run(['doctor', '--json']);
    expect(JSON.parse(captured.out.join('\n'))).toMatchObject({ ok: true });
    expect(captured.exitCalls).toEqual([0]);
  });
});

describe('auth login', () => {
  it('prints the install URL', async () => {
    const { captured } = await run(['auth', 'login']);
    expect(captured.out).toEqual(['https://slack.com/oauth/v2/authorize?x=1']);
  });

  it('emits a warning to stderr explaining state is process-local (Bug W)', async () => {
    const { captured } = await run(['auth', 'login']);
    expect(captured.err.join('\n')).toMatch(/WARNING.*process.*\/oauth\/install/i);
  });
});

describe('auth list', () => {
  it('prints team rows', async () => {
    const { captured } = await run(['auth', 'list']);
    expect(captured.out).toHaveLength(1);
    expect(captured.out[0]).toMatch(/^T1\tinstalled=/);
  });

  it('prints "(no workspaces)" when empty', async () => {
    const deps = makeDeps({ authList: jest.fn(async () => []) as any });
    const { captured } = await run(['auth', 'list'], deps);
    expect(captured.out).toEqual(['(no workspaces)']);
  });

  it('prints JSON when requested', async () => {
    const { captured } = await run(['auth', 'list', '--json']);
    expect(JSON.parse(captured.out.join('\n'))).toEqual([
      { teamId: 'T1', installedAt: 1700000000000 },
    ]);
  });
});

describe('auth revoke', () => {
  it('calls deps.authRevoke and confirms', async () => {
    const { deps, captured } = await run(['auth', 'revoke', 'T1']);
    expect(deps.spies.authRevoke).toHaveBeenCalledWith('T1');
    expect(captured.out).toEqual(['revoked T1']);
  });
});

describe('tool list', () => {
  it('prints names one per line', async () => {
    const { captured } = await run(['tool', 'list']);
    expect(captured.out).toEqual(['send_message', 'list_channels']);
  });

  it('prints JSON when requested', async () => {
    const { captured } = await run(['tool', 'list', '--json']);
    expect(JSON.parse(captured.out.join('\n'))).toEqual(['send_message', 'list_channels']);
  });
});

describe('tool invoke', () => {
  it('parses --args JSON and prints result', async () => {
    const { deps, captured } = await run([
      'tool',
      'invoke',
      'send_message',
      '--args',
      '{"channel":"C1","text":"hi"}',
    ]);
    expect(deps.spies.toolInvoke).toHaveBeenCalledWith('send_message', {
      channel: 'C1',
      text: 'hi',
    });
    expect(captured.out.join('\n')).toContain('"ok": true');
  });

  it('parses -a shorthand', async () => {
    const { deps } = await run(['tool', 'invoke', 'send_message', '-a', '{"x":1}']);
    expect(deps.spies.toolInvoke).toHaveBeenCalledWith('send_message', { x: 1 });
  });

  it('falls back to empty object when no args provided and stdin is a TTY', async () => {
    const originalIsTTY = (process.stdin as any).isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    try {
      const { deps } = await run(['tool', 'invoke', 'send_message']);
      expect(deps.spies.toolInvoke).toHaveBeenCalledWith('send_message', {});
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    }
  });

  it('exits 1 with a clear error for invalid JSON args', async () => {
    const { deps, captured } = await run(['tool', 'invoke', 'send_message', '--args', '{bad']);
    expect(deps.spies.toolInvoke).not.toHaveBeenCalled();
    expect(captured.err.join('\n')).toMatch(/Invalid JSON/);
    expect(captured.exitCalls).toEqual([1]);
  });
});
