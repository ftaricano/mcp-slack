import { jest } from '@jest/globals';

import type { SlackTool } from '../../../src/types/mcp.js';
import type { SlackTokens } from '../../../src/types/slack.js';
import type * as MockModule from '../../__mocks__/@slack/web-api.js';

// ESM Jest does NOT hoist jest.mock above static imports. Use
// jest.unstable_mockModule + dynamic imports so the modules under test
// resolve @slack/web-api to our manual mock fixture.
let mockWebClient: typeof MockModule.mockWebClient;
let WebClientMock: typeof MockModule.WebClient;
let setupChannelCapabilities: typeof import('../../../src/capabilities/channels.js').setupChannelCapabilities;
let slackClientManager: typeof import('../../../src/utils/slack-client.js').slackClientManager;
let permissionManager: typeof import('../../../src/auth/permissions.js').permissionManager;
let AuthError: typeof import('../../../src/errors/index.js').AuthError;

beforeAll(async () => {
  const mockMod = await import('../../__mocks__/@slack/web-api.js');
  jest.unstable_mockModule('@slack/web-api', () => mockMod);
  mockWebClient = mockMod.mockWebClient;
  WebClientMock = mockMod.WebClient;
  ({ setupChannelCapabilities } = await import('../../../src/capabilities/channels.js'));
  ({ slackClientManager } = await import('../../../src/utils/slack-client.js'));
  ({ permissionManager } = await import('../../../src/auth/permissions.js'));
  ({ AuthError } = await import('../../../src/errors/index.js'));
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

describe('channels capability', () => {
  let tools: Map<string, CapturedTool>;
  let permSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    resetMockWebClient();
    (WebClientMock as unknown as jest.Mock).mockImplementation(() => mockWebClient);

    if (!slackClientManager.listWorkspaces().includes('T1')) {
      slackClientManager.addWorkspace('T1', TOKENS());
    }

    permSpy = jest
      .spyOn(permissionManager, 'requirePermission')
      .mockResolvedValue(undefined as never);

    const server = makeFakeServer();
    setupChannelCapabilities(server as any);
    tools = server.tools;
  });

  afterEach(() => {
    permSpy.mockRestore();
  });

  it('registers all expected channel tools', () => {
    const expected = [
      'list_channels',
      'create_channel',
      'get_channel_info',
      'join_channel',
      'leave_channel',
      'archive_channel',
      'unarchive_channel',
      'set_channel_topic',
      'set_channel_purpose',
      'invite_to_channel',
      'get_channel_members',
    ];
    expect([...tools.keys()]).toEqual(expect.arrayContaining(expected));
    // Source registers exactly 11 tools today (see src/capabilities/channels.ts).
    expect(tools.size).toBe(expected.length);
  });

  describe('list_channels', () => {
    it('calls conversations.list with default types + capped limit', async () => {
      mockWebClient.apiCall.mockResolvedValue({ ok: true, channels: [] } as never);
      await tools.get('list_channels')!.handler({
        workspace_id: 'T1',
        user_id: 'U1',
      });
      expect(permSpy).toHaveBeenCalledWith('T1', 'U1', 'list_channels');
      expect(mockWebClient.apiCall).toHaveBeenCalledWith(
        'conversations.list',
        expect.objectContaining({
          types: 'public_channel,private_channel',
          exclude_archived: false,
          limit: 100,
        }),
      );
    });

    it('forwards an explicit types filter', async () => {
      mockWebClient.apiCall.mockResolvedValue({ ok: true, channels: [] } as never);
      await tools.get('list_channels')!.handler({
        workspace_id: 'T1',
        user_id: 'U1',
        types: 'public_channel',
        limit: 5000, // should be capped to 1000
      });
      expect(mockWebClient.apiCall).toHaveBeenCalledWith(
        'conversations.list',
        expect.objectContaining({ types: 'public_channel', limit: 1000 }),
      );
    });
  });

  describe('create_channel', () => {
    it('calls conversations.create with normalized name + is_private', async () => {
      mockWebClient.apiCall.mockResolvedValue({
        ok: true,
        channel: { id: 'C1234567890', name: 'eng-team', is_private: false },
      } as never);
      const result = await tools.get('create_channel')!.handler({
        workspace_id: 'T1',
        user_id: 'U1',
        name: 'Eng-Team',
        is_private: false,
      });
      expect(mockWebClient.apiCall).toHaveBeenCalledWith(
        'conversations.create',
        expect.objectContaining({ name: 'eng-team', is_private: false }),
      );
      expect(result).toEqual(expect.objectContaining({ success: true }));
    });

    it('rejects an empty name via Zod', async () => {
      await expect(
        tools.get('create_channel')!.handler({
          workspace_id: 'T1',
          user_id: 'U1',
          name: '',
        }),
      ).rejects.toBeDefined();
      expect(mockWebClient.apiCall).not.toHaveBeenCalled();
    });

    it('rejects a name longer than 21 chars', async () => {
      await expect(
        tools.get('create_channel')!.handler({
          workspace_id: 'T1',
          user_id: 'U1',
          name: 'a'.repeat(22),
        }),
      ).rejects.toBeDefined();
      expect(mockWebClient.apiCall).not.toHaveBeenCalled();
    });
  });

  describe('get_channel_info', () => {
    it('calls conversations.info with channel id', async () => {
      mockWebClient.apiCall.mockResolvedValue({
        ok: true,
        channel: { id: 'C1234567890' },
      } as never);
      await tools.get('get_channel_info')!.handler({
        workspace_id: 'T1',
        user_id: 'U1',
        channel: 'C1234567890',
      });
      expect(mockWebClient.apiCall).toHaveBeenCalledWith(
        'conversations.info',
        expect.objectContaining({ channel: 'C1234567890', include_locale: false }),
      );
    });

    it('rejects an invalid workspace id (lowercase)', async () => {
      // get_channel_info doesn't validate the channel id explicitly, but it
      // does validate the workspace id - exercise that path.
      await expect(
        tools.get('get_channel_info')!.handler({
          workspace_id: 'badws',
          user_id: 'U1',
          channel: 'C1234567890',
        }),
      ).rejects.toBeDefined();
      expect(mockWebClient.apiCall).not.toHaveBeenCalled();
    });
  });

  describe('join_channel / leave_channel', () => {
    it('join calls conversations.join with channel', async () => {
      mockWebClient.apiCall.mockResolvedValue({
        ok: true,
        channel: { id: 'C1234567890', name: 'general' },
      } as never);
      await tools.get('join_channel')!.handler({
        workspace_id: 'T1',
        user_id: 'U1',
        channel: 'C1234567890',
      });
      expect(mockWebClient.apiCall).toHaveBeenCalledWith(
        'conversations.join',
        expect.objectContaining({ channel: 'C1234567890' }),
      );
    });

    it('leave calls conversations.leave with channel', async () => {
      mockWebClient.apiCall.mockResolvedValue({ ok: true } as never);
      const result = await tools.get('leave_channel')!.handler({
        workspace_id: 'T1',
        user_id: 'U1',
        channel: 'C1234567890',
      });
      expect(mockWebClient.apiCall).toHaveBeenCalledWith(
        'conversations.leave',
        expect.objectContaining({ channel: 'C1234567890' }),
      );
      expect(result).toEqual(expect.objectContaining({ success: true, is_member: false }));
    });
  });

  describe('archive / unarchive', () => {
    it('archive_channel calls conversations.archive', async () => {
      mockWebClient.apiCall.mockResolvedValue({ ok: true } as never);
      await tools.get('archive_channel')!.handler({
        workspace_id: 'T1',
        user_id: 'U1',
        channel: 'C1234567890',
      });
      expect(mockWebClient.apiCall).toHaveBeenCalledWith(
        'conversations.archive',
        expect.objectContaining({ channel: 'C1234567890' }),
      );
    });

    it('unarchive_channel calls conversations.unarchive', async () => {
      mockWebClient.apiCall.mockResolvedValue({ ok: true } as never);
      await tools.get('unarchive_channel')!.handler({
        workspace_id: 'T1',
        user_id: 'U1',
        channel: 'C1234567890',
      });
      expect(mockWebClient.apiCall).toHaveBeenCalledWith(
        'conversations.unarchive',
        expect.objectContaining({ channel: 'C1234567890' }),
      );
    });

    it('archive_channel rejects an invalid channel id', async () => {
      await expect(
        tools.get('archive_channel')!.handler({
          workspace_id: 'T1',
          user_id: 'U1',
          channel: 'not-a-channel-id',
        }),
      ).rejects.toBeDefined();
      expect(mockWebClient.apiCall).not.toHaveBeenCalled();
    });
  });

  describe('set_channel_topic / set_channel_purpose', () => {
    it('set_channel_topic calls conversations.setTopic with channel + topic', async () => {
      mockWebClient.apiCall.mockResolvedValue({ ok: true, topic: 'roadmap' } as never);
      await tools.get('set_channel_topic')!.handler({
        workspace_id: 'T1',
        user_id: 'U1',
        channel: 'C1234567890',
        topic: 'roadmap',
      });
      expect(mockWebClient.apiCall).toHaveBeenCalledWith(
        'conversations.setTopic',
        expect.objectContaining({ channel: 'C1234567890', topic: 'roadmap' }),
      );
    });

    it('set_channel_topic truncates topics longer than 250 chars before forwarding', async () => {
      mockWebClient.apiCall.mockResolvedValue({ ok: true, topic: 'a'.repeat(250) } as never);
      await tools.get('set_channel_topic')!.handler({
        workspace_id: 'T1',
        user_id: 'U1',
        channel: 'C1234567890',
        topic: 'a'.repeat(400),
      });
      const sentTopic = (mockWebClient.apiCall.mock.calls[0]![1] as any).topic;
      expect(sentTopic).toHaveLength(250);
    });

    it('set_channel_purpose calls conversations.setPurpose with channel + purpose', async () => {
      mockWebClient.apiCall.mockResolvedValue({ ok: true, purpose: 'support' } as never);
      await tools.get('set_channel_purpose')!.handler({
        workspace_id: 'T1',
        user_id: 'U1',
        channel: 'C1234567890',
        purpose: 'support',
      });
      expect(mockWebClient.apiCall).toHaveBeenCalledWith(
        'conversations.setPurpose',
        expect.objectContaining({ channel: 'C1234567890', purpose: 'support' }),
      );
    });
  });

  describe('invite_to_channel', () => {
    it('calls conversations.invite with channel + users', async () => {
      mockWebClient.apiCall.mockResolvedValue({
        ok: true,
        channel: { id: 'C1234567890' },
      } as never);
      const result = await tools.get('invite_to_channel')!.handler({
        workspace_id: 'T1',
        user_id: 'U1',
        channel: 'C1234567890',
        users: 'U111,U222',
      });
      expect(mockWebClient.apiCall).toHaveBeenCalledWith(
        'conversations.invite',
        expect.objectContaining({ channel: 'C1234567890', users: 'U111,U222' }),
      );
      expect(result).toEqual(
        expect.objectContaining({ success: true, invited_users: ['U111', 'U222'] }),
      );
    });
  });

  describe('get_channel_members', () => {
    it('calls conversations.members with channel + capped limit', async () => {
      mockWebClient.apiCall.mockResolvedValue({
        ok: true,
        members: ['U111', 'U222'],
      } as never);
      await tools.get('get_channel_members')!.handler({
        workspace_id: 'T1',
        user_id: 'U1',
        channel: 'C1234567890',
        limit: 5000,
      });
      expect(mockWebClient.apiCall).toHaveBeenCalledWith(
        'conversations.members',
        expect.objectContaining({ channel: 'C1234567890', limit: 1000 }),
      );
    });
  });

  describe('permission gating', () => {
    it('list_channels surfaces permission failures via the wrapped error', async () => {
      permSpy.mockRejectedValue(new AuthError('perm denied'));
      await expect(
        tools.get('list_channels')!.handler({
          workspace_id: 'T1',
          user_id: 'U1',
        }),
      ).rejects.toBeInstanceOf(AuthError);
      expect(mockWebClient.apiCall).not.toHaveBeenCalled();
    });
  });
});
