#!/usr/bin/env bash
set -euo pipefail

# macOS helper: load mcp-slack secrets from Keychain, then run the normal CLI.
# Cross-platform users should set environment variables directly and call
# `mcp-slack`.

if ! command -v security >/dev/null 2>&1; then
  echo "mcp-slack-keychain: macOS security(1) command not found" >&2
  exit 2
fi

KEYCHAIN_ACCOUNT="${MCP_SLACK_KEYCHAIN_ACCOUNT:-jarvis}"

kc() {
  security find-generic-password -a "$KEYCHAIN_ACCOUNT" -s "$1" -w 2>/dev/null
}

load_required() {
  local var_name="$1"
  local service_name="$2"
  if [[ -n "${!var_name:-}" ]]; then
    return
  fi
  local value
  if ! value="$(kc "$service_name")"; then
    echo "mcp-slack-keychain: missing Keychain item service=$service_name account=$KEYCHAIN_ACCOUNT for $var_name" >&2
    exit 2
  fi
  export "$var_name=$value"
}

load_optional() {
  local var_name="$1"
  local service_name="$2"
  if [[ -n "${!var_name:-}" ]]; then
    return
  fi
  local value
  if value="$(kc "$service_name")"; then
    export "$var_name=$value"
  fi
}

load_required SLACK_CLIENT_ID "${MCP_SLACK_KEYCHAIN_SLACK_CLIENT_ID_SERVICE:-openclaw::SLACK_CLIENT_ID}"
load_required SLACK_CLIENT_SECRET "${MCP_SLACK_KEYCHAIN_SLACK_CLIENT_SECRET_SERVICE:-openclaw::SLACK_CLIENT_SECRET}"
load_required SLACK_SIGNING_SECRET "${MCP_SLACK_KEYCHAIN_SLACK_SIGNING_SECRET_SERVICE:-openclaw::SLACK_SIGNING_SECRET}"
load_required JWT_SECRET "${MCP_SLACK_KEYCHAIN_JWT_SECRET_SERVICE:-mcp::SLACK_JWT_SECRET}"
load_required OAUTH_STATE_SECRET "${MCP_SLACK_KEYCHAIN_OAUTH_STATE_SECRET_SERVICE:-mcp::SLACK_OAUTH_STATE_SECRET}"
load_optional SLACK_BOT_TOKEN "${MCP_SLACK_KEYCHAIN_SLACK_BOT_TOKEN_SERVICE:-openclaw::SLACK_BOT_TOKEN}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$HERE/mcp-slack.js" "$@"
