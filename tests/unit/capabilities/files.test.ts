import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { jest } from '@jest/globals';

import type { SlackTool } from '../../../src/types/mcp.js';
import type { SlackTokens } from '../../../src/types/slack.js';
import type * as MockModule from '../../__mocks__/@slack/web-api.js';

// ESM Jest does NOT hoist jest.mock above static imports. Use
// jest.unstable_mockModule + dynamic imports so the modules under test
// resolve @slack/web-api to our manual mock fixture.
let mockWebClient: typeof MockModule.mockWebClient;
let WebClientMock: typeof MockModule.WebClient;
let setupFileCapabilities: typeof import('../../../src/capabilities/files.js').setupFileCapabilities;
let slackClientManager: typeof import('../../../src/utils/slack-client.js').slackClientManager;
let permissionManager: typeof import('../../../src/auth/permissions.js').permissionManager;
let AuthError: typeof import('../../../src/errors/index.js').AuthError;

beforeAll(async () => {
  const mockMod = await import('../../__mocks__/@slack/web-api.js');
  jest.unstable_mockModule('@slack/web-api', () => mockMod);
  mockWebClient = mockMod.mockWebClient;
  WebClientMock = mockMod.WebClient;
  ({ setupFileCapabilities } = await import('../../../src/capabilities/files.js'));
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

describe('files capability', () => {
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
    setupFileCapabilities(server as any);
    tools = server.tools;
  });

  afterEach(() => {
    permSpy.mockRestore();
  });

  it('registers all 8 file tools', () => {
    expect([...tools.keys()]).toEqual(
      expect.arrayContaining([
        'upload_file',
        'get_file_info',
        'list_files',
        'delete_file',
        'share_file',
        'add_file_comment',
        'get_file_comments',
        'revoke_file_public_url',
      ]),
    );
    expect(tools.size).toBeGreaterThanOrEqual(8);
  });

  describe('upload_file', () => {
    it('calls files.upload with validated args', async () => {
      mockWebClient.apiCall.mockResolvedValue({
        ok: true,
        file: {
          id: 'F123',
          name: 'note.txt',
          title: 'Note',
          mimetype: 'text/plain',
          size: 5,
          permalink: 'https://x/permalink',
          url_private: 'https://x/private',
          channels: ['C1234567890'],
        },
      } as never);

      const result = await tools.get('upload_file')!.handler({
        workspace_id: 'T1',
        user_id: 'U1',
        filename: 'note.txt',
        content: 'hello',
        title: 'Note',
        filetype: 'text',
      });

      expect(permSpy).toHaveBeenCalledWith('T1', 'U1', 'upload_file');
      expect(mockWebClient.apiCall).toHaveBeenCalledWith(
        'files.upload',
        expect.objectContaining({
          filename: 'note.txt',
          content: 'hello',
          title: 'Note',
          filetype: 'text',
        }),
      );
      expect(result).toEqual(
        expect.objectContaining({
          success: true,
          file: expect.objectContaining({
            id: 'F123',
            name: 'note.txt',
            channels: ['C1234567890'],
          }),
        }),
      );
    });

    it('rejects local file path uploads by default', async () => {
      await expect(
        tools.get('upload_file')!.handler({
          workspace_id: 'T1',
          user_id: 'U1',
          filename: 'secret.txt',
          file: '/etc/hosts',
        }),
      ).rejects.toThrow(/file path uploads are disabled/i);
      expect(mockWebClient.apiCall).not.toHaveBeenCalled();
    });

    it('allows local file path uploads only inside the configured root', async () => {
      const previousAllow = process.env.MCP_SLACK_ALLOW_FILE_PATH_UPLOADS;
      const previousRoot = process.env.MCP_SLACK_FILE_UPLOAD_ROOT;
      const root = mkdtempSync(join(tmpdir(), 'mcp-slack-upload-root-'));
      const file = join(root, 'note.txt');
      writeFileSync(file, 'hello');
      process.env.MCP_SLACK_ALLOW_FILE_PATH_UPLOADS = 'true';
      process.env.MCP_SLACK_FILE_UPLOAD_ROOT = root;
      mockWebClient.apiCall.mockResolvedValue({ ok: true, file: {} } as never);

      try {
        await tools.get('upload_file')!.handler({
          workspace_id: 'T1',
          user_id: 'U1',
          filename: 'note.txt',
          file: 'note.txt',
        });
      } finally {
        if (previousAllow === undefined) delete process.env.MCP_SLACK_ALLOW_FILE_PATH_UPLOADS;
        else process.env.MCP_SLACK_ALLOW_FILE_PATH_UPLOADS = previousAllow;
        if (previousRoot === undefined) delete process.env.MCP_SLACK_FILE_UPLOAD_ROOT;
        else process.env.MCP_SLACK_FILE_UPLOAD_ROOT = previousRoot;
        rmSync(root, { recursive: true, force: true });
      }

      expect(mockWebClient.apiCall).toHaveBeenCalledWith(
        'files.upload',
        expect.objectContaining({ file: expect.stringMatching(/note\.txt$/) }),
      );
    });

    it('strips workspace_id/user_id from the Slack payload', async () => {
      mockWebClient.apiCall.mockResolvedValue({ ok: true, file: {} } as never);

      await tools.get('upload_file')!.handler({
        workspace_id: 'T1',
        user_id: 'U1',
        filename: 'a.txt',
        content: 'x',
      });

      const payload = mockWebClient.apiCall.mock.calls[0]![1] as Record<string, unknown>;
      expect(payload).not.toHaveProperty('workspace_id');
      expect(payload).not.toHaveProperty('user_id');
    });
  });

  describe('get_file_info', () => {
    it('calls files.info with file id and capped count', async () => {
      mockWebClient.apiCall.mockResolvedValue({
        ok: true,
        file: { id: 'F123' },
        comments: [],
        paging: { count: 100, page: 1 },
      } as never);

      const result = await tools.get('get_file_info')!.handler({
        workspace_id: 'T1',
        user_id: 'U1',
        file: 'F123',
        count: 5000, // exceeds max — handler caps at 1000
      });

      expect(permSpy).toHaveBeenCalledWith('T1', 'U1', 'read_file');
      expect(mockWebClient.apiCall).toHaveBeenCalledWith(
        'files.info',
        expect.objectContaining({ file: 'F123', count: 1000, page: 1 }),
      );
      expect(result).toEqual(
        expect.objectContaining({ success: true, file: { id: 'F123' }, comments: [] }),
      );
    });
  });

  describe('list_files', () => {
    it('calls files.list with parsed types + filters', async () => {
      mockWebClient.apiCall.mockResolvedValue({
        ok: true,
        files: [{ id: 'F1' }, { id: 'F2' }],
        paging: { page: 1 },
      } as never);

      await tools.get('list_files')!.handler({
        workspace_id: 'T1',
        user_id: 'U1',
        channel: 'C1234567890',
        types: 'images,pdfs',
        count: 50,
        page: 2,
      });

      expect(permSpy).toHaveBeenCalledWith('T1', 'U1', 'read_file');
      expect(mockWebClient.apiCall).toHaveBeenCalledWith(
        'files.list',
        expect.objectContaining({
          channel: 'C1234567890',
          types: ['images', 'pdfs'],
          count: 50,
          page: 2,
        }),
      );
    });

    it('returns total_count derived from files length', async () => {
      mockWebClient.apiCall.mockResolvedValue({
        ok: true,
        files: [{ id: 'F1' }, { id: 'F2' }, { id: 'F3' }],
        paging: {},
      } as never);

      const result = await tools.get('list_files')!.handler({
        workspace_id: 'T1',
        user_id: 'U1',
      });

      expect(result).toEqual(expect.objectContaining({ success: true, total_count: 3 }));
    });
  });

  describe('delete_file', () => {
    it('calls files.delete with file id and returns deleted_file', async () => {
      mockWebClient.apiCall.mockResolvedValue({ ok: true } as never);

      const result = await tools.get('delete_file')!.handler({
        workspace_id: 'T1',
        user_id: 'U1',
        file: 'F123',
      });

      expect(permSpy).toHaveBeenCalledWith('T1', 'U1', 'upload_file');
      expect(mockWebClient.apiCall).toHaveBeenCalledWith(
        'files.delete',
        expect.objectContaining({ file: 'F123' }),
      );
      expect(result).toEqual(expect.objectContaining({ success: true, deleted_file: 'F123' }));
    });
  });

  describe('share_file', () => {
    it('calls files.sharedPublicURL with file id and returns public_url', async () => {
      mockWebClient.apiCall.mockResolvedValue({
        ok: true,
        file: { id: 'F123', permalink_public: 'https://slack-files.com/pub-xyz' },
      } as never);

      const result = await tools.get('share_file')!.handler({
        workspace_id: 'T1',
        user_id: 'U1',
        file: 'F123',
        channel: 'C1234567890',
      });

      expect(permSpy).toHaveBeenCalledWith('T1', 'U1', 'upload_file');
      expect(mockWebClient.apiCall).toHaveBeenCalledWith(
        'files.sharedPublicURL',
        expect.objectContaining({ file: 'F123' }),
      );
      expect(result).toEqual(
        expect.objectContaining({
          success: true,
          public_url: 'https://slack-files.com/pub-xyz',
        }),
      );
    });
  });

  describe('add_file_comment / get_file_comments', () => {
    it('add_file_comment calls files.comments.add with file + comment', async () => {
      mockWebClient.apiCall.mockResolvedValue({
        ok: true,
        comment: { id: 'Fc1', comment: 'nice' },
      } as never);

      const result = await tools.get('add_file_comment')!.handler({
        workspace_id: 'T1',
        user_id: 'U1',
        file: 'F123',
        comment: 'nice',
      });

      expect(permSpy).toHaveBeenCalledWith('T1', 'U1', 'send_message');
      expect(mockWebClient.apiCall).toHaveBeenCalledWith(
        'files.comments.add',
        expect.objectContaining({ file: 'F123', comment: 'nice' }),
      );
      expect(result).toEqual(
        expect.objectContaining({ success: true, comment: { id: 'Fc1', comment: 'nice' } }),
      );
    });

    it('get_file_comments routes through files.info and surfaces comments list', async () => {
      mockWebClient.apiCall.mockResolvedValue({
        ok: true,
        file: { id: 'F123' },
        comments: [{ id: 'Fc1' }, { id: 'Fc2' }],
        paging: {},
      } as never);

      const result = await tools.get('get_file_comments')!.handler({
        workspace_id: 'T1',
        user_id: 'U1',
        file: 'F123',
      });

      expect(permSpy).toHaveBeenCalledWith('T1', 'U1', 'read_file');
      expect(mockWebClient.apiCall).toHaveBeenCalledWith(
        'files.info',
        expect.objectContaining({ file: 'F123', count: 100, page: 1 }),
      );
      expect(result).toEqual(
        expect.objectContaining({
          success: true,
          file_id: 'F123',
          total_comments: 2,
        }),
      );
    });
  });

  describe('revoke_file_public_url', () => {
    it('calls files.revokePublicURL with file id', async () => {
      mockWebClient.apiCall.mockResolvedValue({
        ok: true,
        file: { id: 'F123' },
      } as never);

      const result = await tools.get('revoke_file_public_url')!.handler({
        workspace_id: 'T1',
        user_id: 'U1',
        file: 'F123',
      });

      expect(permSpy).toHaveBeenCalledWith('T1', 'U1', 'upload_file');
      expect(mockWebClient.apiCall).toHaveBeenCalledWith(
        'files.revokePublicURL',
        expect.objectContaining({ file: 'F123' }),
      );
      expect(result).toEqual(expect.objectContaining({ success: true, public_url_revoked: true }));
    });
  });

  describe('permission gating', () => {
    it('blocks upload_file when permission rejects', async () => {
      permSpy.mockRejectedValue(new AuthError('perm denied'));

      await expect(
        tools.get('upload_file')!.handler({
          workspace_id: 'T1',
          user_id: 'U1',
          filename: 'a.txt',
          content: 'x',
        }),
      ).rejects.toBeInstanceOf(AuthError);
      expect(mockWebClient.apiCall).not.toHaveBeenCalled();
    });

    it('blocks delete_file when permission rejects', async () => {
      permSpy.mockRejectedValue(new AuthError('perm denied'));

      await expect(
        tools.get('delete_file')!.handler({
          workspace_id: 'T1',
          user_id: 'U1',
          file: 'F123',
        }),
      ).rejects.toBeInstanceOf(AuthError);
      expect(mockWebClient.apiCall).not.toHaveBeenCalled();
    });
  });
});
