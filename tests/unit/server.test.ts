import { jest } from '@jest/globals';

import type { SlackTokens } from '../../src/types/slack.js';
import type * as MockModule from '../__mocks__/@slack/web-api.js';

// ESM Jest does NOT hoist jest.mock above static imports. Use
// jest.unstable_mockModule + dynamic imports so the modules under test
// resolve their dependencies to our manual mock fixtures.
let mockWebClient: typeof MockModule.mockWebClient;
let SlackMCPServer: typeof import('../../src/server.js').SlackMCPServer;
let slackClientManager: typeof import('../../src/utils/slack-client.js').slackClientManager;
let permissionManager: typeof import('../../src/auth/permissions.js').permissionManager;

beforeAll(async () => {
  const mockMod = await import('../__mocks__/@slack/web-api.js');
  jest.unstable_mockModule('@slack/web-api', () => mockMod);

  // The MCP SDK ships pure ESM that Jest's CJS transform cannot parse. Stub
  // the minimal surface area SlackMCPServer touches with eagerly-resolved
  // module objects (factory must not return a Promise to avoid OOM in the
  // ESM module loader).
  const sdkServerMock = {
    Server: jest.fn().mockImplementation(() => ({
      setRequestHandler: jest.fn(),
      connect: jest.fn(),
      close: jest.fn(),
      onerror: undefined,
    })),
  };
  jest.unstable_mockModule('@modelcontextprotocol/sdk/server/index.js', () => sdkServerMock);

  const sdkStdioMock = {
    StdioServerTransport: jest.fn().mockImplementation(() => ({})),
  };
  jest.unstable_mockModule('@modelcontextprotocol/sdk/server/stdio.js', () => sdkStdioMock);

  class McpError extends Error {
    code: number;
    constructor(code: number, message: string) {
      super(message);
      this.code = code;
      this.name = 'McpError';
    }
  }
  const sdkTypesMock = {
    CallToolRequestSchema: { method: 'tools/call' },
    ListResourcesRequestSchema: { method: 'resources/list' },
    ListToolsRequestSchema: { method: 'tools/list' },
    ReadResourceRequestSchema: { method: 'resources/read' },
    ErrorCode: { InvalidRequest: -32600, InvalidParams: -32602, InternalError: -32603 },
    McpError,
  };
  jest.unstable_mockModule('@modelcontextprotocol/sdk/types.js', () => sdkTypesMock);

  mockWebClient = mockMod.mockWebClient;
  ({ SlackMCPServer } = await import('../../src/server.js'));
  ({ slackClientManager } = await import('../../src/utils/slack-client.js'));
  ({ permissionManager } = await import('../../src/auth/permissions.js'));
});

const TOKENS: SlackTokens = {
  access_token: 'xoxb',
  token_type: 'bot',
  scope: 'chat:write',
  bot_user_id: 'U-bot',
  app_id: 'A1',
  team: { id: 'T1', name: 'Test' },
  authed_user: {
    id: 'U1',
    scope: 'identify',
    access_token: 'xoxp',
    token_type: 'user',
  },
};

describe('SlackMCPServer wiring', () => {
  let server: InstanceType<typeof SlackMCPServer>;
  let permSpy: ReturnType<typeof jest.spyOn> | undefined;

  beforeEach(() => {
    mockWebClient.apiCall.mockReset();
    if (!slackClientManager.listWorkspaces().includes('T1')) {
      slackClientManager.addWorkspace('T1', TOKENS);
    }
    permSpy = jest
      .spyOn(permissionManager, 'requirePermission')
      .mockResolvedValue(undefined as never);

    server = new SlackMCPServer({
      name: 'test-server',
      version: '0.0.0',
      capabilities: { resources: true, tools: true, prompts: false, logging: false },
    });
  });

  afterEach(() => {
    permSpy?.mockRestore();
  });

  it('registers all expected MCP tools across all 4 capabilities', () => {
    const names = server.listToolNames();
    expect(names.length).toBeGreaterThanOrEqual(37);
    expect(names).toEqual(
      expect.arrayContaining([
        'send_message',
        'update_message',
        'delete_message',
        'add_reaction',
        'list_channels',
        'create_channel',
        'archive_channel',
        'set_channel_topic',
        'list_users',
        'get_user_info',
        'lookup_user_by_email',
        'get_team_info',
        'upload_file',
        'list_files',
        'delete_file',
      ]),
    );
  });

  it('callTool dispatches send_message to the messages handler', async () => {
    mockWebClient.apiCall.mockResolvedValue({
      ok: true,
      ts: '1234567890.123456',
      channel: 'C1234567890',
    } as never);
    const result = await server.callTool('send_message', {
      workspace_id: 'T1',
      user_id: 'U1',
      channel: 'C1234567890',
      text: 'hi from test',
    });
    expect(mockWebClient.apiCall).toHaveBeenCalledWith(
      'chat.postMessage',
      expect.objectContaining({ channel: 'C1234567890', text: 'hi from test' }),
    );
    expect(result).toEqual(expect.objectContaining({ success: true }));
  });

  it('callTool throws when tool name is unknown', async () => {
    await expect(server.callTool('nonexistent_tool', {})).rejects.toThrow(/No handler found/i);
  });

  it('registerTool / unregisterTool round-trip', () => {
    const before = server.listToolNames().length;
    server.registerTool(
      {
        name: 'test_tool',
        description: 'x',
        inputSchema: { type: 'object', properties: {}, required: [] },
      },
      async (args: any) => ({ echo: args }),
    );
    expect(server.listToolNames()).toContain('test_tool');
    expect(server.listToolNames().length).toBe(before + 1);
    server.unregisterTool('test_tool');
    expect(server.listToolNames()).not.toContain('test_tool');
    expect(server.listToolNames().length).toBe(before);
  });

  it('registerResource / unregisterResource round-trip does not throw', () => {
    server.registerResource({
      uri: 'slack://test/T1',
      name: 'test',
      description: 'x',
      mimeType: 'application/json',
    });
    server.unregisterResource('slack://test/T1');
    expect(() => server.unregisterResource('slack://nonexistent/T1')).not.toThrow();
  });
});

describe('SlackMCPServer error mapping (CallToolRequestSchema handler)', () => {
  // Reach into the mocked Server to grab the CallToolRequestSchema handler
  // that setupHandlers() registered. This is the real exception boundary —
  // server.callTool() bypasses the wrapping logic.
  function getCallToolHandler(server: any): (req: any) => Promise<any> {
    const setRequestHandler = server.server.setRequestHandler as jest.Mock;
    const call = setRequestHandler.mock.calls.find((c: any[]) => c[0]?.method === 'tools/call');
    if (!call) throw new Error('CallToolRequestSchema handler not registered');
    return call[1] as (req: any) => Promise<any>;
  }

  let server: InstanceType<typeof SlackMCPServer>;

  beforeEach(() => {
    if (!slackClientManager.listWorkspaces().includes('T1')) {
      slackClientManager.addWorkspace('T1', TOKENS);
    }
    server = new SlackMCPServer({
      name: 'test-server',
      version: '0.0.0',
      capabilities: { resources: true, tools: true, prompts: false, logging: false },
    });
  });

  it('maps typed ValidationError to InvalidParams', async () => {
    const { ValidationError: TypedValidationError } = await import('../../src/errors/index.js');
    server.registerTool(
      {
        name: 't_v',
        description: 'x',
        inputSchema: { type: 'object', properties: {}, required: [] },
      },
      async () => {
        throw new TypedValidationError('bad input');
      },
    );
    const handler = getCallToolHandler(server);
    await expect(handler({ params: { name: 't_v', arguments: {} } })).rejects.toMatchObject({
      code: -32602,
      message: 'bad input',
    });
  });

  it('maps AuthError to InvalidRequest', async () => {
    const { AuthError } = await import('../../src/errors/index.js');
    server.registerTool(
      {
        name: 't_a',
        description: 'x',
        inputSchema: { type: 'object', properties: {}, required: [] },
      },
      async () => {
        throw new AuthError('forbidden');
      },
    );
    const handler = getCallToolHandler(server);
    await expect(handler({ params: { name: 't_a', arguments: {} } })).rejects.toMatchObject({
      code: -32600,
      message: 'forbidden',
    });
  });

  it('maps NotFoundError to InvalidParams', async () => {
    const { NotFoundError } = await import('../../src/errors/index.js');
    server.registerTool(
      {
        name: 't_n',
        description: 'x',
        inputSchema: { type: 'object', properties: {}, required: [] },
      },
      async () => {
        throw new NotFoundError('channel missing');
      },
    );
    const handler = getCallToolHandler(server);
    await expect(handler({ params: { name: 't_n', arguments: {} } })).rejects.toMatchObject({
      code: -32602,
      message: 'channel missing',
    });
  });

  it('maps RateLimitError to InternalError', async () => {
    const { RateLimitError } = await import('../../src/errors/index.js');
    server.registerTool(
      {
        name: 't_r',
        description: 'x',
        inputSchema: { type: 'object', properties: {}, required: [] },
      },
      async () => {
        throw new RateLimitError('slow down', 7);
      },
    );
    const handler = getCallToolHandler(server);
    await expect(handler({ params: { name: 't_r', arguments: {} } })).rejects.toMatchObject({
      code: -32603,
      message: 'slow down',
    });
  });

  it('maps SlackApiError to InternalError', async () => {
    const { SlackApiError } = await import('../../src/errors/index.js');
    server.registerTool(
      {
        name: 't_s',
        description: 'x',
        inputSchema: { type: 'object', properties: {}, required: [] },
      },
      async () => {
        throw new SlackApiError('slack: invalid_args');
      },
    );
    const handler = getCallToolHandler(server);
    await expect(handler({ params: { name: 't_s', arguments: {} } })).rejects.toMatchObject({
      code: -32603,
      message: 'slack: invalid_args',
    });
  });

  it('falls back to InternalError for plain Error', async () => {
    server.registerTool(
      {
        name: 't_e',
        description: 'x',
        inputSchema: { type: 'object', properties: {}, required: [] },
      },
      async () => {
        throw new Error('boom');
      },
    );
    const handler = getCallToolHandler(server);
    await expect(handler({ params: { name: 't_e', arguments: {} } })).rejects.toMatchObject({
      code: -32603,
    });
  });
});
