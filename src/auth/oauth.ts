import crypto from 'crypto';

import { InstallProvider, LogLevel } from '@slack/oauth';
import { WebClient } from '@slack/web-api';
import express, { Request, Response, Router } from 'express';
import jwt from 'jsonwebtoken';

import { MemoryTokenStore } from '../storage/memory-token-store.js';
import type { InstalledToken, TokenStore } from '../storage/token-store.js';
import { SlackOAuthConfig, SlackTokens } from '../types/slack.js';
import { logger, logAudit, logError } from '../utils/logger.js';
import { slackClientManager } from '../utils/slack-client.js';

interface OauthV2AccessResponse {
  ok: boolean;
  error?: string;
  access_token?: string;
  scope?: string;
  bot_user_id?: string;
  app_id?: string;
  team?: { id?: string; name?: string };
  enterprise?: { id?: string; name?: string } | null;
  authed_user?: { id?: string; scope?: string; access_token?: string };
}

function toInstalledToken(installation: any): InstalledToken {
  // The persistence key must match the legacy in-memory installations Map,
  // which keys by `enterprise.id || team.id` (enterprise wins). This matters
  // for Enterprise Grid installs that carry BOTH ids — the SDK fetches
  // installations by enterpriseId for org-scoped events, so the persisted
  // record needs to land on the same key. Org-wide installs that have only
  // an enterprise.id still hit this branch correctly. Pure team installs
  // fall through to team.id.
  const teamId = installation.enterprise?.id || installation.team?.id;
  if (!teamId) {
    throw new Error('Slack install has no team.id or enterprise.id — cannot persist');
  }
  const installed: InstalledToken = {
    teamId,
    enterpriseId: installation.enterprise?.id,
    userId: installation.user?.id ?? '',
    botToken: installation.bot?.token ?? '',
    userToken: installation.user?.token,
    // Persist bot and user scopes separately so PermissionManager (which reads
    // SlackTokens.scope rebuilt from `scopes`) only authorizes ops the bot
    // token actually carries. Merging them caused user-only scopes to grant
    // bot-only operations after a restart.
    scopes: [...(installation.bot?.scopes ?? [])],
    installedAt: Date.now(),
    appId: installation.appId,
    metadata: {
      teamName: installation.team?.name,
      enterpriseName: installation.enterprise?.name,
      isEnterprise: !installation.team?.id,
    },
  };
  if (installation.user?.scopes && installation.user.scopes.length > 0) {
    installed.userScopes = [...installation.user.scopes];
  }
  return installed;
}

/**
 * Inverse of toInstalledToken: rebuild a minimal `@slack/oauth` Installation
 * shape from a persisted InstalledToken. Used by fetchInstallation when the
 * in-memory cache is cold (e.g. just after a restart) so the SDK's
 * installationStore callback still works against rehydrated workspaces.
 */
function installationFromToken(t: InstalledToken): any {
  const installation: any = {
    bot: {
      token: t.botToken,
      scopes: [...t.scopes],
      userId: t.userId,
    },
    appId: t.appId ?? '',
  };
  // Only attach team / enterprise blocks when their ids are real. The
  // metadata's optional names backfill what we lost crossing the persistence
  // boundary, but we never synthesize a team object for org-wide installs that
  // had only an enterprise id.
  if (!t.metadata?.isEnterprise && t.teamId) {
    installation.team = { id: t.teamId, name: (t.metadata?.teamName as string) ?? '' };
  }
  if (t.enterpriseId || t.metadata?.isEnterprise) {
    installation.enterprise = {
      id: t.enterpriseId ?? t.teamId,
      name: (t.metadata?.enterpriseName as string) ?? '',
    };
  }
  if (t.userToken || (t.userScopes && t.userScopes.length > 0)) {
    installation.user = {
      id: t.userId,
      token: t.userToken ?? '',
      scopes: [...(t.userScopes ?? [])],
    };
  }
  return installation;
}

export interface OAuthState {
  state: string;
  codeVerifier?: string;
  redirectUri: string;
  scopes: string[];
  userScopes: string[];
  timestamp: number;
}

export class SlackOAuthManager {
  private installProvider: InstallProvider;
  private stateStore: Map<string, OAuthState> = new Map();
  private readonly tokenStore: TokenStore;
  // Required at construction time. The CLI's `mcp-slack auth login` path also
  // builds a SlackOAuthManager without going through bootstrap()'s env
  // validation, so we cannot assume the env was vetted upstream — falling back
  // to a literal placeholder would silently sign success tokens with a public
  // string. Fail loud instead.
  private readonly JWT_SECRET = (() => {
    const secret = process.env.JWT_SECRET;
    if (!secret || secret.length < 32) {
      throw new Error(
        'JWT_SECRET must be set to a string of 32+ characters before constructing SlackOAuthManager',
      );
    }
    return secret;
  })();
  private readonly STATE_TTL = 10 * 60 * 1000; // 10 minutes
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(private config: SlackOAuthConfig) {
    this.tokenStore = config.tokenStore ?? new MemoryTokenStore();
    this.installProvider = new InstallProvider({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      stateSecret: process.env.OAUTH_STATE_SECRET || crypto.randomBytes(32).toString('hex'),
      installationStore: {
        storeInstallation: async (installation) => {
          logger.info('Storing installation', {
            teamId: installation.team?.id,
            enterpriseId: installation.enterprise?.id,
          });

          await this.storeInstallation(installation);
          return;
        },
        fetchInstallation: async (installQuery) => {
          logger.debug('Fetching installation', installQuery);
          return this.fetchInstallation(installQuery);
        },
        deleteInstallation: async (installQuery) => {
          logger.info('Deleting installation', installQuery);
          await this.deleteInstallation(installQuery);
          return;
        },
      },
      logLevel: process.env.NODE_ENV === 'development' ? LogLevel.DEBUG : LogLevel.INFO,
    });

    // Cleanup expired states periodically. unref() so the timer never holds
    // the event loop open during graceful shutdown.
    this.cleanupTimer = setInterval(() => this.cleanupExpiredStates(), 5 * 60 * 1000);
    this.cleanupTimer.unref();

    logger.info('SlackOAuthManager initialized', {
      clientId: config.clientId,
      scopes: config.scopes,
    });
  }

  // Generate OAuth URL for workspace installation
  async generateInstallUrl(
    options: {
      scopes?: string[];
      userScopes?: string[];
      redirectUri?: string;
      metadata?: Record<string, any>;
    } = {},
  ): Promise<string> {
    const state = crypto.randomBytes(32).toString('hex');
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const redirectUri = options.redirectUri || this.config.redirectUri;

    const oauthState: OAuthState = {
      state,
      codeVerifier,
      redirectUri,
      scopes: options.scopes || this.config.scopes,
      userScopes: options.userScopes || this.config.userScopes || [],
      timestamp: Date.now(),
    };

    // Persist state. Try the durable backend first so multi-replica deploys
    // and process restarts between /oauth/install and /oauth/callback survive.
    // Fall back to in-process Map if the backend doesn't expose raw KV (the
    // MemoryTokenStore is intentionally non-durable — that one is single-
    // process by definition anyway).
    this.stateStore.set(state, oauthState);
    if (this.tokenStore.setRaw) {
      try {
        await this.tokenStore.setRaw(
          `oauth-state:${state}`,
          JSON.stringify(oauthState),
          Math.ceil(this.STATE_TTL / 1000),
        );
      } catch (err) {
        logger.warn(
          'Failed to persist OAuth state to tokenStore — falling back to in-memory only',
          {
            error: (err as Error).message,
          },
        );
      }
    }

    // Build the Slack authorize URL ourselves. The @slack/oauth helper either
    // signs its own state (stateVerification: true) or omits state entirely
    // (false), neither of which is what we want — we manage state in stateStore
    // and need it to round-trip through Slack as a query-string param.
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      scope: oauthState.scopes.join(','),
      redirect_uri: redirectUri,
      state: oauthState.state,
    });
    if (oauthState.userScopes.length > 0) {
      params.set('user_scope', oauthState.userScopes.join(','));
    }
    const installUrl = `https://slack.com/oauth/v2/authorize?${params.toString()}`;

    logger.info('Generated install URL', {
      state,
      scopes: oauthState.scopes,
      userScopes: oauthState.userScopes,
    });

    return installUrl;
  }

  // Handle OAuth callback
  async handleCallback(code: string, state: string): Promise<SlackTokens> {
    logger.debug('Handling OAuth callback', { code: code.substring(0, 10) + '...', state });

    // Validate state. Check in-memory first (cheap and covers the same-replica
    // case), then fall back to the durable backend (covers multi-replica and
    // post-restart scenarios). Without this fallback any process other than
    // the one that handed out the install URL rejects the callback.
    let oauthState = this.stateStore.get(state) ?? null;
    if (!oauthState && this.tokenStore.getRaw) {
      // Bound the lookup so a slow/hung backend (Redis blocked on a downstream
      // proxy, file lock contention) doesn't hold the /oauth/callback request
      // open until the upstream proxy 504s. 2s matches the ioredis
      // connectTimeout in factory.ts; well above any healthy GET round-trip.
      const getRawWithTimeout = Promise.race([
        this.tokenStore.getRaw(`oauth-state:${state}`),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
      ]);
      try {
        const raw = await getRawWithTimeout;
        if (raw) oauthState = JSON.parse(raw) as OAuthState;
      } catch (err) {
        logger.warn('Failed to read OAuth state from tokenStore', {
          error: (err as Error).message,
        });
      }
    }
    if (!oauthState) {
      throw new Error('Invalid or expired OAuth state');
    }

    // Check state expiration
    if (Date.now() - oauthState.timestamp > this.STATE_TTL) {
      this.stateStore.delete(state);
      if (this.tokenStore.delRaw) {
        await this.tokenStore.delRaw(`oauth-state:${state}`).catch(() => undefined);
      }
      throw new Error('OAuth state expired');
    }

    try {
      // @slack/oauth's `installProvider.handleCallback(req, res)` is a full
      // HTTP handler — it reads code/state from `req`, writes the response,
      // and resolves to `void`. To get the Installation object back we have
      // to do the OAuth exchange ourselves. Use WebClient to call
      // oauth.v2.access directly, then pipe the result through our own
      // installation store callback (the same one InstallProvider would
      // have invoked).
      const oauthClient = new WebClient();
      const result = (await oauthClient.apiCall('oauth.v2.access', {
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        code,
        redirect_uri: oauthState.redirectUri,
      })) as OauthV2AccessResponse;

      if (!result.ok || !result.access_token) {
        throw new Error(`OAuth exchange failed: ${result.error ?? 'unknown'}`);
      }

      const installation: any = {
        // Org-wide Enterprise Grid installs omit `team` entirely. Don't
        // synthesize an empty team object — toInstalledToken needs a missing
        // team.id (not '') so its `?? enterprise.id` fallback fires.
        ...(result.team ? { team: result.team } : {}),
        ...(result.enterprise ? { enterprise: result.enterprise } : {}),
        bot: {
          token: result.access_token,
          scopes: (result.scope ?? '').split(',').filter(Boolean),
          userId: result.bot_user_id ?? '',
        },
        ...(result.authed_user
          ? {
              user: {
                id: result.authed_user.id ?? '',
                token: result.authed_user.access_token ?? '',
                scopes: (result.authed_user.scope ?? '').split(',').filter(Boolean),
              },
            }
          : {}),
        appId: result.app_id ?? '',
      };

      if (!installation.bot.token) {
        throw new Error('Bot installation required');
      }

      // Persist via our own store callback (same path InstallProvider would
      // have used).
      await this.storeInstallation(installation);

      // Org-wide Enterprise Grid installs deliver `enterprise.id` but no
      // `team.id`. Mirror the persistence-key fallback in `toInstalledToken`
      // so we never register the in-memory client under empty string (which
      // would collide every org-wide install onto a single useless slot).
      const teamOrEnterpriseId = installation.enterprise?.id || installation.team?.id;
      if (!teamOrEnterpriseId) {
        throw new Error(
          'OAuth response missing both team.id and enterprise.id — cannot register workspace',
        );
      }

      const tokens: SlackTokens = {
        access_token: installation.bot.token || '',
        token_type: 'bot',
        scope: (installation.bot.scopes || []).join(','),
        bot_user_id: installation.bot.userId || '',
        app_id: installation.appId || '',
        team: {
          id: teamOrEnterpriseId,
          name: installation.team?.name || installation.enterprise?.name || '',
        },
        ...(installation.enterprise && {
          enterprise: {
            id: installation.enterprise.id || '',
            name: installation.enterprise.name || '',
          },
        }),
        authed_user: {
          id: installation.user?.id || '',
          scope: (installation.user?.scopes || []).join(','),
          access_token: installation.user?.token || '',
          token_type: 'user',
        },
      };

      // Add to Slack client manager
      slackClientManager.addWorkspace(teamOrEnterpriseId, tokens);

      // Clean up state from both layers — durable + in-memory.
      this.stateStore.delete(state);
      if (this.tokenStore.delRaw) {
        await this.tokenStore.delRaw(`oauth-state:${state}`).catch(() => undefined);
      }

      logAudit({
        user: tokens.authed_user.id,
        action: 'oauth_callback_success',
        resource: `workspace:${tokens.team.id}`,
        details: {
          team_id: tokens.team.id,
          team_name: tokens.team.name,
          scopes: tokens.scope,
          app_id: tokens.app_id,
        },
        status: 'success',
      });

      logger.info('OAuth callback successful', {
        teamId: tokens.team.id,
        teamName: tokens.team.name,
        userId: tokens.authed_user.id,
      });

      return tokens;
    } catch (error) {
      this.stateStore.delete(state);
      if (this.tokenStore.delRaw) {
        await this.tokenStore.delRaw(`oauth-state:${state}`).catch(() => undefined);
      }

      logError(error as Error, { state, code: code.substring(0, 10) });

      logAudit({
        user: 'unknown',
        action: 'oauth_callback_error',
        resource: 'oauth',
        details: {
          state,
          error: (error as Error).message,
        },
        status: 'error',
      });

      throw error;
    }
  }

  // Create Express router for OAuth endpoints
  createRouter(): Router {
    const router = express.Router();

    // Install endpoint
    router.get('/install', async (req: Request, res: Response) => {
      try {
        const options = {
          scopes: req.query.scopes ? String(req.query.scopes).split(',') : undefined,
          userScopes: req.query.user_scopes ? String(req.query.user_scopes).split(',') : undefined,
          redirectUri: req.query.redirect_uri ? String(req.query.redirect_uri) : undefined,
          metadata: req.query.metadata ? JSON.parse(String(req.query.metadata)) : undefined,
        };

        const cleanOptions = {
          ...(options.scopes && { scopes: options.scopes }),
          ...(options.userScopes && { userScopes: options.userScopes }),
          ...(options.redirectUri && { redirectUri: options.redirectUri }),
          ...(options.metadata && { metadata: options.metadata }),
        };

        const installUrl = await this.generateInstallUrl(cleanOptions);

        const auditData: any = {
          user: 'anonymous',
          action: 'oauth_install_requested',
          resource: 'oauth',
          details: cleanOptions,
          status: 'success',
        };

        if (req.ip) auditData.ip = req.ip;
        if (req.get('User-Agent')) auditData.userAgent = req.get('User-Agent');

        logAudit(auditData);

        res.redirect(installUrl);
      } catch (error) {
        logError(error as Error, { query: req.query });
        res.status(500).json({
          error: 'Failed to generate install URL',
          message: (error as Error).message,
        });
      }
    });

    // Callback endpoint
    router.get('/callback', async (req: Request, res: Response) => {
      try {
        const { code, state, error } = req.query;

        if (error) {
          throw new Error(`OAuth error: ${error}`);
        }

        if (!code || !state) {
          throw new Error('Missing required OAuth parameters');
        }

        const tokens = await this.handleCallback(String(code), String(state));

        // Generate success JWT token for client
        const successToken = jwt.sign(
          {
            team_id: tokens.team.id,
            user_id: tokens.authed_user.id,
            timestamp: Date.now(),
          },
          this.JWT_SECRET,
          { expiresIn: '1h' },
        );

        // Return success page or redirect
        res.json({
          success: true,
          message: 'Slack workspace connected successfully!',
          team: tokens.team,
          token: successToken,
        });
      } catch (error) {
        logError(error as Error, { query: req.query });

        res.status(400).json({
          success: false,
          error: 'OAuth callback failed',
          message: (error as Error).message,
        });
      }
    });

    // Status endpoint
    router.get('/status/:team_id', async (req: Request, res: Response) => {
      try {
        const { team_id } = req.params;

        if (!team_id) {
          return res.status(400).json({ error: 'Team ID is required' });
        }

        const isConnected = slackClientManager.listWorkspaces().includes(team_id);

        if (isConnected) {
          const health = await slackClientManager.testConnection(team_id);
          return res.json({
            connected: true,
            healthy: health,
            team_id,
          });
        } else {
          return res.json({
            connected: false,
            team_id,
          });
        }
      } catch (error) {
        logError(error as Error, { teamId: req.params.team_id });
        return res.status(500).json({
          error: 'Failed to check status',
          message: (error as Error).message,
        });
      }
    });

    // Revoke/disconnect endpoint
    router.post('/revoke/:team_id', async (req: Request, res: Response) => {
      try {
        const { team_id } = req.params;

        if (!team_id) {
          return res.status(400).json({ error: 'Team ID is required' });
        }

        // Remove from client manager
        slackClientManager.removeWorkspace(team_id);

        // Drop the persisted token so a subsequent restart's
        // rehydrateWorkspaces() does not resurrect the revoked workspace.
        await this.tokenStore.delete(team_id);

        // Mirror to the in-memory installation cache (used by SDK lifecycle)
        // so listInstallations()/fetchInstallation() reflect the revoke.
        // storeInstallation keys this Map by `enterprise.id || team.id`, so for
        // Enterprise Grid installs the entry lives under the enterprise id —
        // a plain `delete(team_id)` would leak a stale cached install. Sweep
        // any entry whose team.id matches to cover both shapes.
        this.installations.delete(team_id);
        for (const [key, installation] of this.installations.entries()) {
          if (installation?.team?.id === team_id) {
            this.installations.delete(key);
          }
        }

        // TODO: Call Slack's auth.revoke API if needed

        const auditData: any = {
          user: 'admin',
          action: 'oauth_revoked',
          resource: `workspace:${team_id}`,
          details: { team_id },
          status: 'success',
        };

        if (req.ip) auditData.ip = req.ip;
        if (req.get('User-Agent')) auditData.userAgent = req.get('User-Agent');

        logAudit(auditData);

        return res.json({
          success: true,
          message: 'Workspace disconnected successfully',
          team_id,
        });
      } catch (error) {
        logError(error as Error, { teamId: req.params.team_id });
        return res.status(500).json({
          error: 'Failed to revoke connection',
          message: (error as Error).message,
        });
      }
    });

    return router;
  }

  // Raw installation cache keyed by enterprise.id || team.id. Required because
  // @slack/oauth's InstallProvider lifecycle expects to round-trip its own
  // Installation shape via fetchInstallation; the normalized InstalledToken on
  // the TokenStore is the canonical persistence boundary for callers.
  private installations: Map<string, any> = new Map();

  private async storeInstallation(installation: any): Promise<void> {
    const key = installation.enterprise?.id || installation.team?.id || 'unknown';
    this.installations.set(key, {
      ...installation,
      stored_at: Date.now(),
    });

    // Mirror to the pluggable TokenStore so callers (and persistent backends
    // like Redis) see the install. If this fails we MUST surface it: the
    // workspace would otherwise live only in this process's memory and
    // disappear on restart, while the OAuth callback returned "success" to
    // the user. Roll back the in-memory cache so the install path is
    // all-or-nothing, then propagate the error — `handleCallback`'s catch
    // already cleans up state and returns 4xx.
    try {
      await this.tokenStore.set(toInstalledToken(installation));
    } catch (err) {
      logError(err as Error, { stage: 'tokenStore.set', key });
      this.installations.delete(key);
      throw err;
    }

    logger.debug('Installation stored', { key });
  }

  private async fetchInstallation(installQuery: any): Promise<any> {
    const key = installQuery.enterpriseId || installQuery.teamId;
    const cached = this.installations.get(key);

    if (cached) {
      logger.debug('Installation fetched (cache)', { key });
      return cached;
    }

    // After restart the in-memory cache is empty even when the persistent
    // tokenStore has the install. Reconstruct a minimal Installation shape
    // from the InstalledToken so SDK callbacks (events, slash commands) still
    // work without a manual reinstall. This is the inverse of toInstalledToken.
    const persisted = await this.tokenStore.get(key).catch(() => null);
    if (persisted) {
      const installation = installationFromToken(persisted);
      this.installations.set(key, { ...installation, stored_at: persisted.installedAt });
      logger.debug('Installation fetched (rehydrated from tokenStore)', { key });
      return installation;
    }

    throw new Error(`Installation not found for ${key}`);
  }

  private async deleteInstallation(installQuery: any): Promise<void> {
    const key = installQuery.enterpriseId || installQuery.teamId;
    this.installations.delete(key);

    try {
      if (installQuery.teamId) {
        await this.tokenStore.delete(installQuery.teamId);
      }
    } catch (err) {
      logError(err as Error, { stage: 'tokenStore.delete', key });
    }

    logger.debug('Installation deleted', { key });
  }

  // Cleanup expired OAuth states
  private cleanupExpiredStates(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [state, oauthState] of this.stateStore.entries()) {
      if (now - oauthState.timestamp > this.STATE_TTL) {
        this.stateStore.delete(state);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.debug('Cleaned up expired OAuth states', { count: cleaned });
    }
  }

  // Get installation info
  async getInstallationInfo(teamId: string): Promise<any | null> {
    try {
      return await this.fetchInstallation({ teamId });
    } catch (_error) {
      return null;
    }
  }

  // List all installations.
  //
  // The in-memory `installations` Map is what the SDK populates during install
  // (via storeInstallation). After a fresh process boots and rehydrates from
  // the persistent TokenStore, that Map is initially empty even though the
  // workspaces ARE persisted. Listing only the cache would silently report no
  // workspaces post-restart. So merge both: persistent (source of truth) +
  // in-memory (covers any new installs that haven't synced to the cache shape
  // yet, though storeInstallation always writes to both).
  async listInstallations(): Promise<Array<{ teamId: string; stored_at: number }>> {
    const merged = new Map<string, number>();
    for (const [key, installation] of this.installations.entries()) {
      merged.set(key, installation.stored_at);
    }
    try {
      const persisted = await this.tokenStore.list();
      for (const t of persisted) {
        if (!merged.has(t.teamId)) merged.set(t.teamId, t.installedAt);
      }
    } catch (err) {
      logger.warn('listInstallations: tokenStore.list failed; returning cache only', {
        error: (err as Error).message,
      });
    }
    return [...merged.entries()].map(([teamId, stored_at]) => ({ teamId, stored_at }));
  }
}

// Create OAuth manager instance
export const createOAuthManager = (config: SlackOAuthConfig): SlackOAuthManager => {
  return new SlackOAuthManager(config);
};
