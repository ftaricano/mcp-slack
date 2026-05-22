---
"mcp-slack": minor
---

Initial production-ready release.

- 37 Slack tools exposed via MCP (messaging, channels, users, files)
- Pluggable token store (memory + Redis)
- Typed errors + retry/backoff with rate-limit awareness
- Slack request signature verification middleware
- Prometheus metrics (`/health`, `/ready`, `/metrics`)
- Graceful shutdown
- CLI: `mcp-slack serve | http | doctor | auth | tool`
- 302 tests across 20 suites; coverage gated 75/70/50/75
- Multi-stage Dockerfile (non-root, tini)
- GitHub Actions CI matrix (Node 18/20/22)
