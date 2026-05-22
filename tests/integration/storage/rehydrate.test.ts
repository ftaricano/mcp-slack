import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { jest } from '@jest/globals';

import type * as MockModule from '../../__mocks__/@slack/web-api.js';

let mockWebClient: typeof MockModule.mockWebClient;
let createDefaultTokenStore: typeof import('../../../src/storage/factory.js').createDefaultTokenStore;
let slackClientManager: typeof import('../../../src/utils/slack-client.js').slackClientManager;
let rehydrateWorkspaces: typeof import('../../../src/storage/rehydrate.js').rehydrateWorkspaces;

beforeAll(async () => {
  const mockMod = await import('../../__mocks__/@slack/web-api.js');
  jest.unstable_mockModule('@slack/web-api', () => mockMod);
  mockWebClient = mockMod.mockWebClient;
  ({ createDefaultTokenStore } = await import('../../../src/storage/factory.js'));
  ({ slackClientManager } = await import('../../../src/utils/slack-client.js'));
  ({ rehydrateWorkspaces } = await import('../../../src/storage/rehydrate.js'));
});

describe('rehydrate workspaces from token store', () => {
  let tmp: string;
  let path: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'mcp-slack-rehydrate-'));
    path = join(tmp, 'tokens.json');
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    // Clear singleton state
    for (const w of slackClientManager.listWorkspaces()) slackClientManager.removeWorkspace(w);
  });

  it('replays persisted tokens into slackClientManager so tool calls work after restart', async () => {
    const store = await createDefaultTokenStore({ env: { MCP_SLACK_TOKEN_STORE_PATH: path } });
    await store.set({
      teamId: 'T-restart',
      userId: 'U1',
      botToken: 'bot-token-persisted',
      scopes: ['chat:write'],
      installedAt: 1,
      appId: 'A1',
    });

    // Sanity: no workspace in client manager yet
    expect(slackClientManager.listWorkspaces()).not.toContain('T-restart');

    await rehydrateWorkspaces(store);

    expect(slackClientManager.listWorkspaces()).toContain('T-restart');
    // And the client is usable (mocked WebClient instance)
    const client = slackClientManager.getClient('T-restart');
    expect(client).toBe(mockWebClient);
  });

  it('marks the result as degraded when store.list() rejects', async () => {
    const failingStore = {
      get: async () => null,
      set: async () => undefined,
      delete: async () => undefined,
      list: async () => {
        throw new Error('redis: ECONNREFUSED');
      },
    } as any;

    const result = await rehydrateWorkspaces(failingStore);
    expect(result).toMatchObject({ count: 0, degraded: true });
    expect(result.error).toMatch(/ECONNREFUSED/);
  });

  it('marks the result healthy when list() succeeds', async () => {
    const okStore = {
      get: async () => null,
      set: async () => undefined,
      delete: async () => undefined,
      list: async () => [],
    } as any;
    const result = await rehydrateWorkspaces(okStore);
    expect(result).toEqual({ count: 0, degraded: false });
  });

  it('rehydrate can be re-run after a degraded boot once storage recovers', async () => {
    let degraded = true;
    const flakyStore = {
      get: async () => null,
      set: async () => undefined,
      delete: async () => undefined,
      list: jest.fn(async () => {
        if (degraded) throw new Error('redis: ECONNREFUSED');
        return [];
      }),
      ping: jest.fn(async () => {
        if (degraded) throw new Error('redis: ECONNREFUSED');
      }),
    } as any;

    // First boot: storage is down, rehydrate is degraded.
    const boot = await rehydrateWorkspaces(flakyStore);
    expect(boot.degraded).toBe(true);
    expect(boot.count).toBe(0);

    // Storage recovers.
    degraded = false;

    // Second rehydrate (the post-recovery replay path the storageProbe
    // callback triggers in src/index.ts) succeeds.
    const recover = await rehydrateWorkspaces(flakyStore);
    expect(recover.degraded).toBe(false);
    expect(flakyStore.list).toHaveBeenCalledTimes(2);
  });

  it('rehydrate replays bot scopes only into SlackTokens.scope (Bug KK)', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      path,
      JSON.stringify({
        'T-mixed': {
          teamId: 'T-mixed',
          userId: 'U1',
          botToken: 'xoxb',
          scopes: ['chat:write'],
          userToken: 'xoxp',
          userScopes: ['identity.basic', 'channels:read'],
          installedAt: 1,
          appId: 'A1',
        },
      }),
    );
    const store = await createDefaultTokenStore({ env: { MCP_SLACK_TOKEN_STORE_PATH: path } });
    const result = await rehydrateWorkspaces(store);

    expect(result).toMatchObject({ count: 1, degraded: false });

    const tokens = slackClientManager.getTokens('T-mixed');
    // Bot scopes only on top-level scope (used by PermissionManager for bot ops)
    expect(tokens.scope).toBe('chat:write');
    // User scopes live on authed_user
    expect(tokens.authed_user.scope).toBe('identity.basic,channels:read');
    expect(tokens.authed_user.access_token).toBe('xoxp');
  });
});
