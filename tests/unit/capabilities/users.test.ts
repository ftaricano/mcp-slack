import { jest } from '@jest/globals';

import type { SlackTool } from '../../../src/types/mcp.js';
import type { SlackTokens } from '../../../src/types/slack.js';
import type * as MockModule from '../../__mocks__/@slack/web-api.js';

// ESM Jest does NOT hoist jest.mock above static imports. Use
// jest.unstable_mockModule + dynamic imports so the modules under test
// resolve @slack/web-api to our manual mock fixture.
let mockWebClient: typeof MockModule.mockWebClient;
let WebClientMock: typeof MockModule.WebClient;
let setupUserCapabilities: typeof import('../../../src/capabilities/users.js').setupUserCapabilities;
let slackClientManager: typeof import('../../../src/utils/slack-client.js').slackClientManager;
let permissionManager: typeof import('../../../src/auth/permissions.js').permissionManager;
let AuthError: typeof import('../../../src/errors/index.js').AuthError;

beforeAll(async () => {
  const mockMod = await import('../../__mocks__/@slack/web-api.js');
  jest.unstable_mockModule('@slack/web-api', () => mockMod);
  mockWebClient = mockMod.mockWebClient;
  WebClientMock = mockMod.WebClient;
  ({ setupUserCapabilities } = await import('../../../src/capabilities/users.js'));
  ({ slackClientManager } = await import('../../../src/utils/slack-client.js'));
  ({ permissionManager } = await import('../../../src/auth/permissions.js'));
  ({ AuthError } = await import('../../../src/errors/index.js'));
});

const TOKENS = (overrides: Partial<SlackTokens> = {}): SlackTokens => ({
  access_token: 'bot-token-test',
  token_type: 'bot',
  scope: 'users:read',
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

describe('users capability', () => {
  let tools: Map<string, CapturedTool>;
  let permSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    resetMockWebClient();
    // restoreMocks: true strips the WebClient constructor's mockImplementation
    // between tests. Re-attach defensively in case the singleton recreates a
    // client.
    (WebClientMock as unknown as jest.Mock).mockImplementation(() => mockWebClient);

    if (!slackClientManager.listWorkspaces().includes('T1')) {
      slackClientManager.addWorkspace('T1', TOKENS());
    }

    permSpy = jest
      .spyOn(permissionManager, 'requirePermission')
      .mockResolvedValue(undefined as never);

    const server = makeFakeServer();
    setupUserCapabilities(server as any);
    tools = server.tools;
  });

  afterEach(() => {
    permSpy.mockRestore();
  });

  it('registers all 10 user tools', () => {
    expect([...tools.keys()]).toEqual(
      expect.arrayContaining([
        'list_users',
        'get_user_info',
        'get_user_presence',
        'set_user_status',
        'get_user_profile',
        'set_user_presence',
        'lookup_user_by_email',
        'get_user_groups',
        'get_user_conversations',
        'get_team_info',
      ]),
    );
    expect(tools.size).toBe(10);
  });

  describe('list_users', () => {
    it('calls users.list with default limit', async () => {
      mockWebClient.apiCall.mockResolvedValue({
        ok: true,
        members: [],
        response_metadata: {},
      } as never);
      const result = await tools.get('list_users')!.handler({
        workspace_id: 'T1',
        user_id: 'U1',
      });
      expect(permSpy).toHaveBeenCalledWith('T1', 'U1', 'list_users');
      expect(mockWebClient.apiCall).toHaveBeenCalledWith(
        'users.list',
        expect.objectContaining({ limit: 100, include_locale: false }),
      );
      expect(result).toEqual(expect.objectContaining({ success: true }));
    });
  });

  describe('get_user_info', () => {
    it('calls users.info with user id', async () => {
      mockWebClient.apiCall.mockResolvedValue({ ok: true, user: { id: 'U2' } } as never);
      await tools.get('get_user_info')!.handler({
        workspace_id: 'T1',
        user_id: 'U1',
        user: 'U2',
      });
      expect(mockWebClient.apiCall).toHaveBeenCalledWith(
        'users.info',
        expect.objectContaining({ user: 'U2', include_locale: false }),
      );
    });

    it('rejects an invalid user id (lowercase)', async () => {
      await expect(
        tools.get('get_user_info')!.handler({
          workspace_id: 'T1',
          user_id: 'U1',
          user: 'u2',
        }),
      ).rejects.toBeDefined();
      expect(mockWebClient.apiCall).not.toHaveBeenCalled();
    });
  });

  describe('get_user_presence / set_user_presence', () => {
    it('get_user_presence calls users.getPresence with user', async () => {
      mockWebClient.apiCall.mockResolvedValue({ ok: true, presence: 'active' } as never);
      const result = await tools.get('get_user_presence')!.handler({
        workspace_id: 'T1',
        user_id: 'U1',
        user: 'U2',
      });
      expect(mockWebClient.apiCall).toHaveBeenCalledWith(
        'users.getPresence',
        expect.objectContaining({ user: 'U2' }),
      );
      expect(result).toEqual(expect.objectContaining({ success: true, presence: 'active' }));
    });

    it('set_user_presence calls users.setPresence with presence', async () => {
      mockWebClient.apiCall.mockResolvedValue({ ok: true } as never);
      await tools.get('set_user_presence')!.handler({
        workspace_id: 'T1',
        user_id: 'U1',
        presence: 'away',
      });
      expect(mockWebClient.apiCall).toHaveBeenCalledWith(
        'users.setPresence',
        expect.objectContaining({ presence: 'away' }),
      );
    });
  });

  describe('set_user_status', () => {
    it('calls users.profile.set with status_text + status_emoji (colons stripped)', async () => {
      mockWebClient.apiCall.mockResolvedValue({
        ok: true,
        profile: { status_text: 'Coffee break', status_emoji: 'coffee' },
      } as never);
      await tools.get('set_user_status')!.handler({
        workspace_id: 'T1',
        user_id: 'U1',
        status_text: 'Coffee break',
        status_emoji: ':coffee:',
      });
      expect(mockWebClient.apiCall).toHaveBeenCalledWith(
        'users.profile.set',
        expect.objectContaining({
          profile: expect.objectContaining({
            status_text: 'Coffee break',
            status_emoji: 'coffee',
          }),
        }),
      );
    });

    it('truncates status_text > 100 chars to 100 (handler does not reject)', async () => {
      mockWebClient.apiCall.mockResolvedValue({ ok: true, profile: {} } as never);
      const long = 'a'.repeat(150);
      await tools.get('set_user_status')!.handler({
        workspace_id: 'T1',
        user_id: 'U1',
        status_text: long,
        status_emoji: '',
      });
      const sent = (mockWebClient.apiCall.mock.calls[0]![1] as any).profile.status_text;
      expect(sent).toHaveLength(100);
    });
  });

  describe('get_user_profile', () => {
    it('calls users.profile.get with user', async () => {
      mockWebClient.apiCall.mockResolvedValue({ ok: true, profile: {} } as never);
      await tools.get('get_user_profile')!.handler({
        workspace_id: 'T1',
        user_id: 'U1',
        user: 'U2',
      });
      expect(mockWebClient.apiCall).toHaveBeenCalledWith(
        'users.profile.get',
        expect.objectContaining({ user: 'U2', include_labels: false }),
      );
    });
  });

  describe('lookup_user_by_email', () => {
    it('calls users.lookupByEmail with email', async () => {
      mockWebClient.apiCall.mockResolvedValue({
        ok: true,
        user: { id: 'U2', profile: { email: 'a@b.com' } },
      } as never);
      await tools.get('lookup_user_by_email')!.handler({
        workspace_id: 'T1',
        user_id: 'U1',
        email: 'a@b.com',
      });
      expect(mockWebClient.apiCall).toHaveBeenCalledWith(
        'users.lookupByEmail',
        expect.objectContaining({ email: 'a@b.com' }),
      );
    });
  });

  describe('get_user_groups', () => {
    it('calls usergroups.list', async () => {
      mockWebClient.apiCall.mockResolvedValue({ ok: true, usergroups: [] } as never);
      await tools.get('get_user_groups')!.handler({
        workspace_id: 'T1',
        user_id: 'U1',
      });
      expect(mockWebClient.apiCall).toHaveBeenCalledWith(
        'usergroups.list',
        expect.objectContaining({
          include_disabled: false,
          include_count: false,
          include_users: false,
        }),
      );
    });
  });

  describe('get_user_conversations', () => {
    it('calls users.conversations with capped limit + default types', async () => {
      mockWebClient.apiCall.mockResolvedValue({
        ok: true,
        channels: [],
        response_metadata: {},
      } as never);
      await tools.get('get_user_conversations')!.handler({
        workspace_id: 'T1',
        user_id: 'U1',
      });
      expect(mockWebClient.apiCall).toHaveBeenCalledWith(
        'users.conversations',
        expect.objectContaining({
          types: 'public_channel,private_channel,mpim,im',
          exclude_archived: false,
          limit: 100,
        }),
      );
    });
  });

  describe('get_team_info', () => {
    it('calls team.info', async () => {
      mockWebClient.apiCall.mockResolvedValue({
        ok: true,
        team: { id: 'T1', name: 'Test' },
      } as never);
      const result = await tools.get('get_team_info')!.handler({
        workspace_id: 'T1',
        user_id: 'U1',
      });
      expect(mockWebClient.apiCall).toHaveBeenCalledWith('team.info', expect.any(Object));
      expect(result).toEqual(expect.objectContaining({ success: true }));
    });
  });

  describe('permission gating', () => {
    it('blocks list_users when permission rejects', async () => {
      permSpy.mockRejectedValue(new AuthError('perm denied'));
      await expect(
        tools.get('list_users')!.handler({
          workspace_id: 'T1',
          user_id: 'U1',
        }),
      ).rejects.toBeInstanceOf(AuthError);
      expect(mockWebClient.apiCall).not.toHaveBeenCalled();
    });
  });
});
