import { Command } from 'commander';

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

export interface AuthListEntry {
  teamId: string;
  installedAt: number;
}

export interface CliDeps {
  serve: () => Promise<void>;
  http: (opts: { port: number }) => Promise<void>;
  doctor: () => Promise<DoctorReport>;
  authLogin: () => Promise<{ url: string }>;
  authList: () => Promise<AuthListEntry[]>;
  authRevoke: (teamId: string) => Promise<void>;
  toolList: () => Promise<string[]>;
  toolInvoke: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

export interface BuildProgramOptions {
  /** stdout/stderr writers — defaults to console. Useful for tests. */
  out?: (line: string) => void;
  err?: (line: string) => void;
  /** when set, print is captured and process.exit is NOT called. Useful for tests. */
  exit?: (code: number) => void;
}

export function buildProgram(
  deps: CliDeps,
  version: string,
  io: BuildProgramOptions = {},
): Command {
  const out = io.out ?? ((line: string) => console.log(line));
  const err = io.err ?? ((line: string) => console.error(line));
  const doExit = io.exit ?? ((code: number) => process.exit(code));

  const program = new Command();
  program.name('mcp-slack').description('Slack MCP server CLI').version(version).exitOverride(); // throw on .exit instead of process.exit; tests + commander both behave

  program
    .command('serve')
    .description('Start the MCP server over stdio (default)')
    .action(async () => {
      await deps.serve();
    });

  program
    .command('http')
    .description('Start the HTTP server (OAuth, /health, /ready, /metrics)')
    .option('-p, --port <port>', 'HTTP port', (v) => parseInt(v, 10), 3000)
    .action(async (opts: { port: number }) => {
      await deps.http({ port: opts.port });
    });

  program
    .command('doctor')
    .description('Validate environment + connectivity')
    .option('--json', 'Print the full doctor report as JSON')
    .action(async (opts: { json?: boolean }) => {
      const report = await deps.doctor();
      if (opts.json) {
        out(JSON.stringify(report, null, 2));
      } else {
        for (const c of report.checks) {
          out(`${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
        }
      }
      doExit(report.ok ? 0 : 1);
    });

  const auth = program.command('auth').description('Manage Slack workspace tokens');
  auth
    .command('login')
    .description('Print the Slack OAuth install URL (diagnostic; see warning below)')
    .action(async () => {
      const { url } = await deps.authLogin();
      // The OAuth state generated here lives in this short-lived process's
      // memory. The /oauth/callback handler in `mcp-slack http` runs in a
      // separate process and will reject the install with "Invalid or
      // expired OAuth state". This command is intended for diagnostics —
      // for production installs, hit the `/oauth/install` endpoint of a
      // running `mcp-slack http` server. Tracked as Bug W; a persistent
      // state-store backend is the proper Phase-3 fix.
      err(
        'WARNING: this URL is only valid in the current process. For production installs, use the /oauth/install endpoint of a running mcp-slack http server.',
      );
      out(url);
    });
  auth
    .command('list')
    .description('List installed Slack workspaces')
    .option('--json', 'Print workspace installs as JSON')
    .action(async (opts: { json?: boolean }) => {
      const list = await deps.authList();
      if (opts.json) {
        out(JSON.stringify(list, null, 2));
        return;
      }
      if (list.length === 0) {
        out('(no workspaces)');
        return;
      }
      for (const w of list) {
        out(`${w.teamId}\tinstalled=${new Date(w.installedAt).toISOString()}`);
      }
    });
  auth
    .command('revoke <teamId>')
    .description('Revoke + remove a workspace from the token store')
    .action(async (teamId: string) => {
      await deps.authRevoke(teamId);
      out(`revoked ${teamId}`);
    });

  const tool = program.command('tool').description('Inspect / invoke registered MCP tools');
  tool
    .command('list')
    .description('Print registered tool names, one per line')
    .option('--json', 'Print registered tool names as JSON')
    .action(async (opts: { json?: boolean }) => {
      const list = await deps.toolList();
      if (opts.json) {
        out(JSON.stringify(list, null, 2));
        return;
      }
      for (const n of list) out(n);
    });
  tool
    .command('invoke <name>')
    .description('Invoke a tool with JSON args from --args or stdin')
    .option('-a, --args <json>', 'JSON arguments object')
    .action(async (name: string, opts: { args?: string }) => {
      const raw = opts.args ?? (await readStdin());
      let args: Record<string, unknown>;
      try {
        args = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch (parseErr) {
        err(`Invalid JSON for --args/stdin: ${(parseErr as Error).message}`);
        doExit(1);
        return;
      }
      const result = await deps.toolInvoke(name, args);
      out(JSON.stringify(result, null, 2));
    });

  // suppress raw error noise from .exitOverride in production CLI
  program.exitOverride((cliErr) => {
    if (cliErr.code === 'commander.helpDisplayed' || cliErr.code === 'commander.version') {
      return; // help / version already printed; no exit
    }
    if (cliErr.message) err(cliErr.message);
    doExit(cliErr.exitCode ?? 1);
  });

  return program;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}
