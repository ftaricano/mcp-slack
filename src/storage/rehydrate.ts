import type { SlackTokens } from '../types/slack.js';
import { logger } from '../utils/logger.js';
import { slackClientManager } from '../utils/slack-client.js';

import type { InstalledToken, TokenStore } from './token-store.js';

export interface RehydrationResult {
  count: number;
  degraded: boolean;
  error?: string;
}

/**
 * Replay every persisted installation into the in-memory
 * {@link slackClientManager} so tool calls work immediately after a restart.
 *
 * Without this, `auth list` will show persisted teamIds but every tool call
 * fails with `No Slack client found for workspace: <teamId>` until the next
 * /oauth/callback re-registers them.
 *
 * Returns a {@link RehydrationResult}: `degraded=true` when the underlying
 * store is unavailable (e.g. Redis ECONNREFUSED) so callers (e.g. /ready) can
 * surface 503 instead of falsely reporting healthy. Per-workspace failures are
 * logged but do not flip `degraded` — a corrupted entry shouldn't take down
 * the whole server.
 */
export async function rehydrateWorkspaces(store: TokenStore): Promise<RehydrationResult> {
  let tokens: InstalledToken[];
  try {
    tokens = await store.list();
  } catch (err) {
    const error = (err as Error).message;
    // Fail-soft on transient store outages (e.g. Redis ECONNREFUSED): boot must
    // not crash, but mark the result as degraded so /ready reports 503 until
    // the store recovers.
    logger.warn('Failed to read token store at startup; marking rehydration degraded', {
      error,
    });
    return { count: 0, degraded: true, error };
  }

  let count = 0;
  for (const t of tokens) {
    try {
      slackClientManager.addWorkspace(t.teamId, toSlackTokens(t));
      count += 1;
    } catch (err) {
      logger.warn('Failed to rehydrate workspace', {
        teamId: t.teamId,
        error: (err as Error).message,
      });
    }
  }
  if (count > 0) {
    logger.info('Rehydrated workspaces from token store', { count });
  }
  return { count, degraded: false };
}

function toSlackTokens(t: InstalledToken): SlackTokens {
  const base: SlackTokens = {
    access_token: t.botToken,
    token_type: 'bot',
    // Bot scopes only — PermissionManager checks against this list when
    // dispatching bot-token API calls. User scopes live under authed_user.
    scope: t.scopes.join(','),
    bot_user_id: t.userId,
    app_id: t.appId ?? '',
    team: { id: t.teamId, name: (t.metadata?.teamName as string) ?? '' },
    authed_user: {
      id: t.userId,
      scope: (t.userScopes ?? []).join(','),
      access_token: t.userToken ?? '',
      token_type: 'user',
    },
  };
  if (t.enterpriseId) {
    base.enterprise = {
      id: t.enterpriseId,
      name: (t.metadata?.enterpriseName as string) ?? '',
    };
  }
  return base;
}
