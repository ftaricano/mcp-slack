# Changelog

All notable changes to this project will be documented in this file.

This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
and uses [Conventional Commits](https://www.conventionalcommits.org/).

## [Unreleased]

### Added
- Typed error hierarchy (`SlackMcpError`, `ValidationError`, `AuthError`, `RateLimitError`, `NotFoundError`, `SlackApiError`) with `mapSlackError` normalizer.
- Capability handler wrapping (`_wrap.ts`) for typed errors, automatic retry with exponential backoff, and Prometheus metrics per tool.
- Pluggable token store: in-memory (default) + Redis (`ioredis@5`).
- Slack request signature verification middleware.
- Observability router: `/health`, `/ready`, `/metrics` (prom-client).
- Graceful shutdown with bootstrap factory + 5-second hard-kill timer.
- CLI (`mcp-slack`): `serve`, `http`, `doctor`, `auth login/list/revoke`, `tool list/invoke`.
- 302 tests across 20 suites; coverage thresholds enforced (75/70/50/75).
- Multi-stage Dockerfile (non-root `app` user, `tini` PID 1, `/health` healthcheck).
- `docker-compose.yml` with Redis sidecar.
- GitHub Actions CI matrix (Node 18/20/22).
- `mcp-slack-keychain` macOS helper for loading secrets from Keychain before running the CLI.
- Machine-readable CLI output for `doctor --json`, `auth list --json`, and `tool list --json`.

### Changed
- `PermissionManager.requirePermission` now throws typed `AuthError` instead of generic `Error`.
- Upgraded `@modelcontextprotocol/sdk` to the patched 1.x line and refreshed vulnerable lint dependencies.
- `upload_file` now requires either `content` or an explicitly enabled, root-constrained local file path.
- Structured logs and audit events redact secrets and summarize message/file content before writing.
- Repository metadata and documentation now target `ftaricano/mcp-slack`.

### Deferred (planned for Phase 2.x follow-up)
- Dedupe duplicate Zod schemas in `src/types/slack.ts` (already in `src/utils/validators.ts`).
- Migrate `upload_file` from deprecated Slack `files.upload` to `files.uploadV2`.
