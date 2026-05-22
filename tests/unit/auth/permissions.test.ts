import { jest } from '@jest/globals';

import type * as MockModule from '../../__mocks__/@slack/web-api.js';

// ESM Jest does NOT hoist jest.mock above static imports. Use
// jest.unstable_mockModule + dynamic imports so the modules under test
// resolve @slack/web-api to our manual mock fixture.
let mockWebClient: typeof MockModule.mockWebClient;
let PermissionManager: typeof import('../../../src/auth/permissions.js').PermissionManager;
let permissionManager: typeof import('../../../src/auth/permissions.js').permissionManager;
let requirePermissionMiddleware: typeof import('../../../src/auth/permissions.js').requirePermissionMiddleware;
let slackClientManager: typeof import('../../../src/utils/slack-client.js').slackClientManager;

beforeAll(async () => {
  const mockMod = await import('../../__mocks__/@slack/web-api.js');
  jest.unstable_mockModule('@slack/web-api', () => mockMod);
  mockWebClient = mockMod.mockWebClient;
  ({ PermissionManager, permissionManager, requirePermissionMiddleware } =
    await import('../../../src/auth/permissions.js'));
  ({ slackClientManager } = await import('../../../src/utils/slack-client.js'));

  if (!slackClientManager.listWorkspaces().includes('T1')) {
    slackClientManager.addWorkspace('T1', {
      access_token: 'bot-token-test',
      token_type: 'bot',
      scope: 'chat:write,channels:read,users:read,files:read,reactions:write',
      bot_user_id: 'U-bot',
      app_id: 'A1',
      team: { id: 'T1', name: 'Test Workspace' },
      authed_user: {
        id: 'U1',
        scope: 'identify',
        access_token: 'user-token-user',
        token_type: 'user',
      },
    });
  }
  if (!slackClientManager.listWorkspaces().includes('T-READONLY')) {
    // Read-only token: regression fixture for Bug V (scope hierarchy
    // direction). With the inverted mapping, `create_channel` would have
    // passed despite the token only carrying `channels:read`.
    slackClientManager.addWorkspace('T-READONLY', {
      access_token: 'bot-token-readonly',
      token_type: 'bot',
      scope: 'channels:read,files:read,reactions:read,users:read',
      bot_user_id: 'U-bot',
      app_id: 'A1',
      team: { id: 'T-READONLY', name: 'Readonly Workspace' },
      authed_user: {
        id: 'U1',
        scope: 'identify',
        access_token: 'user-token-user',
        token_type: 'user',
      },
    });
  }
  if (!slackClientManager.listWorkspaces().includes('T-WRITEONLY')) {
    // Write-only token: write should imply read (e.g. channels:write
    // satisfies a channels:read requirement).
    slackClientManager.addWorkspace('T-WRITEONLY', {
      access_token: 'bot-token-writeonly',
      token_type: 'bot',
      scope: 'channels:write,files:write,reactions:write,users:write',
      bot_user_id: 'U-bot',
      app_id: 'A1',
      team: { id: 'T-WRITEONLY', name: 'Writeonly Workspace' },
      authed_user: {
        id: 'U1',
        scope: 'identify',
        access_token: 'user-token-user',
        token_type: 'user',
      },
    });
  }
  if (!slackClientManager.listWorkspaces().includes('T-ADMIN')) {
    slackClientManager.addWorkspace('T-ADMIN', {
      access_token: 'bot-token-admin',
      token_type: 'bot',
      scope: 'admin',
      bot_user_id: 'U-bot',
      app_id: 'A1',
      team: { id: 'T-ADMIN', name: 'Admin Workspace' },
      authed_user: {
        id: 'U1',
        scope: 'identify',
        access_token: 'user-token-user',
        token_type: 'user',
      },
    });
  }
});

function userInfoResponse(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    ok: true,
    user: {
      id: 'U1',
      is_admin: false,
      is_owner: false,
      is_primary_owner: false,
      is_restricted: false,
      is_ultra_restricted: false,
      ...overrides,
    },
  };
}

describe('PermissionManager', () => {
  let mgr: InstanceType<typeof PermissionManager>;

  beforeEach(() => {
    jest.useFakeTimers();
    mockWebClient.apiCall.mockReset();
    mgr = new PermissionManager();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  describe('checkPermission', () => {
    it('grants when user has the required scope', async () => {
      mockWebClient.apiCall.mockResolvedValue(userInfoResponse() as never);
      const check = await mgr.checkPermission('T1', 'U1', 'send_message');
      expect(check.granted).toBe(true);
      expect(check.missing).toBeUndefined();
    });

    it('denies for unknown operation', async () => {
      mockWebClient.apiCall.mockResolvedValue(userInfoResponse() as never);
      const check = await mgr.checkPermission('T1', 'U1', 'nonexistent_op');
      expect(check.granted).toBe(false);
      expect(check.reason).toMatch(/Unknown operation/);
    });

    it('reports missing scopes when token lacks them', async () => {
      mockWebClient.apiCall.mockResolvedValue(userInfoResponse() as never);
      const check = await mgr.checkPermission('T1', 'U1', 'search_messages');
      expect(check.granted).toBe(false);
      expect(check.missing).toEqual(expect.arrayContaining(['search:read']));
    });

    it('grants admin operations when user is admin and workspace has admin scope', async () => {
      mockWebClient.apiCall.mockResolvedValue(userInfoResponse({ is_admin: true }) as never);
      const check = await mgr.checkPermission('T-ADMIN', 'U1', 'manage_users');
      expect(check.granted).toBe(true);
    });

    it('denies admin operation when user is not admin', async () => {
      mockWebClient.apiCall.mockResolvedValue(userInfoResponse({ is_admin: false }) as never);
      const check = await mgr.checkPermission('T1', 'U1', 'manage_users');
      expect(check.granted).toBe(false);
      expect(check.missing).toEqual(expect.arrayContaining(['admin privileges']));
    });

    it('returns not-granted when slack returns ok=false', async () => {
      mockWebClient.apiCall.mockResolvedValue({ ok: false } as never);
      const check = await mgr.checkPermission('T1', 'U1', 'send_message');
      expect(check.granted).toBe(false);
      expect(check.reason).toMatch(/Permission check failed/);
    });

    it('returns not-granted when slack call throws', async () => {
      mockWebClient.apiCall.mockRejectedValue(new Error('network down') as never);
      const check = await mgr.checkPermission('T1', 'U1', 'send_message');
      expect(check.granted).toBe(false);
      expect(check.reason).toMatch(/network down/);
    });

    it('returns not-granted for unknown workspace', async () => {
      const check = await mgr.checkPermission('T-UNKNOWN', 'U1', 'send_message');
      expect(check.granted).toBe(false);
      expect(check.reason).toMatch(/Permission check failed/);
      expect(mockWebClient.apiCall).not.toHaveBeenCalled();
    });

    it('uses cached permissions on second call within TTL', async () => {
      mockWebClient.apiCall.mockResolvedValue(userInfoResponse() as never);
      await mgr.checkPermission('T1', 'U1', 'send_message');
      await mgr.checkPermission('T1', 'U1', 'list_channels');
      expect(mockWebClient.apiCall).toHaveBeenCalledTimes(1);
    });

    it('refetches permissions after TTL expiry', async () => {
      mockWebClient.apiCall.mockResolvedValue(userInfoResponse() as never);
      await mgr.checkPermission('T1', 'U1', 'send_message');
      jest.advanceTimersByTime(6 * 60 * 1000); // > 5 minute TTL
      await mgr.checkPermission('T1', 'U1', 'send_message');
      expect(mockWebClient.apiCall).toHaveBeenCalledTimes(2);
    });

    it('does NOT grant channels:write to a token with only channels:read (Bug V)', async () => {
      mockWebClient.apiCall.mockResolvedValue(userInfoResponse() as never);
      const check = await mgr.checkPermission('T-READONLY', 'U1', 'create_channel');
      expect(check.granted).toBe(false);
      expect(check.missing).toEqual(expect.arrayContaining(['channels:write']));
    });

    it('does NOT grant files:write to a token with only files:read (Bug V)', async () => {
      mockWebClient.apiCall.mockResolvedValue(userInfoResponse() as never);
      const check = await mgr.checkPermission('T-READONLY', 'U1', 'upload_file');
      expect(check.granted).toBe(false);
      expect(check.missing).toEqual(expect.arrayContaining(['files:write']));
    });

    it('does NOT grant reactions:write to a token with only reactions:read (Bug V)', async () => {
      mockWebClient.apiCall.mockResolvedValue(userInfoResponse() as never);
      const check = await mgr.checkPermission('T-READONLY', 'U1', 'remove_reaction');
      expect(check.granted).toBe(false);
      expect(check.missing).toEqual(expect.arrayContaining(['reactions:write']));
    });

    it('grants channels:read when token only carries channels:write (write implies read)', async () => {
      mockWebClient.apiCall.mockResolvedValue(userInfoResponse() as never);
      const check = await mgr.checkPermission('T-WRITEONLY', 'U1', 'list_channels');
      expect(check.granted).toBe(true);
    });

    it('grants users:read when token only carries users:write (write implies read)', async () => {
      mockWebClient.apiCall.mockResolvedValue(userInfoResponse() as never);
      const check = await mgr.checkPermission('T-WRITEONLY', 'U1', 'list_users');
      expect(check.granted).toBe(true);
    });

    it('treats admin user as having every scope (hasScope shortcut)', async () => {
      mockWebClient.apiCall.mockResolvedValue(userInfoResponse({ is_admin: true }) as never);
      // create_channel needs channels:write, which T1 token does NOT have, but admin shortcut grants it.
      const check = await mgr.checkPermission('T1', 'U1', 'create_channel');
      expect(check.granted).toBe(true);
    });
  });

  describe('requirePermission', () => {
    it('resolves when permission is granted', async () => {
      mockWebClient.apiCall.mockResolvedValue(userInfoResponse() as never);
      await expect(mgr.requirePermission('T1', 'U1', 'send_message')).resolves.toBeUndefined();
    });

    it('throws when permission is denied with missing scopes message', async () => {
      mockWebClient.apiCall.mockResolvedValue(userInfoResponse() as never);
      await expect(mgr.requirePermission('T1', 'U1', 'search_messages')).rejects.toThrow(
        /Permission denied.*missing.*search:read/,
      );
    });

    it('throws with reason when denial includes a reason', async () => {
      mockWebClient.apiCall.mockResolvedValue(userInfoResponse() as never);
      await expect(mgr.requirePermission('T1', 'U1', 'nonexistent_op')).rejects.toThrow(
        /Unknown operation/,
      );
    });
  });

  describe('checkMultiplePermissions', () => {
    it('returns a map of operation -> PermissionCheck', async () => {
      mockWebClient.apiCall.mockResolvedValue(userInfoResponse() as never);
      const results = await mgr.checkMultiplePermissions('T1', 'U1', [
        'send_message',
        'search_messages',
      ]);
      expect(results.send_message?.granted).toBe(true);
      expect(results.search_messages?.granted).toBe(false);
    });
  });

  describe('getAvailableOperations', () => {
    it('returns only operations the user can perform', async () => {
      mockWebClient.apiCall.mockResolvedValue(userInfoResponse() as never);
      const ops = await mgr.getAvailableOperations('T1', 'U1');
      expect(ops).toEqual(expect.arrayContaining(['send_message', 'list_channels']));
      expect(ops).not.toContain('search_messages');
      expect(ops).not.toContain('manage_users');
    });
  });

  describe('invalidateUserCache', () => {
    it('forces a refetch for a specific user', async () => {
      mockWebClient.apiCall.mockResolvedValue(userInfoResponse() as never);
      await mgr.checkPermission('T1', 'U1', 'send_message');
      mgr.invalidateUserCache('T1', 'U1');
      await mgr.checkPermission('T1', 'U1', 'send_message');
      expect(mockWebClient.apiCall).toHaveBeenCalledTimes(2);
    });

    it('forces a refetch for all users in a workspace when no userId given', async () => {
      mockWebClient.apiCall.mockResolvedValue(userInfoResponse() as never);
      await mgr.checkPermission('T1', 'U1', 'send_message');
      await mgr.checkPermission('T1', 'U2', 'send_message');
      mgr.invalidateUserCache('T1');
      await mgr.checkPermission('T1', 'U1', 'send_message');
      expect(mockWebClient.apiCall).toHaveBeenCalledTimes(3);
    });
  });

  describe('operation registry', () => {
    it('addOperationPermission and getOperationRequirements round-trip', () => {
      mgr.addOperationPermission('custom_op', [
        { scope: 'custom:scope', resource: 'r', action: 'a', required: true },
      ]);
      const reqs = mgr.getOperationRequirements('custom_op');
      expect(reqs).toHaveLength(1);
      expect(reqs?.[0]?.scope).toBe('custom:scope');
      expect(mgr.getRegisteredOperations()).toContain('custom_op');
    });

    it('removeOperationPermission deletes a registered op', () => {
      mgr.addOperationPermission('temp_op', []);
      mgr.removeOperationPermission('temp_op');
      expect(mgr.getOperationRequirements('temp_op')).toBeUndefined();
    });

    it('getOperationRequirements returns undefined for unknown ops', () => {
      expect(mgr.getOperationRequirements('does_not_exist')).toBeUndefined();
    });
  });

  describe('validateWorkspaceAccess', () => {
    it('returns false for an unknown workspace', async () => {
      const ok = await mgr.validateWorkspaceAccess('T-NOPE');
      expect(ok).toBe(false);
    });

    it('returns true when testConnection succeeds', async () => {
      mockWebClient.apiCall.mockResolvedValue({ ok: true } as never);
      const ok = await mgr.validateWorkspaceAccess('T1');
      expect(ok).toBe(true);
    });

    it('returns false when testConnection throws', async () => {
      mockWebClient.apiCall.mockRejectedValue(new Error('boom') as never);
      const ok = await mgr.validateWorkspaceAccess('T1');
      expect(ok).toBe(false);
    });
  });

  describe('getPermissionSummary', () => {
    it('returns regular permission level for a non-admin user', async () => {
      mockWebClient.apiCall.mockResolvedValue(userInfoResponse() as never);
      const summary = await mgr.getPermissionSummary('T1', 'U1');
      expect(summary.permissionLevel).toBe('regular');
      expect(summary.totalOperations).toBeGreaterThan(0);
      expect(Array.isArray(summary.availableOperations)).toBe(true);
    });

    it('returns admin level when user.is_admin', async () => {
      mockWebClient.apiCall.mockResolvedValue(userInfoResponse({ is_admin: true }) as never);
      const summary = await mgr.getPermissionSummary('T1', 'U1');
      expect(summary.permissionLevel).toBe('admin');
    });

    it('returns ultra_restricted when flagged', async () => {
      mockWebClient.apiCall.mockResolvedValue(
        userInfoResponse({ is_ultra_restricted: true }) as never,
      );
      const summary = await mgr.getPermissionSummary('T1', 'U1');
      expect(summary.permissionLevel).toBe('ultra_restricted');
    });

    it('returns restricted when flagged', async () => {
      mockWebClient.apiCall.mockResolvedValue(userInfoResponse({ is_restricted: true }) as never);
      const summary = await mgr.getPermissionSummary('T1', 'U1');
      expect(summary.permissionLevel).toBe('restricted');
    });
  });

  describe('singleton + middleware helper', () => {
    it('exports a default instance', () => {
      expect(permissionManager).toBeInstanceOf(PermissionManager);
    });

    it('requirePermissionMiddleware delegates to the singleton', async () => {
      const spy = jest
        .spyOn(permissionManager, 'requirePermission')
        .mockResolvedValue(undefined as never);
      const middleware = requirePermissionMiddleware('send_message');
      await middleware('T1', 'U1');
      expect(spy).toHaveBeenCalledWith('T1', 'U1', 'send_message');
      spy.mockRestore();
    });
  });

  describe('cleanupCache', () => {
    it('runs without error when the cleanup interval fires', async () => {
      mockWebClient.apiCall.mockResolvedValue(userInfoResponse() as never);
      await mgr.checkPermission('T1', 'U1', 'send_message');
      // Advance past TTL so the cached entry becomes "expired", then trigger interval.
      jest.advanceTimersByTime(11 * 60 * 1000);
      // Subsequent fetch should refetch (entry was either cleaned or expired).
      await mgr.checkPermission('T1', 'U1', 'send_message');
      expect(mockWebClient.apiCall).toHaveBeenCalledTimes(2);
    });
  });
});
