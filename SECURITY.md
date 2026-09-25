# Security Policy

## Reporting a vulnerability

Please report security issues privately through GitHub private vulnerability reporting:

- <https://github.com/ftaricano/mcp-slack/security/advisories/new>

(Repository **Security** tab → **Report a vulnerability**.)

Include:

- A clear description of the issue and its impact.
- Reproduction steps (or a proof-of-concept).
- The affected version(s) / commit SHA.
- Whether the issue is publicly known.

Expect an initial response within **5 business days**. Please do not file public GitHub issues for vulnerabilities; coordinated disclosure protects existing deployments.

## Supported versions

| Version | Supported          |
| ------- | ------------------ |
| 1.x     | Yes                |
| < 1.0   | No                 |

Security fixes land on the latest minor of the supported major.

## Threat model

`mcp-slack` is designed to run as a stdio MCP server in trusted process space, optionally augmented by an HTTP listener that handles OAuth callbacks and exposes observability endpoints. The current threat model assumes:

- **Inbound webhook authenticity** is verified using Slack's request-signing protocol (`SLACK_SIGNING_SECRET`). Requests with missing, malformed, or expired signatures are rejected.
- **Client session tokens** issued after the OAuth callback are JWTs signed with `JWT_SECRET`. The server never accepts unsigned tokens.
- **OAuth CSRF** is mitigated with an HMAC-signed `state` parameter (`OAUTH_STATE_SECRET`). State values are time-bound and single-use.
- **Token storage backends** are pluggable. The default local file store is intended for single-machine development. Production or multi-process deployments should use the Redis-backed store. Slack tokens are redacted before any structured log or audit event is written.
- **Outbound traffic** goes only to `slack.com`. The MCP server does not call arbitrary URLs supplied by tool callers.
- **Local file uploads** are disabled by default. Operators must explicitly set `MCP_SLACK_ALLOW_FILE_PATH_UPLOADS=true` and constrain reads with `MCP_SLACK_FILE_UPLOAD_ROOT`.

Out of scope today: multi-tenant isolation guarantees beyond per-workspace token scoping, and protection against compromised host environments.

## Hardening recommendations (production)

- **Rotate `JWT_SECRET` and `OAUTH_STATE_SECRET` quarterly.** Both must be ≥32 characters of high-entropy randomness; `mcp-slack doctor` rejects shorter values.
- **Terminate TLS upstream.** Run the HTTP listener behind an HTTPS-terminating proxy (nginx, Caddy, AWS ALB, Cloudflare). The server itself does not terminate TLS.
- **Keep stdio-only when possible.** Set `ENABLE_HTTP_SERVER=true` only when you actively need to serve OAuth callbacks or observability. For Claude Code installs, stdio alone is enough.
- **Use Redis with auth + TLS.** When `REDIS_URL` is set, point at a Redis instance that requires `AUTH` and accepts only TLS connections. Never expose Redis to the public internet.
- **Pin Docker images by digest.** In production, reference the image by its `sha256:` digest, not `:latest`. Re-pin during scheduled upgrades after reviewing the changelog.
- **Restrict OAuth scopes.** Grant the Slack app only the scopes you actually use. Excess scopes increase blast radius if a token leaks.
- **Audit log retention.** The audit channel emits structured JSON with redacted secrets and summarized message/file content; ship it to an immutable sink (CloudWatch, GCP Logging, Loki) and retain per your compliance requirements.

## Dependency hygiene

- `npm audit` is run in CI on every push.
- Major dependency upgrades are reviewed manually; lockfile updates accompany the PR that triggers them.
- A `dep-scout` integration is planned to surface advisories on a faster cadence than scheduled `npm audit`.
