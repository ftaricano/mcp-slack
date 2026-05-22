import { jest } from '@jest/globals';

import type { SlackTokens } from '../../../src/types/slack.js';
import type { SlackClientManager as SlackClientManagerT } from '../../../src/utils/slack-client.js';
// Type-only import for the mock fixture so eslint/import order stays happy.
import type * as MockModule from '../../__mocks__/@slack/web-api.js';

// ESM Jest does NOT hoist jest.mock above static imports. Use
// jest.unstable_mockModule + dynamic imports so SlackClientManager
// resolves @slack/web-api to our manual mock fixture.
let SlackClientManager: typeof SlackClientManagerT;
let mockWebClient: typeof MockModule.mockWebClient;
let WebClientMock: typeof MockModule.WebClient;

beforeAll(async () => {
  const mockMod = await import('../../__mocks__/@slack/web-api.js');
  jest.unstable_mockModule('@slack/web-api', () => mockMod);
  mockWebClient = mockMod.mockWebClient;
  WebClientMock = mockMod.WebClient;
  // Dynamic import AFTER unstable_mockModule so SUT picks up the mock.
  ({ SlackClientManager } = await import('../../../src/utils/slack-client.js'));
});

const tokens = (overrides: Partial<SlackTokens> = {}): SlackTokens => ({
  access_token: 'bot-token-test',
  token_type: 'bot',
  scope: 'chat:write',
  bot_user_id: 'U-bot',
  app_id: 'A1',
  team: { id: 'T1', name: 'Test' },
  authed_user: {
    id: 'U1',
    scope: 'identify',
    access_token: 'user-token-test',
    token_type: 'user',
  },
  ...overrides,
});

const resetMockWebClient = (): void => {
  const walk = (obj: any): void => {
    for (const key of Object.keys(obj)) {
      const v = obj[key];
      if (typeof v?.mockReset === 'function') {
        v.mockReset();
      } else if (v && typeof v === 'object') {
        walk(v);
      }
    }
  };
  walk(mockWebClient);
};

describe('SlackClientManager', () => {
  let mgr: SlackClientManagerT;

  beforeEach(() => {
    resetMockWebClient();
    // jest.config sets restoreMocks: true, which strips the WebClient
    // constructor's mockImplementation between tests. Re-attach so
    // `new WebClient(...)` inside SlackClientManager keeps returning the
    // shared mockWebClient.
    (WebClientMock as unknown as jest.Mock).mockImplementation(() => mockWebClient);
    mgr = new SlackClientManager();
  });

  describe('addWorkspace / getClient / getTokens / removeWorkspace / listWorkspaces', () => {
    it('round-trips a workspace', () => {
      const t = tokens();
      mgr.addWorkspace('T1', t);
      expect(mgr.getClient('T1')).toBe(mockWebClient);
      expect(mgr.getTokens('T1')).toBe(t);
      expect(mgr.listWorkspaces()).toEqual(['T1']);
      mgr.removeWorkspace('T1');
      expect(mgr.listWorkspaces()).toEqual([]);
    });

    it('lists multiple workspaces', () => {
      mgr.addWorkspace('T1', tokens());
      mgr.addWorkspace('T2', tokens({ team: { id: 'T2', name: 'B' } }));
      expect(mgr.listWorkspaces()).toEqual(expect.arrayContaining(['T1', 'T2']));
      expect(mgr.listWorkspaces()).toHaveLength(2);
    });

    it('getClient throws for unknown workspace', () => {
      expect(() => mgr.getClient('T-missing')).toThrow(/T-missing/);
    });

    it('getTokens throws for unknown workspace', () => {
      expect(() => mgr.getTokens('T-missing')).toThrow(/T-missing/);
    });

    it('removeWorkspace is idempotent for unknown ids', () => {
      expect(() => mgr.removeWorkspace('T-nope')).not.toThrow();
    });
  });

  describe('apiCall', () => {
    beforeEach(() => {
      mgr.addWorkspace('T1', tokens());
    });

    it('returns the underlying result on ok', async () => {
      mockWebClient.apiCall.mockResolvedValue({ ok: true, channels: [] } as never);
      const r = await mgr.apiCall<{ ok: boolean; channels: unknown[] }>('T1', 'conversations.list');
      expect(r.ok).toBe(true);
      expect(mockWebClient.apiCall).toHaveBeenCalledWith('conversations.list', {});
    });

    it('passes params through to WebClient.apiCall', async () => {
      mockWebClient.apiCall.mockResolvedValue({ ok: true } as never);
      await mgr.apiCall('T1', 'conversations.info', { channel: 'C1' });
      expect(mockWebClient.apiCall).toHaveBeenCalledWith('conversations.info', { channel: 'C1' });
    });

    it('throws when result.ok is false', async () => {
      mockWebClient.apiCall.mockResolvedValue({
        ok: false,
        error: 'channel_not_found',
      } as never);
      await expect(mgr.apiCall('T1', 'conversations.info', { channel: 'C1' })).rejects.toThrow(
        /channel_not_found/,
      );
    });

    it('rethrows transport errors', async () => {
      mockWebClient.apiCall.mockRejectedValue(new Error('network down') as never);
      await expect(mgr.apiCall('T1', 'auth.test')).rejects.toThrow('network down');
    });

    it('throws if workspace is unknown (delegates to getClient)', async () => {
      await expect(mgr.apiCall('T-missing', 'auth.test')).rejects.toThrow(/T-missing/);
    });

    it('passes raw params to WebClient.apiCall (sanitization happens only in audit log)', async () => {
      mockWebClient.apiCall.mockResolvedValue({ ok: true } as never);
      await mgr.apiCall('T1', 'auth.test', { token: 'user-token-leak', other: 'ok' });
      expect(mockWebClient.apiCall).toHaveBeenCalledWith('auth.test', {
        token: 'user-token-leak',
        other: 'ok',
      });
    });

    it('preserves Slack error envelope (data.error, headers) when ok:false', async () => {
      // mapSlackError() inspects err.data.error to classify Slack failures
      // (auth, rate-limit, not-found). If apiCall throws a plain
      // `new Error("Slack API error: invalid_auth")`, that envelope is lost
      // and the retry layer treats invalid_auth as transient — wrong.
      mockWebClient.apiCall.mockResolvedValue({
        ok: false,
        error: 'invalid_auth',
        response_metadata: { messages: ['bad token'] },
      } as never);

      let caught: any;
      try {
        await mgr.apiCall('T1', 'auth.test');
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeDefined();
      expect(caught.data?.error).toBe('invalid_auth'); // FAILS today
    });
  });

  describe('testConnection', () => {
    beforeEach(() => {
      mgr.addWorkspace('T1', tokens());
    });

    it('returns true when auth.test succeeds', async () => {
      mockWebClient.apiCall.mockResolvedValue({ ok: true } as never);
      await expect(mgr.testConnection('T1')).resolves.toBe(true);
      expect(mockWebClient.apiCall).toHaveBeenCalledWith('auth.test', {});
    });

    it('returns false when auth.test rejects', async () => {
      mockWebClient.apiCall.mockRejectedValue(new Error('boom') as never);
      await expect(mgr.testConnection('T1')).resolves.toBe(false);
    });

    it('returns false when auth.test resolves with ok:false (apiCall throws internally)', async () => {
      mockWebClient.apiCall.mockResolvedValue({ ok: false, error: 'invalid_auth' } as never);
      await expect(mgr.testConnection('T1')).resolves.toBe(false);
    });
  });

  describe('healthCheck', () => {
    it('returns {} when no workspaces are registered', async () => {
      await expect(mgr.healthCheck()).resolves.toEqual({});
    });

    it('reports per-workspace status (all healthy)', async () => {
      mgr.addWorkspace('T1', tokens());
      mgr.addWorkspace('T2', tokens({ team: { id: 'T2', name: 'B' } }));
      mockWebClient.apiCall.mockResolvedValue({ ok: true } as never);
      await expect(mgr.healthCheck()).resolves.toEqual({ T1: true, T2: true });
    });

    it('reports per-workspace status (mixed)', async () => {
      mgr.addWorkspace('T1', tokens());
      mgr.addWorkspace('T2', tokens({ team: { id: 'T2', name: 'B' } }));
      // Promise.all order isn't guaranteed: alternate per-call so we get
      // exactly one true and one false across the two workspaces.
      let calls = 0;
      mockWebClient.apiCall.mockImplementation(async () => {
        calls += 1;
        if (calls === 1) return { ok: true } as never;
        return { ok: false, error: 'invalid_auth' } as never;
      });
      const r = await mgr.healthCheck();
      const values = Object.values(r);
      expect(values).toHaveLength(2);
      expect(values.filter((v) => v === true)).toHaveLength(1);
      expect(values.filter((v) => v === false)).toHaveLength(1);
    });
  });

  describe('withRateLimit', () => {
    beforeEach(() => {
      mgr.addWorkspace('T1', tokens());
    });

    it('returns the value on first success', async () => {
      const fn = jest.fn(async () => 'ok' as const);
      await expect(mgr.withRateLimit('T1', fn)).resolves.toBe('ok');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('retries on rate_limited and eventually succeeds', async () => {
      let n = 0;
      const fn = jest.fn(async () => {
        n += 1;
        if (n < 2) {
          const e: any = new Error('rl');
          e.code = 'rate_limited';
          // 0.001s * 1000 = ~1ms sleep. Must be truthy because the impl
          // falls back to exponential backoff via `||` when retry-after is 0.
          e.headers = { 'retry-after': 0.001 };
          throw e;
        }
        return 'ok';
      });
      await expect(mgr.withRateLimit('T1', fn)).resolves.toBe('ok');
      expect(fn).toHaveBeenCalledTimes(2);
    }, 8000);

    it('does not retry non-rate-limit errors', async () => {
      const fn = jest.fn(async () => {
        throw new Error('boom');
      });
      await expect(mgr.withRateLimit('T1', fn)).rejects.toThrow('boom');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('eventually rethrows when rate-limit persists past max retries', async () => {
      const fn = jest.fn(async () => {
        const e: any = new Error('rl');
        e.code = 'rate_limited';
        // ~1ms backoff so the test finishes well under the timeout.
        e.headers = { 'retry-after': 0.001 };
        throw e;
      });
      // Implementation retries while `retries < maxRetries - 1` (attempts
      // 1..4 retry, attempt 5 falls through and rethrows).
      await expect(mgr.withRateLimit('T1', fn)).rejects.toThrow('rl');
      expect(fn).toHaveBeenCalledTimes(5);
    }, 15000);
  });
});

describe('helper functions', () => {
  it('exports the expected helper functions', async () => {
    const mod = await import('../../../src/utils/slack-client.js');
    expect(typeof mod.sendMessage).toBe('function');
    expect(typeof mod.getChannelInfo).toBe('function');
    expect(typeof mod.listChannels).toBe('function');
    expect(typeof mod.getUserInfo).toBe('function');
    expect(typeof mod.listUsers).toBe('function');
  });

  it('exports a singleton slackClientManager', async () => {
    const mod = await import('../../../src/utils/slack-client.js');
    expect(mod.slackClientManager).toBeInstanceOf(SlackClientManager);
  });
});
