import { WebClient, LogLevel } from '@slack/web-api';

import { SlackTokens, SlackAPIMethod } from '../types/slack.js';

import { logger, logAudit, logError, logPerformance, redactForLogging } from './logger.js';

export class SlackClientManager {
  private clients: Map<string, WebClient> = new Map();
  private tokenStore: Map<string, SlackTokens> = new Map();

  constructor() {
    logger.info('SlackClientManager initialized');
  }

  // Add a workspace client
  addWorkspace(workspaceId: string, tokens: SlackTokens): void {
    const client = new WebClient(tokens.access_token, {
      logLevel: process.env.NODE_ENV === 'development' ? LogLevel.DEBUG : LogLevel.INFO,
      retryConfig: {
        retries: 3,
        factor: 2,
        minTimeout: 1000,
        maxTimeout: 30000,
      },
    });

    this.clients.set(workspaceId, client);
    this.tokenStore.set(workspaceId, tokens);

    logAudit({
      user: 'system',
      action: 'workspace_added',
      resource: `workspace:${workspaceId}`,
      details: {
        team_id: tokens.team.id,
        team_name: tokens.team.name,
      },
      status: 'success',
    });

    logger.info('Workspace client added', { workspaceId, teamId: tokens.team.id });
  }

  // Get client for workspace
  getClient(workspaceId: string): WebClient {
    const client = this.clients.get(workspaceId);
    if (!client) {
      throw new Error(`No Slack client found for workspace: ${workspaceId}`);
    }
    return client;
  }

  // Get tokens for workspace
  getTokens(workspaceId: string): SlackTokens {
    const tokens = this.tokenStore.get(workspaceId);
    if (!tokens) {
      throw new Error(`No tokens found for workspace: ${workspaceId}`);
    }
    return tokens;
  }

  // Remove workspace
  removeWorkspace(workspaceId: string): void {
    this.clients.delete(workspaceId);
    this.tokenStore.delete(workspaceId);

    logAudit({
      user: 'system',
      action: 'workspace_removed',
      resource: `workspace:${workspaceId}`,
      details: { workspaceId },
      status: 'success',
    });

    logger.info('Workspace client removed', { workspaceId });
  }

  // List available workspaces
  listWorkspaces(): string[] {
    return Array.from(this.clients.keys());
  }

  // Make API call with logging and error handling
  async apiCall<T = any>(
    workspaceId: string,
    method: SlackAPIMethod,
    params: any = {},
    user: string = 'system',
  ): Promise<T> {
    const client = this.getClient(workspaceId);
    const start = Date.now();

    try {
      logger.debug('Making Slack API call', {
        workspaceId,
        method,
        params: this.sanitizeParams(params),
      });

      const result = await client.apiCall(method, params);
      const duration = Date.now() - start;

      logPerformance(`slack_api_${method}`, duration, {
        workspaceId,
        success: result.ok,
      });

      if (!result.ok) {
        // Preserve the Slack response envelope on the thrown Error so
        // mapSlackError() can classify it (auth/rate-limit/not-found).
        // Otherwise we'd lose `result.error` and the retry layer would treat
        // permanent failures (invalid_auth, channel_not_found) as transient.
        const err: Error & { data?: unknown; headers?: unknown } = new Error(
          `Slack API error: ${result.error}`,
        );
        err.data = {
          error: result.error,
          response_metadata: (result as { response_metadata?: unknown }).response_metadata,
        };
        // Slack rate-limit responses include `retry-after` headers, but the
        // WebClient intercepts those before we get here (it throws directly).
        // Leaving `headers` undefined unless populated upstream.
        throw err;
      }

      logAudit({
        user,
        action: `api_call_${method}`,
        resource: `workspace:${workspaceId}`,
        details: {
          method,
          params: this.sanitizeParams(params),
          duration,
        },
        status: 'success',
      });

      return result as T;
    } catch (error) {
      const duration = Date.now() - start;

      logError(error as Error, {
        workspaceId,
        method,
        params: this.sanitizeParams(params),
        duration,
      });

      logAudit({
        user,
        action: `api_call_${method}`,
        resource: `workspace:${workspaceId}`,
        details: {
          method,
          params: this.sanitizeParams(params),
          error: (error as Error).message,
          duration,
        },
        status: 'error',
      });

      throw error;
    }
  }

  // Test workspace connection
  async testConnection(workspaceId: string): Promise<boolean> {
    try {
      const result = await this.apiCall(workspaceId, 'auth.test');
      return result.ok === true;
    } catch (error) {
      logger.warn('Workspace connection test failed', { workspaceId, error });
      return false;
    }
  }

  // Refresh tokens if needed
  async refreshTokens(workspaceId: string): Promise<void> {
    const _tokens = this.getTokens(workspaceId);

    // Note: Slack doesn't use refresh tokens like other OAuth providers
    // Token refresh would need to be handled through re-authorization
    // This is a placeholder for future implementation if Slack adds refresh token support

    logger.info('Token refresh requested', { workspaceId });
    // Implementation would go here when Slack supports refresh tokens
  }

  // Rate limit handling
  async withRateLimit<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
    const maxRetries = 5;
    let retries = 0;

    while (retries < maxRetries) {
      try {
        return await operation();
      } catch (error: any) {
        if (error.code === 'rate_limited' && retries < maxRetries - 1) {
          const retryAfter = error.headers?.['retry-after'] || Math.pow(2, retries);
          logger.warn('Rate limited, retrying', {
            workspaceId,
            retryAfter,
            attempt: retries + 1,
          });

          await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
          retries++;
          continue;
        }
        throw error;
      }
    }

    throw new Error('Max retries exceeded for rate limited request');
  }

  // Health check for all workspaces
  async healthCheck(): Promise<Record<string, boolean>> {
    const workspaces = this.listWorkspaces();
    const results: Record<string, boolean> = {};

    await Promise.all(
      workspaces.map(async (workspaceId) => {
        results[workspaceId] = await this.testConnection(workspaceId);
      }),
    );

    return results;
  }

  // Sanitize parameters for logging (remove sensitive data)
  private sanitizeParams(params: any): any {
    return redactForLogging(params);
  }
}

// Singleton instance
export const slackClientManager = new SlackClientManager();

// Helper functions for common operations
export async function sendMessage(
  workspaceId: string,
  channel: string,
  text: string,
  options: any = {},
  user: string = 'system',
): Promise<any> {
  return slackClientManager.apiCall(
    workspaceId,
    'chat.postMessage',
    { channel, text, ...options },
    user,
  );
}

export async function getChannelInfo(
  workspaceId: string,
  channel: string,
  user: string = 'system',
): Promise<any> {
  return slackClientManager.apiCall(workspaceId, 'conversations.info', { channel }, user);
}

export async function listChannels(
  workspaceId: string,
  options: any = {},
  user: string = 'system',
): Promise<any> {
  return slackClientManager.apiCall(
    workspaceId,
    'conversations.list',
    { limit: 100, ...options },
    user,
  );
}

export async function getUserInfo(
  workspaceId: string,
  user_id: string,
  user: string = 'system',
): Promise<any> {
  return slackClientManager.apiCall(workspaceId, 'users.info', { user: user_id }, user);
}

export async function listUsers(
  workspaceId: string,
  options: any = {},
  user: string = 'system',
): Promise<any> {
  return slackClientManager.apiCall(workspaceId, 'users.list', { limit: 100, ...options }, user);
}
