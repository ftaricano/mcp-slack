# Contributing to mcp-slack

Thanks for your interest in improving `mcp-slack`. This document captures the workflow, conventions, and quality bars the project enforces.

## Branching

- Cut feature branches from `main` as `feat/<short-slug>`.
- Cut bug-fix branches from `main` as `fix/<short-slug>`.
- Use `chore/`, `docs/`, `test/`, `ci/`, `refactor/` prefixes for non-feature work.
- Keep branches focused; one logical change per PR.

## Commit conventions

The project follows [Conventional Commits](https://www.conventionalcommits.org/). Allowed types:

| Type      | Use for                                                            |
| --------- | ------------------------------------------------------------------ |
| `feat:`   | New user-visible functionality.                                    |
| `fix:`    | Bug fixes.                                                         |
| `chore:`  | Tooling, dependency bumps, release scaffolding.                    |
| `test:`   | Test-only changes (no production code change).                     |
| `docs:`   | Documentation only.                                                |
| `ci:`     | Build / pipeline changes.                                          |
| `refactor:` | Behavior-preserving code restructuring.                          |

Subject line is imperative, lowercase, ≤72 chars. Body explains the *why* when it isn't obvious.

**Do not** add `Co-Authored-By: Claude …` or "Generated with Claude Code" footers. The project's commit history is human-attributed.

## Pre-commit

`npm install` provisions husky + lint-staged via the `prepare` script. On every commit:

- `prettier --write` formats staged `*.ts` and `*.md`.
- `eslint --fix` auto-corrects ESLint findings on staged `*.ts`.

If a lint or format step cannot auto-fix, the commit is blocked until you address the issue.

## Test and lint commands

```bash
npm run validate          # lint + typecheck + unit suites (CI parity for fast feedback)
npm run lint              # ESLint
npm run typecheck         # tsc --noEmit
npm test                  # full Jest run
npm run test:unit         # unit suites only
npm run test:integration  # integration suites
npm run test:coverage     # full run with coverage gate
npm run format:check      # Prettier in check mode (CI gate)
```

CI runs `lint`, `typecheck`, `test`, and `build` against Node 18, 20, and 22. PRs land green.

## Adding a new MCP tool

1. **Schema.** Define a Zod schema in `src/utils/validators.ts` (or inline in the capability file when the tool's input is small). Reuse existing primitives (`workspaceIdSchema`, `userIdSchema`, etc.) where possible.
2. **Register the tool.** In the appropriate capability file (`src/capabilities/messages.ts`, `channels.ts`, `users.ts`, or `files.ts`), add:
   ```ts
   server.registerTool(
     {
       name: 'tool_name',
       description: 'One sentence describing what the tool does.',
       inputSchema: { /* JSON schema mirroring the Zod schema */ },
     },
     wrap('tool_name', async (args) => {
       // Implementation
     }),
   );
   ```
   The `wrap()` helper from `src/capabilities/_wrap.ts` provides typed-error mapping, retry/backoff, and Prometheus metrics. Never call Slack directly from an unwrapped handler.
3. **Permissions.** Add an entry to `OPERATION_PERMISSIONS` in `src/auth/permissions.ts` so `permission_check` audit events are emitted with the correct required scope.
4. **Tests.** Add unit tests in `tests/unit/capabilities/<file>.test.ts` covering success, validation failure, and at least one Slack error path (`SlackApiError`, `RateLimitError`, or `AuthError` as appropriate). Mock `slackClientManager.apiCall`.

Run `npm run validate` before opening the PR.

## Coverage thresholds

Current Jest thresholds (`jest.config.js`):

- lines: **75%**
- branches: **70%**
- functions: **50%**
- statements: **75%**

The `functions` threshold is intentionally lower while Phase-2 follow-ups land (see `CHANGELOG.md` → "Deferred"). Raise it only in the same PR that adds the missing branch/function coverage that justifies the stricter gate.

## DCO

By submitting a pull request, you certify the [Developer Certificate of Origin](https://developercertificate.org/). Sign-off is not strictly required by CI, but the maintainers may ask for it on substantial contributions.
