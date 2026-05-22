# mcp-slack

> Production-grade Model Context Protocol server for Slack — 37 tools, OAuth 2.0, typed errors, safe file uploads, retry/backoff, Prometheus metrics, and a first-class CLI.

[![CI](https://github.com/ftaricano/mcp-slack/actions/workflows/ci.yml/badge.svg)](https://github.com/ftaricano/mcp-slack/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)
![MCP](https://img.shields.io/badge/MCP-compatible-8A2BE2.svg)

`mcp-slack` exposes the Slack Web API as a stdio MCP server you can plug straight into Claude Code (or any MCP-compatible client). It is built for unattended workloads: every capability handler runs through a typed wrapper that handles retries, rate limits, error mapping, and Prometheus metrics.

---

## Features

- **37 Slack tools** across messaging, channels, users, and files — all surfaced as MCP tools.
- **OAuth 2.0 install flow** with HMAC-signed `state` and JWT-signed session tokens.
- **Pluggable token store** — in-memory by default; Redis (`ioredis@5`) for production.
- **Safe file upload defaults** — text uploads work by default; local path uploads require explicit opt-in plus a root allowlist.
- **Typed error hierarchy** (`SlackMcpError`, `ValidationError`, `AuthError`, `RateLimitError`, `NotFoundError`, `SlackApiError`) with `mapSlackError` normalizer.
- **Automatic retry/backoff** with rate-limit awareness (honors `Retry-After`).
- **Slack request signature verification** middleware for inbound webhooks.
- **Observability** out of the box: `/health`, `/ready`, `/metrics` (prom-client) on the optional HTTP listener.
- **Graceful shutdown** via a bootstrap factory + 5-second hard-kill timer.
- **First-class CLI** — `mcp-slack serve | http | doctor | auth | tool`.
- **300+ tests** across unit and integration suites; coverage thresholds enforced (lines 75 / branches 70 / functions 50 / statements 75).

---

## Requirements

- Node.js 18, 20, or 22.
- Slack app credentials: `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, and `SLACK_SIGNING_SECRET`.
- High-entropy `JWT_SECRET` and `OAUTH_STATE_SECRET` values with at least 32 characters.
- Redis for production OAuth/token persistence, or the default local file store for single-machine development.

---

## Install

```bash
npm install -g mcp-slack
# or
git clone https://github.com/ftaricano/mcp-slack.git
cd mcp-slack
npm ci
npm run build
```

Node 18, 20, and 22 are tested in CI.

---

## CLI quickstart

```bash
# Validate config + secrets
mcp-slack doctor
mcp-slack doctor --json

# Run the stdio MCP server (default for Claude Code)
mcp-slack serve

# Run the HTTP listener (OAuth + observability)
mcp-slack http --port 3000

# OAuth (DIAGNOSTIC): print an install URL.
#   NOTE: state generated here lives in this CLI process only. A real
#   /oauth/callback redirect is handled by a different process (`mcp-slack
#   http`) which has its own state store, so the install will be rejected.
#   For production installs, use the `/oauth/install` endpoint of a
#   running `mcp-slack http` server instead.
mcp-slack auth login

# List every registered MCP tool
mcp-slack tool list
mcp-slack tool list --json

# Invoke a tool directly without an MCP client
mcp-slack tool invoke send_message \
  --args '{"workspace_id":"T1","user_id":"U1","channel":"C123","text":"hi"}'
```

`mcp-slack doctor` is the canonical preflight: it checks env vars, secret lengths, redirect URI shape, and Redis reachability when configured.

On macOS, `mcp-slack-keychain` can load secrets from Keychain and then delegate to the normal CLI. It defaults to account `jarvis` and service names such as `openclaw::SLACK_CLIENT_ID`; override each service with `MCP_SLACK_KEYCHAIN_*_SERVICE` env vars when using a different local convention. This helper is intentionally macOS-only; cross-platform deployments should set environment variables directly.

---

## MCP integration (Claude Code)

```jsonc
{
  "mcpServers": {
    "slack": {
      "command": "mcp-slack",
      "args": ["serve"],
      "env": {
        "SLACK_CLIENT_ID": "…",
        "SLACK_CLIENT_SECRET": "…",
        "SLACK_SIGNING_SECRET": "…",
        "JWT_SECRET": "32+ char random string",
        "OAUTH_STATE_SECRET": "32+ char random string"
      }
    }
  }
}
```

Restart Claude Code after editing the config. Use `mcp-slack tool list` to confirm the binary works in isolation.

---

## Configuration

| Name                  | Required | Default                                       | Purpose                                                                              |
| --------------------- | -------- | --------------------------------------------- | ------------------------------------------------------------------------------------ |
| `SLACK_CLIENT_ID`     | yes      | —                                             | Slack app client ID (OAuth).                                                         |
| `SLACK_CLIENT_SECRET` | yes      | —                                             | Slack app client secret (OAuth).                                                     |
| `SLACK_SIGNING_SECRET`| yes      | —                                             | Used to verify inbound Slack request signatures.                                     |
| `JWT_SECRET`          | yes      | —                                             | Signs client session tokens issued after OAuth callback. Must be ≥32 chars.          |
| `OAUTH_STATE_SECRET`  | yes      | —                                             | HMAC key for the OAuth `state` parameter (CSRF guard). Must be ≥32 chars.            |
| `ENABLE_HTTP_SERVER`  | no       | `false`                                       | When `true`, starts the HTTP listener (OAuth callback + `/health` `/ready` `/metrics`). |
| `PORT`                | no       | `3000`                                        | HTTP listener port (only used when `ENABLE_HTTP_SERVER=true`).                       |
| `OAUTH_REDIRECT_URI`  | no       | `http://localhost:3000/oauth/callback`        | OAuth redirect URI; must match the Slack app config exactly.                         |
| `LOG_LEVEL`           | no       | `info`                                        | `trace` \| `debug` \| `info` \| `warn` \| `error`.                                   |
| `NODE_ENV`            | no       | `development`                                 | `development` exposes detailed error messages on the HTTP listener.                  |
| `ALLOWED_ORIGINS`     | no       | `http://localhost:3000`                       | Comma-separated CORS origins for the HTTP listener.                                  |
| `MCP_SERVER_NAME`     | no       | `mcp-slack`                                   | Advertised MCP server name.                                                          |
| `MCP_SERVER_VERSION`  | no       | `1.0.0`                                       | Advertised MCP server version.                                                       |
| `SLACK_SCOPES`        | no       | (built-in)                                    | CLI-only override for the OAuth scope list emitted by `mcp-slack auth login`.        |
| `REDIS_URL`           | no       | —                                             | Enables Redis-backed token storage for production and multi-process installs.        |
| `MCP_SLACK_TOKEN_STORE_PATH` | no | `~/.config/mcp-slack/tokens.json`             | Local JSON token store path when `REDIS_URL` is not set. Use `:memory:` for tests.   |
| `MCP_SLACK_ALLOW_FILE_PATH_UPLOADS` | no | `false`                              | Enables local file path uploads. Keep disabled unless the MCP client is trusted.     |
| `MCP_SLACK_FILE_UPLOAD_ROOT` | no | —                                             | Required when path uploads are enabled; every uploaded path must resolve inside it.  |
| `MCP_SLACK_MAX_FILE_UPLOAD_BYTES` | no | `10485760`                              | Maximum local file path upload size in bytes.                                        |
| `AUDIT_LOG_PATH`      | no       | `./logs/audit.log`                            | Structured audit log path. Sensitive fields are redacted before write.               |

---

## Tool reference

37 tools, grouped by capability domain. Scopes shown reflect the entries in `src/auth/permissions.ts` (`OPERATION_PERMISSIONS`); tools without an explicit entry inherit the broader workspace scope set granted at install time.

### Messages (8)

| Tool                    | Description                                                  | Scope                |
| ----------------------- | ------------------------------------------------------------ | -------------------- |
| `send_message`          | Post a message to a channel, DM, or thread.                  | `chat:write`         |
| `update_message`        | Edit an existing message by `ts`.                            | `chat:write`         |
| `delete_message`        | Delete a message by `ts`.                                    | `chat:write`         |
| `get_channel_history`   | Fetch recent messages from a conversation.                   | `channels:history`   |
| `search_messages`       | Search across messages the bot can see.                      | `search:read`        |
| `add_reaction`          | Add an emoji reaction to a message.                          | `reactions:write`    |
| `remove_reaction`       | Remove an emoji reaction from a message.                     | `reactions:write`    |
| `get_message_permalink` | Resolve a permalink for a given message timestamp.           | `chat:write`         |

### Channels (11)

| Tool                  | Description                                                  | Scope             |
| --------------------- | ------------------------------------------------------------ | ----------------- |
| `list_channels`       | List public/private channels in the workspace.               | `channels:read`   |
| `create_channel`      | Create a new public or private channel.                      | `channels:write`  |
| `get_channel_info`    | Fetch metadata for a single channel.                         | `channels:read`   |
| `join_channel`        | Add the bot to a channel.                                    | `channels:write`  |
| `leave_channel`       | Remove the bot from a channel.                               | `channels:write`  |
| `archive_channel`     | Archive a channel.                                           | `channels:write`  |
| `unarchive_channel`   | Unarchive a previously archived channel.                     | `channels:write`  |
| `set_channel_topic`   | Update the channel topic.                                    | `channels:write`  |
| `set_channel_purpose` | Update the channel purpose.                                  | `channels:write`  |
| `invite_to_channel`   | Invite one or more users to a channel.                       | `channels:write`  |
| `get_channel_members` | List members of a channel.                                   | `channels:read`   |

### Users (10)

| Tool                      | Description                                              | Scope         |
| ------------------------- | -------------------------------------------------------- | ------------- |
| `list_users`              | List users in the workspace.                             | `users:read`  |
| `get_user_info`           | Fetch a single user record.                              | `users:read`  |
| `get_user_presence`       | Get a user's presence (`active` / `away`).               | `users:read`  |
| `set_user_status`         | Set the bot or authed user's custom status.              | `users:write` |
| `get_user_profile`        | Fetch a user's full profile object.                      | `users:read`  |
| `set_user_presence`       | Set the authed user's presence.                          | `users:write` |
| `lookup_user_by_email`    | Find a user by email address.                            | `users:read.email` |
| `get_user_groups`         | List user groups (subteams) in the workspace.            | `usergroups:read` |
| `get_user_conversations`  | List conversations a user belongs to.                    | `users:read`  |
| `get_team_info`           | Fetch workspace metadata.                                | `team:read`   |

### Files (8)

| Tool                     | Description                                                  | Scope          |
| ------------------------ | ------------------------------------------------------------ | -------------- |
| `upload_file`            | Upload a file to one or more channels.                       | `files:write`  |
| `get_file_info`          | Fetch metadata for a file.                                   | `files:read`   |
| `list_files`             | List files visible to the bot.                               | `files:read`   |
| `delete_file`            | Delete a file by id.                                         | `files:write`  |
| `share_file`             | Share an existing file to another channel.                   | `files:write`  |
| `add_file_comment`       | Post a comment on a file.                                    | `files:write`  |
| `get_file_comments`      | List comments on a file.                                     | `files:read`   |
| `revoke_file_public_url` | Revoke a previously enabled public URL for a file.           | `files:write`  |

## Architecture

```
Claude Code ─┐
             ├── stdio MCP ──┐
Other MCP    ┘                │
                               ▼
                      SlackMCPServer
                       │
         ┌─────────────┼──────────────┐
         ▼             ▼              ▼
    Capabilities  ObservabilityRouter  OAuth + TokenStore
    (37 tools)    (/health,/ready,    (Memory | Redis)
                   /metrics)
         │
         ▼
    _wrap.ts (retry + typed errors + metrics)
         │
         ▼
    SlackClientManager → @slack/web-api
```

`bootstrap()` wires every component, registers SIGINT/SIGTERM handlers, and returns a handle whose `.stop()` performs a graceful shutdown (with a 5-second hard-kill timer as a backstop).

---

## Development

```bash
git clone https://github.com/ftaricano/mcp-slack.git
cd mcp-slack
npm install
npm run validate          # lint + typecheck + unit tests
npm run test:coverage     # full suite with coverage report
```

Husky + lint-staged auto-fix staged TypeScript on commit (`prettier --write`, `eslint --fix`). The pre-commit hook is installed by `npm install` via the `prepare` script.

Common scripts:

| Script                  | What it does                                                  |
| ----------------------- | ------------------------------------------------------------- |
| `npm run dev`           | Run the server with `tsx` (hot TS execution).                 |
| `npm run build`         | Type-check + emit to `dist/`.                                 |
| `npm run lint`          | ESLint over `src/` and `tests/`.                              |
| `npm run typecheck`     | `tsc --noEmit`.                                               |
| `npm test`              | Jest (all suites).                                            |
| `npm run test:unit`     | Jest unit suites only.                                        |
| `npm run test:coverage` | Jest with coverage; thresholds enforced.                      |
| `npm run format:check`  | Prettier in check mode (CI gate).                             |

---

## Docker

```bash
docker build -t mcp-slack .
docker compose up
```

The provided `docker-compose.yml` boots the server alongside a Redis sidecar for the production token store. The compose file wires `REDIS_URL=redis://redis:6379` into the app service automatically, so installs persist across recreates via the `redis-data` named volume. Required Slack/JWT env vars (`SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`, `JWT_SECRET`, `OAUTH_STATE_SECRET` — same set listed under [Configuration](#configuration)) must be present in `.env`. The image is multi-stage, runs as the non-root `app` user under `tini`, and ships with a `/health` healthcheck.

See [`Dockerfile`](./Dockerfile) and [`docker-compose.yml`](./docker-compose.yml).

---

## Security

- Never commit `.env`, token store files, `logs/`, `dist/`, `node_modules/`, or local MCP client configs.
- `upload_file` accepts text `content` by default. Local filesystem uploads are disabled unless `MCP_SLACK_ALLOW_FILE_PATH_UPLOADS=true` and `MCP_SLACK_FILE_UPLOAD_ROOT` are set.
- Logs and audit events redact token/secret fields and summarize message/file content instead of writing raw Slack payload text.
- If a credential leaks, revoke it in the Slack app dashboard, rotate `JWT_SECRET` / `OAUTH_STATE_SECRET`, remove local token stores, and review `logs/` before sharing artifacts.
- Please report vulnerabilities privately via [GitHub Security Advisories](https://github.com/ftaricano/mcp-slack/security/advisories/new) or the contact listed in [`SECURITY.md`](./SECURITY.md).

---

## Contributing

Run `npm run validate`, `npm run format:check`, and `npm run build` before opening a PR. See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for conventions and test expectations.

---

## License

[MIT](./LICENSE) © 2026 Fernando Taricano.
