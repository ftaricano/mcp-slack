import { jest } from '@jest/globals';

import type { SlackTool } from '../../../src/types/mcp.js';
import type { SlackTokens } from '../../../src/types/slack.js';
import type * as MockModule from '../../__mocks__/@slack/web-api.js';

// ESM Jest does NOT hoist jest.mock above static imports. Use
// jest.unstable_mockModule + dynamic imports so the modules under test
// resolve @slack/web-api to our manual mock fixture.
let mockWebClient: typeof MockModule.mockWebClient;
let WebClientMock: typeof MockModule.WebClient;
let setupMessageCapabilities: typeof import('../../../src/capabilities/messages.js').setupMessageCapabilities;
let slackClientManager: typeof import('../../../src/utils/slack-client.js').slackClientManager;
let permissionManager: typeof import('../../../src/auth/permissions.js').permissionManager;
let RateLimitError: typeof import('../../../src/errors/index.js').RateLimitError;
let AuthError: typeof import('../../../src/errors/index.js').AuthError;

beforeAll(async () => {
  const mockMod = await import('../../__mocks__/@slack/web-api.js');
  jest.unstable_mockModule('@slack/web-api', () => mockMod);
  mockWebClient = mockMod.mockWebClient;
  WebClientMock = mockMod.WebClient;
  ({ setupMessageCapabilities } = await import('../../../src/capabilities/messages.js'));
  ({ slackClientManager } = await import('../../../src/utils/slack-client.js'));
  ({ permissionManager } = await import('../../../src/auth/permissions.js'));
  ({ RateLimitError, AuthError } = await import('../../../src/errors/index.js'));
});

const TOKENS = (overrides: Partial<SlackTokens> = {}): SlackTokens => ({
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

interface CapturedTool {
  tool: SlackTool;
  handler: (args: any) => Promise<any>;
}

function makeFakeServer(): { tools: Map<string, CapturedTool>; registerTool: any } {
  const tools = new Map<string, CapturedTool>();
  return {
    tools,
    registerTool: (tool: SlackTool, handler: (args: any) => Promise<any>): void => {
      tools.set(tool.name, { tool, handler });
    },
  };
}

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

describe('messages capability', () => {
  let tools: Map<string, CapturedTool>;
  let permSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    resetMockWebClient();
    // restoreMocks: true strips the WebClient constructor's mockImplementation
    // between tests. Re-attach so any future client construction returns the
    // shared mockWebClient (slackClientManager singleton already cached one,
    // but defensive in case the singleton re-creates clients).
    (WebClientMock as unknown as jest.Mock).mockImplementation(() => mockWebClient);

    // Ensure the singleton client manager has T1 registered. addWorkspace is
    // idempotent in practice (last-write-wins on the underlying Map).
    if (!slackClientManager.listWorkspaces().includes('T1')) {
      slackClientManager.addWorkspace('T1', TOKENS());
    }

    permSpy = jest
      .spyOn(permissionManager, 'requirePermission')
      .mockResolvedValue(undefined as never);

    const server = makeFakeServer();
    setupMessageCapabilities(server as any);
    tools = server.tools;
  });

  afterEach(() => {
    permSpy.mockRestore();
  });

  it('registers all expected message tools', () => {
    expect([...tools.keys()]).toEqual(
      expect.arrayContaining([
        'send_message',
        'update_message',
        'delete_message',
        'get_channel_history',
        'search_messages',
        'add_reaction',
        'remove_reaction',
        'get_message_permalink',
      ]),
    );
  });

  describe('send_message', () => {
    it('calls chat.postMessage with validated args', async () => {
      mockWebClient.apiCall.mockResolvedValue({
        ok: true,
        ts: '123.456789',
        channel: 'C1234567890',
      } as never);
      const result = await tools.get('send_message')!.handler({
        workspace_id: 'T1',
        user_id: 'U1',
        channel: 'C1234567890',
        text: 'hello',
      });
      expect(permSpy).toHaveBeenCalledWith('T1', 'U1', 'send_message');
      expect(mockWebClient.apiCall).toHaveBeenCalledWith(
        'chat.postMessage',
        expect.objectContaining({ channel: 'C1234567890', text: 'hello' }),
      );
      expect(result).toEqual(expect.objectContaining({ success: true }));
    });

    it('rejects empty text via the message schema', async () => {
      await expect(
        tools.get('send_message')!.handler({
          workspace_id: 'T1',
          user_id: 'U1',
          channel: 'C1234567890',
          text: '',
        }),
      ).rejects.toBeDefined();
      expect(mockWebClient.apiCall).not.toHaveBeenCalled();
    });

    it('rejects text > 4000 chars', async () => {
      await expect(
        tools.get('send_message')!.handler({
          workspace_id: 'T1',
          user_id: 'U1',
          channel: 'C1234567890',
          text: 'a'.repeat(4001),
        }),
      ).rejects.toBeDefined();
      expect(mockWebClient.apiCall).not.toHaveBeenCalled();
    });

    it('preserves individual user mentions and strips broadcasts before sending', async () => {
      mockWebClient.apiCall.mockResolvedValue({
        ok: true,
        ts: '1.000000',
        channel: 'C1234567890',
      } as never);
      await tools.get('send_message')!.handler({
        workspace_id: 'T1',
        user_id: 'U1',
        channel: 'C1234567890',
        text: 'hi <@U999> <!channel> there',
      });
      const sentText = (mockWebClient.apiCall.mock.calls[0]![1] as any).text;
      expect(sentText).toContain('<@U999>');
      expect(sentText).not.toContain('<!channel>');
    });

    it('blocks when permission check rejects', async () => {
      permSpy.mockRejectedValue(new AuthError('perm denied'));
      await expect(
        tools.get('send_message')!.handler({
          workspace_id: 'T1',
          user_id: 'U1',
          channel: 'C1234567890',
          text: 'hi',
        }),
      ).rejects.toBeInstanceOf(AuthError);
      expect(mockWebClient.apiCall).not.toHaveBeenCalled();
    });

    it('surfaces persistent slack ratelimited as RateLimitError via _wrap', async () => {
      mockWebClient.apiCall.mockRejectedValue({
        data: { error: 'ratelimited' },
        // 0s wait keeps the test fast; parseRetryAfter coerces <=0 to 1.
        headers: { 'retry-after': '0' },
      } as never);
      const promise = tools.get('send_message')!.handler({
        workspace_id: 'T1',
        user_id: 'U1',
        channel: 'C1234567890',
        text: 'hi',
      });
      await expect(promise).rejects.toBeInstanceOf(RateLimitError);
      await expect(promise).rejects.toMatchObject({ code: 'RATE_LIMIT', retryAfter: 1 });
    }, 10000);

    it('aborts retry on Slack invalid_auth surfaced from apiCall (no retry storm)', async () => {
      // Slack returned ok:false / error:invalid_auth — this is a permanent
      // auth failure. The retry layer must classify it via mapSlackError as
      // AuthError and abort after exactly 1 attempt. Before the fix in
      // slack-client.ts, the envelope was lost and apiCall threw a plain
      // Error("Slack API error: invalid_auth") — mapSlackError saw no
      // err.data.error, fell through to generic SlackMcpError, and
      // withRetry retried the auth failure 4 times.
      let attempts = 0;
      mockWebClient.apiCall.mockImplementation(async () => {
        attempts++;
        return { ok: false, error: 'invalid_auth' } as any;
      });

      await expect(
        tools.get('send_message')!.handler({
          workspace_id: 'T1',
          user_id: 'U1',
          channel: 'C1234567890',
          text: 'hi',
        }),
      ).rejects.toBeInstanceOf(AuthError);
      expect(attempts).toBe(1);
    }, 10000);

    it('does NOT retry send_message on transient errors (mutating, default no-retry)', async () => {
      // send_message wraps chat.postMessage — a non-idempotent Slack write.
      // Replaying after a partial success would post the message twice (Slack
      // commits the first attempt; if the response body times out we cannot
      // tell). _wrap must call the handler exactly once for mutating tools.
      let n = 0;
      mockWebClient.apiCall.mockImplementation(async () => {
        n += 1;
        throw new Error('transient');
      });
      await expect(
        tools.get('send_message')!.handler({
          workspace_id: 'T1',
          user_id: 'U1',
          channel: 'C1234567890',
          text: 'hi',
        }),
      ).rejects.toBeDefined();
      expect(n).toBe(1);
    }, 10000);

    it('retries get_channel_history on transient errors (read-only, idempotent)', async () => {
      // Read-only tools opt in to retry via { idempotent: true }. A transient
      // error on conversations.history is safe to replay because there's no
      // server-side state change.
      let n = 0;
      mockWebClient.apiCall.mockImplementation(async () => {
        if (++n < 2) throw new Error('transient');
        return { ok: true, messages: [], has_more: false } as any;
      });
      const result = await tools.get('get_channel_history')!.handler({
        workspace_id: 'T1',
        user_id: 'U1',
        channel: 'C1234567890',
      });
      expect(n).toBe(2);
      expect(result).toEqual(expect.objectContaining({ success: true }));
    }, 10000);
  });

  describe('add_reaction / remove_reaction', () => {
    it('add_reaction calls reactions.add with stripped colons', async () => {
      mockWebClient.apiCall.mockResolvedValue({ ok: true } as never);
      await tools.get('add_reaction')!.handler({
        workspace_id: 'T1',
        user_id: 'U1',
        channel: 'C1234567890',
        timestamp: '123.456789',
        name: ':thumbsup:',
      });
      expect(mockWebClient.apiCall).toHaveBeenCalledWith(
        'reactions.add',
        expect.objectContaining({ channel: 'C1234567890', name: 'thumbsup' }),
      );
    });

    it('remove_reaction calls reactions.remove with stripped colons', async () => {
      mockWebClient.apiCall.mockResolvedValue({ ok: true } as never);
      await tools.get('remove_reaction')!.handler({
        workspace_id: 'T1',
        user_id: 'U1',
        channel: 'C1234567890',
        timestamp: '123.456789',
        name: ':thumbsup:',
      });
      expect(mockWebClient.apiCall).toHaveBeenCalledWith(
        'reactions.remove',
        expect.objectContaining({ channel: 'C1234567890', name: 'thumbsup' }),
      );
    });

    it('does NOT retry add_reaction on transient errors (Bug LL)', async () => {
      // Slack returns `already_reacted` on replay after a successful first
      // attempt. Retrying would turn a successful add into a reported
      // failure, so add_reaction must call the handler exactly once.
      let n = 0;
      mockWebClient.apiCall.mockImplementation(async () => {
        if (++n < 2) throw new Error('transient');
        return { ok: true } as never;
      });
      await expect(
        tools.get('add_reaction')!.handler({
          workspace_id: 'T1',
          user_id: 'U1',
          channel: 'C1234567890',
          timestamp: '1.000000',
          name: 'thumbsup',
        }),
      ).rejects.toBeDefined();
      expect(n).toBe(1);
    }, 10000);

    it('does NOT retry remove_reaction on transient errors (Bug LL)', async () => {
      // Slack returns `no_reaction` on replay after a successful remove.
      let n = 0;
      mockWebClient.apiCall.mockImplementation(async () => {
        if (++n < 2) throw new Error('transient');
        return { ok: true } as never;
      });
      await expect(
        tools.get('remove_reaction')!.handler({
          workspace_id: 'T1',
          user_id: 'U1',
          channel: 'C1234567890',
          timestamp: '1.000000',
          name: 'thumbsup',
        }),
      ).rejects.toBeDefined();
      expect(n).toBe(1);
    }, 10000);
  });

  describe('update_message / delete_message', () => {
    it('update_message calls chat.update with channel + ts + sanitized text', async () => {
      mockWebClient.apiCall.mockResolvedValue({
        ok: true,
        ts: '1.000000',
        channel: 'C1234567890',
      } as never);
      await tools.get('update_message')!.handler({
        workspace_id: 'T1',
        user_id: 'U1',
        channel: 'C1234567890',
        ts: '1.000000',
        text: 'edited',
      });
      expect(mockWebClient.apiCall).toHaveBeenCalledWith(
        'chat.update',
        expect.objectContaining({ channel: 'C1234567890', ts: '1.000000', text: 'edited' }),
      );
    });

    it('delete_message calls chat.delete with channel + ts', async () => {
      mockWebClient.apiCall.mockResolvedValue({ ok: true } as never);
      await tools.get('delete_message')!.handler({
        workspace_id: 'T1',
        user_id: 'U1',
        channel: 'C1234567890',
        ts: '1.000000',
      });
      expect(mockWebClient.apiCall).toHaveBeenCalledWith(
        'chat.delete',
        expect.objectContaining({ channel: 'C1234567890', ts: '1.000000' }),
      );
    });
  });

  describe('get_channel_history', () => {
    it('calls conversations.history with channel + capped limit', async () => {
      mockWebClient.apiCall.mockResolvedValue({ ok: true, messages: [] } as never);
      await tools.get('get_channel_history')!.handler({
        workspace_id: 'T1',
        user_id: 'U1',
        channel: 'C1234567890',
        limit: 50,
      });
      expect(mockWebClient.apiCall).toHaveBeenCalledWith(
        'conversations.history',
        expect.objectContaining({ channel: 'C1234567890', limit: 50, inclusive: false }),
      );
    });
  });

  describe('search_messages', () => {
    it('calls search.messages with sensible defaults', async () => {
      mockWebClient.apiCall.mockResolvedValue({
        ok: true,
        messages: { total: 0, matches: [], pagination: {} },
      } as never);
      await tools.get('search_messages')!.handler({
        workspace_id: 'T1',
        user_id: 'U1',
        query: 'hello',
      });
      expect(mockWebClient.apiCall).toHaveBeenCalledWith(
        'search.messages',
        expect.objectContaining({
          query: 'hello',
          sort: 'score',
          sort_dir: 'desc',
          highlight: false,
          count: 20,
          page: 1,
        }),
      );
    });
  });

  describe('get_message_permalink', () => {
    it('calls chat.getPermalink with channel + message_ts', async () => {
      mockWebClient.apiCall.mockResolvedValue({
        ok: true,
        permalink: 'https://x',
      } as never);
      await tools.get('get_message_permalink')!.handler({
        workspace_id: 'T1',
        user_id: 'U1',
        channel: 'C1234567890',
        message_ts: '1.000000',
      });
      expect(mockWebClient.apiCall).toHaveBeenCalledWith(
        'chat.getPermalink',
        expect.objectContaining({ channel: 'C1234567890', message_ts: '1.000000' }),
      );
    });
  });
});
