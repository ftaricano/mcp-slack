import { jest } from '@jest/globals';

import type { SlackTool } from '../../../src/types/mcp.js';
import type * as MockModule from '../../__mocks__/@slack/web-api.js';

let mockWebClient: typeof MockModule.mockWebClient;
let setupMessageCapabilities: typeof import('../../../src/capabilities/messages.js').setupMessageCapabilities;
let slackClientManager: typeof import('../../../src/utils/slack-client.js').slackClientManager;
let permissionManager: typeof import('../../../src/auth/permissions.js').permissionManager;
let registry: typeof import('../../../src/observability/metrics.js').registry;
let resetMetrics: typeof import('../../../src/observability/metrics.js').resetMetrics;
let slackCallsCounter: typeof import('../../../src/observability/metrics.js').slackCallsCounter;
let slackCallDuration: typeof import('../../../src/observability/metrics.js').slackCallDuration;
let AuthError: typeof import('../../../src/errors/index.js').AuthError;

beforeAll(async () => {
  const mockMod = await import('../../__mocks__/@slack/web-api.js');
  jest.unstable_mockModule('@slack/web-api', () => mockMod);
  mockWebClient = mockMod.mockWebClient;
  ({ setupMessageCapabilities } = await import('../../../src/capabilities/messages.js'));
  ({ slackClientManager } = await import('../../../src/utils/slack-client.js'));
  ({ permissionManager } = await import('../../../src/auth/permissions.js'));
  ({ registry, resetMetrics, slackCallsCounter, slackCallDuration } =
    await import('../../../src/observability/metrics.js'));
  ({ AuthError } = await import('../../../src/errors/index.js'));
});

interface CapturedTool {
  tool: SlackTool;
  handler: (args: any) => Promise<any>;
}

function makeFakeServer() {
  const tools = new Map<string, CapturedTool>();
  return {
    tools,
    registerTool: (tool: SlackTool, handler: (args: any) => Promise<any>) => {
      tools.set(tool.name, { tool, handler });
    },
  } as any;
}

const TOKENS = {
  access_token: 'xoxb',
  token_type: 'bot' as const,
  scope: 'chat:write',
  bot_user_id: 'U-bot',
  app_id: 'A1',
  team: { id: 'T1', name: 'Test' },
  authed_user: {
    id: 'U1',
    scope: 'identify',
    access_token: 'xoxp',
    token_type: 'user' as const,
  },
};

describe('observability metrics via _wrap', () => {
  let tools: Map<string, CapturedTool>;
  let permSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    resetMetrics();
    mockWebClient.apiCall.mockReset();
    if (!slackClientManager.listWorkspaces().includes('T1')) {
      slackClientManager.addWorkspace('T1', TOKENS);
    }
    permSpy = jest
      .spyOn(permissionManager, 'requirePermission')
      .mockResolvedValue(undefined as never);

    const server = makeFakeServer();
    setupMessageCapabilities(server);
    tools = server.tools;
  });

  afterEach(() => {
    permSpy.mockRestore();
  });

  it('registers prom-client metrics on the registry', () => {
    const names = registry.getMetricsAsArray().map((m) => m.name);
    expect(names).toContain('mcp_slack_calls_total');
    expect(names).toContain('mcp_slack_call_duration_seconds');
  });

  it('increments mcp_slack_calls_total{outcome="ok"} on success', async () => {
    mockWebClient.apiCall.mockResolvedValue({
      ok: true,
      ts: '1234567890.123456',
      channel: 'C1234567890',
    } as never);
    await tools.get('send_message')!.handler({
      workspace_id: 'T1',
      user_id: 'U1',
      channel: 'C1234567890',
      text: 'hi',
    });
    const { values } = await slackCallsCounter.get();
    const okEntry = values.find(
      (v) => v.labels.tool === 'send_message' && v.labels.outcome === 'ok',
    );
    expect(okEntry?.value).toBe(1);
  });

  it('increments outcome="rate_limit" on persistent ratelimited', async () => {
    mockWebClient.apiCall.mockRejectedValue({
      data: { error: 'ratelimited' },
      headers: { 'retry-after': '0' },
    } as never);
    await expect(
      tools.get('send_message')!.handler({
        workspace_id: 'T1',
        user_id: 'U1',
        channel: 'C1234567890',
        text: 'hi',
      }),
    ).rejects.toMatchObject({ code: 'RATE_LIMIT' });
    const { values } = await slackCallsCounter.get();
    const rl = values.find(
      (v) => v.labels.tool === 'send_message' && v.labels.outcome === 'rate_limit',
    );
    expect(rl?.value).toBeGreaterThan(0);
  }, 10000);

  it('records duration histogram observations', async () => {
    mockWebClient.apiCall.mockResolvedValue({
      ok: true,
      ts: '1234567890.123456',
      channel: 'C1234567890',
    } as never);
    await tools.get('send_message')!.handler({
      workspace_id: 'T1',
      user_id: 'U1',
      channel: 'C1234567890',
      text: 'hi',
    });
    const data = await slackCallDuration.get();
    const obs = data.values.find((v) => (v.labels as any).tool === 'send_message');
    expect(obs).toBeDefined();
  });

  it('increments outcome="auth" on permission denial', async () => {
    permSpy.mockRejectedValue(new AuthError('perm denied'));
    await expect(
      tools.get('send_message')!.handler({
        workspace_id: 'T1',
        user_id: 'U1',
        channel: 'C1234567890',
        text: 'hi',
      }),
    ).rejects.toBeInstanceOf(AuthError);
    const { values } = await slackCallsCounter.get();
    const auth = values.find(
      (v) => v.labels.tool === 'send_message' && v.labels.outcome === 'auth',
    );
    expect(auth?.value).toBeGreaterThan(0);
  });
});
