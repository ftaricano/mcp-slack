import { jest } from '@jest/globals';

// Mock @slack/oauth so we control InstallProvider behavior.
const mockInstallProvider = {
  generateInstallUrl: jest.fn<(...args: unknown[]) => Promise<string>>(),
  handleCallback: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
};
const InstallProviderCtor = jest.fn().mockImplementation((opts: any) => {
  (mockInstallProvider as any)._opts = opts;
  return mockInstallProvider;
});

jest.unstable_mockModule('@slack/oauth', () => ({
  InstallProvider: InstallProviderCtor,
  LogLevel: { ERROR: 'error', WARN: 'warn', INFO: 'info', DEBUG: 'debug' },
}));

// Inline mock @slack/web-api so this test is self-contained and does not
// depend on any sibling task's manual __mocks__ file.
const mockApiCall = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.unstable_mockModule('@slack/web-api', () => ({
  WebClient: jest.fn().mockImplementation(() => ({
    apiCall: mockApiCall,
    auth: { test: jest.fn() },
  })),
  LogLevel: { ERROR: 'error', WARN: 'warn', INFO: 'info', DEBUG: 'debug' },
}));

const { SlackOAuthManager, createOAuthManager } = await import('../../../src/auth/oauth.js');
const { slackClientManager } = await import('../../../src/utils/slack-client.js');

const baseConfig = {
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  scopes: ['chat:write', 'channels:read'],
  redirectUri: 'https://example.com/oauth/callback',
};

describe('SlackOAuthManager', () => {
  let mgr: InstanceType<typeof SlackOAuthManager>;

  beforeEach(() => {
    jest.useFakeTimers();
    InstallProviderCtor.mockClear();
    mockInstallProvider.generateInstallUrl.mockReset();
    mockInstallProvider.handleCallback.mockReset();
    mockApiCall.mockReset();
    mgr = new SlackOAuthManager({ ...baseConfig });
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  describe('constructor', () => {
    it('builds an InstallProvider with config + state secret from env', () => {
      expect(InstallProviderCtor).toHaveBeenCalledTimes(1);
      const opts = InstallProviderCtor.mock.calls[0]![0] as any;
      expect(opts.clientId).toBe('test-client-id');
      expect(opts.clientSecret).toBe('test-client-secret');
      expect(typeof opts.stateSecret).toBe('string');
      expect(opts.stateSecret.length).toBeGreaterThan(0);
      expect(opts.installationStore).toBeDefined();
      expect(typeof opts.installationStore.storeInstallation).toBe('function');
      expect(typeof opts.installationStore.fetchInstallation).toBe('function');
      expect(typeof opts.installationStore.deleteInstallation).toBe('function');
    });
  });

  describe('generateInstallUrl', () => {
    it('generates install URL containing the stored state, client_id, scope, redirect_uri', async () => {
      const url = await mgr.generateInstallUrl();
      const parsed = new URL(url);
      expect(parsed.origin + parsed.pathname).toBe('https://slack.com/oauth/v2/authorize');
      expect(parsed.searchParams.get('client_id')).toBe(baseConfig.clientId);
      expect(parsed.searchParams.get('redirect_uri')).toBe(baseConfig.redirectUri);
      expect(parsed.searchParams.get('scope')).toBe(baseConfig.scopes.join(','));

      const stored = (mgr as any).stateStore as Map<string, any>;
      const states = [...stored.keys()];
      expect(states).toHaveLength(1);
      expect(parsed.searchParams.get('state')).toBe(states[0]);
    });

    it('includes user_scope when userScopes is non-empty', async () => {
      const url = await mgr.generateInstallUrl({
        userScopes: ['identity.basic', 'channels:read'],
      });
      const parsed = new URL(url);
      expect(parsed.searchParams.get('user_scope')).toBe('identity.basic,channels:read');
    });

    it('omits user_scope when userScopes is empty', async () => {
      const url = await mgr.generateInstallUrl();
      const parsed = new URL(url);
      expect(parsed.searchParams.has('user_scope')).toBe(false);
    });

    it('overrides scopes/redirectUri/userScopes from options', async () => {
      const url = await mgr.generateInstallUrl({
        scopes: ['files:write'],
        userScopes: ['identity.basic'],
        redirectUri: 'https://other.example/cb',
      });
      const parsed = new URL(url);
      expect(parsed.searchParams.get('scope')).toBe('files:write');
      expect(parsed.searchParams.get('user_scope')).toBe('identity.basic');
      expect(parsed.searchParams.get('redirect_uri')).toBe('https://other.example/cb');
    });

    it('seeds the internal state store with a fresh state per call', async () => {
      const store = (mgr as any).stateStore as Map<string, any>;
      expect(store.size).toBe(0);
      await mgr.generateInstallUrl();
      expect(store.size).toBe(1);
      await mgr.generateInstallUrl();
      expect(store.size).toBe(2);
    });

    it('persists state via tokenStore.setRaw with TTL so multi-replica callbacks resolve', async () => {
      const setRaw = jest.fn(async () => undefined);
      const mgrWithRaw = new SlackOAuthManager({
        ...baseConfig,
        tokenStore: {
          get: jest.fn(async () => null),
          set: jest.fn(async () => undefined),
          delete: jest.fn(async () => undefined),
          list: jest.fn(async () => []),
          setRaw: setRaw as any,
          getRaw: jest.fn(async () => null),
          delRaw: jest.fn(async () => undefined),
        } as never,
      });
      await mgrWithRaw.generateInstallUrl();
      expect(setRaw).toHaveBeenCalledWith(
        expect.stringMatching(/^oauth-state:[0-9a-f]+$/),
        expect.stringContaining('"state"'),
        expect.any(Number),
      );
    });
  });

  describe('handleCallback', () => {
    it('rejects when state is unknown', async () => {
      await expect(mgr.handleCallback('code-x', 'unknown-state')).rejects.toThrow(
        /Invalid or expired/i,
      );
    });

    it('resolves state from tokenStore when in-memory cache is cold (cross-replica)', async () => {
      const state = 'cross'.padEnd(64, 'p');
      const persistedState = JSON.stringify({
        state,
        codeVerifier: 'v'.repeat(64),
        redirectUri: baseConfig.redirectUri,
        scopes: baseConfig.scopes,
        userScopes: [],
        timestamp: Date.now(),
      });
      const delRaw = jest.fn(async () => undefined);
      const mgrCross = new SlackOAuthManager({
        ...baseConfig,
        tokenStore: {
          get: jest.fn(async () => null),
          set: jest.fn(async () => undefined),
          delete: jest.fn(async () => undefined),
          list: jest.fn(async () => []),
          setRaw: jest.fn(async () => undefined),
          getRaw: jest.fn(async (k: string) =>
            k === `oauth-state:${state}` ? persistedState : null,
          ),
          delRaw: delRaw as any,
        } as never,
      });
      // The in-memory store of mgrCross is empty — state must come from tokenStore.
      mockApiCall.mockResolvedValue({
        ok: true,
        access_token: 'bot-token-cross',
        scope: 'chat:write',
        bot_user_id: 'U-bot',
        app_id: 'A1',
        team: { id: 'T-cross', name: 'X' },
        authed_user: { id: 'U1', scope: 'identify', access_token: 'xoxp' },
      });
      const addSpy = jest
        .spyOn(slackClientManager, 'addWorkspace')
        .mockImplementation(() => undefined);
      const tokens = await mgrCross.handleCallback('code-x', state);
      expect(tokens.team.id).toBe('T-cross');
      expect(addSpy).toHaveBeenCalled();
      expect(delRaw).toHaveBeenCalledWith(`oauth-state:${state}`);
      addSpy.mockRestore();
    });

    it('rejects when stored state has expired (TTL exceeded)', async () => {
      const state = 'expired'.padEnd(64, 'e');
      const store = (mgr as any).stateStore as Map<string, any>;
      store.set(state, {
        state,
        codeVerifier: 'v'.repeat(64),
        redirectUri: baseConfig.redirectUri,
        scopes: baseConfig.scopes,
        userScopes: [],
        timestamp: Date.now() - 11 * 60 * 1000, // 11 minutes ago
      });

      await expect(mgr.handleCallback('code-x', state)).rejects.toThrow(/expired/i);
      expect(store.has(state)).toBe(false); // implementation drops expired state
    });

    it('returns SlackTokens and registers the workspace on success', async () => {
      const state = 'a'.repeat(64);
      const internalStore = (mgr as any).stateStore as Map<string, any>;
      internalStore.set(state, {
        state,
        codeVerifier: 'v'.repeat(64),
        redirectUri: baseConfig.redirectUri,
        scopes: baseConfig.scopes,
        userScopes: [],
        timestamp: Date.now(),
      });

      mockApiCall.mockResolvedValue({
        ok: true,
        access_token: 'bot-token-1',
        scope: 'chat:write',
        bot_user_id: 'U-bot',
        app_id: 'A1',
        team: { id: 'T1', name: 'Test' },
        authed_user: { id: 'U1', scope: 'identify', access_token: 'user-token-1' },
      });

      const addSpy = jest
        .spyOn(slackClientManager, 'addWorkspace')
        .mockImplementation(() => undefined);

      const tokens = await mgr.handleCallback('code-x', state);
      expect(tokens.team.id).toBe('T1');
      expect(tokens.team.name).toBe('Test');
      expect(tokens.access_token).toBe('bot-token-1');
      expect(tokens.token_type).toBe('bot');
      expect(tokens.scope).toBe('chat:write');
      expect(tokens.bot_user_id).toBe('U-bot');
      expect(tokens.app_id).toBe('A1');
      expect(tokens.authed_user.id).toBe('U1');
      expect(tokens.authed_user.access_token).toBe('user-token-1');
      expect(tokens.authed_user.token_type).toBe('user');
      // Sanity: we drove oauth.v2.access via WebClient.apiCall, NOT installProvider.handleCallback.
      expect(mockApiCall).toHaveBeenCalledWith(
        'oauth.v2.access',
        expect.objectContaining({ code: 'code-x', client_id: 'test-client-id' }),
      );
      expect(mockInstallProvider.handleCallback).not.toHaveBeenCalled();
      expect(addSpy).toHaveBeenCalledWith(
        'T1',
        expect.objectContaining({ access_token: 'bot-token-1' }),
      );
      expect(internalStore.has(state)).toBe(false); // cleaned up
      addSpy.mockRestore();
    });

    it('includes enterprise info when present in installation', async () => {
      const state = 'c'.repeat(64);
      const internalStore = (mgr as any).stateStore as Map<string, any>;
      internalStore.set(state, {
        state,
        codeVerifier: 'v'.repeat(64),
        redirectUri: baseConfig.redirectUri,
        scopes: baseConfig.scopes,
        userScopes: [],
        timestamp: Date.now(),
      });

      mockApiCall.mockResolvedValue({
        ok: true,
        access_token: 'bot-token-2',
        scope: '',
        bot_user_id: 'U-bot',
        app_id: 'A2',
        team: { id: 'T2', name: 'Team2' },
        enterprise: { id: 'E2', name: 'Ent2' },
        authed_user: { id: 'U2', scope: '', access_token: '' },
      });

      const addSpy = jest
        .spyOn(slackClientManager, 'addWorkspace')
        .mockImplementation(() => undefined);

      const tokens = await mgr.handleCallback('code-x', state);
      expect(tokens.enterprise).toEqual({ id: 'E2', name: 'Ent2' });
      addSpy.mockRestore();
    });

    it('registers org-wide installs under enterprise.id when team.id is absent', async () => {
      // Bug HH: org-wide Enterprise Grid installs only deliver `enterprise.id`
      // (no team.id). Before the fix, handleCallback built tokens.team.id as
      // '' and called addWorkspace('') — collapsing every org-wide install
      // onto a single bogus key. The fix uses enterprise.id as a fallback,
      // mirroring the persistence-key logic in toInstalledToken (Bug FF).
      const state = 'e'.repeat(64);
      ((mgr as any).stateStore as Map<string, any>).set(state, {
        state,
        codeVerifier: 'v'.repeat(64),
        redirectUri: baseConfig.redirectUri,
        scopes: baseConfig.scopes,
        userScopes: [],
        timestamp: Date.now(),
      });

      mockApiCall.mockResolvedValue({
        ok: true,
        access_token: 'bot-token-org',
        scope: 'chat:write',
        bot_user_id: 'U-bot',
        app_id: 'A1',
        enterprise: { id: 'E-org', name: 'BigCo' },
        // NO team field — org-wide install
        authed_user: { id: 'U1', scope: 'identify', access_token: 'xoxp' },
      });

      const addSpy = jest
        .spyOn(slackClientManager, 'addWorkspace')
        .mockImplementation(() => undefined);

      const tokens = await mgr.handleCallback('code-x', state);
      expect(tokens.team.id).toBe('E-org');
      expect(tokens.team.name).toBe('BigCo');
      expect(addSpy).toHaveBeenCalledWith('E-org', expect.any(Object));
      addSpy.mockRestore();
    });

    it('throws when both team.id and enterprise.id are missing in handleCallback', async () => {
      // Defense-in-depth: a malformed oauth.v2.access response with neither
      // team nor enterprise must be rejected loudly, not silently registered
      // under an empty string.
      const state = 'f'.repeat(64);
      ((mgr as any).stateStore as Map<string, any>).set(state, {
        state,
        codeVerifier: 'v'.repeat(64),
        redirectUri: baseConfig.redirectUri,
        scopes: baseConfig.scopes,
        userScopes: [],
        timestamp: Date.now(),
      });
      mockApiCall.mockResolvedValue({
        ok: true,
        access_token: 'bot-token-bad',
        scope: '',
        bot_user_id: 'U-bot',
        app_id: 'A1',
        // no team, no enterprise
        authed_user: { id: 'U1', scope: '', access_token: '' },
      });
      // The throw can come from either toInstalledToken (during storeInstallation)
      // or from the new defensive check in handleCallback — both surface the
      // same intent ("no team.id and no enterprise.id"). Accept either wording.
      await expect(mgr.handleCallback('code-x', state)).rejects.toThrow(
        /no team\.id or enterprise\.id|missing both team\.id and enterprise\.id/i,
      );
    });

    it('rejects when the installation lacks a bot section', async () => {
      const state = 'b'.repeat(64);
      ((mgr as any).stateStore as Map<string, any>).set(state, {
        state,
        codeVerifier: 'v'.repeat(64),
        redirectUri: baseConfig.redirectUri,
        scopes: baseConfig.scopes,
        userScopes: [],
        timestamp: Date.now(),
      });
      // oauth.v2.access returns ok=true but with no access_token (no bot)
      mockApiCall.mockResolvedValue({
        ok: true,
        access_token: '',
        team: { id: 'T1', name: 'X' },
      });
      await expect(mgr.handleCallback('code-x', state)).rejects.toThrow(
        /OAuth exchange failed|[Bb]ot/,
      );
      // State should be cleaned up on error path
      expect(((mgr as any).stateStore as Map<string, any>).has(state)).toBe(false);
    });

    it('cleans up state when oauth.v2.access throws', async () => {
      const state = 'd'.repeat(64);
      const store = (mgr as any).stateStore as Map<string, any>;
      store.set(state, {
        state,
        codeVerifier: 'v'.repeat(64),
        redirectUri: baseConfig.redirectUri,
        scopes: baseConfig.scopes,
        userScopes: [],
        timestamp: Date.now(),
      });
      mockApiCall.mockRejectedValue(new Error('boom'));
      await expect(mgr.handleCallback('code-x', state)).rejects.toThrow(/boom/);
      expect(store.has(state)).toBe(false);
    });

    it('surfaces tokenStore.set failures and rolls back the in-memory cache', async () => {
      // Custom manager with a store whose `set` rejects — simulates Redis
      // dying mid-install. Without the rollback fix, the in-memory cache
      // keeps the install but persistence is gone, so a restart silently
      // loses the workspace while the user saw a "success" response.
      const setSpy = jest.fn(async () => {
        throw new Error('storage down');
      });
      const customMgr = new SlackOAuthManager({
        ...baseConfig,
        tokenStore: {
          get: jest.fn(async () => null) as any,
          set: setSpy as any,
          delete: jest.fn(async () => undefined) as any,
          list: jest.fn(async () => []) as any,
        } as never,
      });

      const state = 'a'.repeat(64);
      ((customMgr as any).stateStore as Map<string, any>).set(state, {
        state,
        codeVerifier: 'v'.repeat(64),
        redirectUri: baseConfig.redirectUri,
        scopes: baseConfig.scopes,
        userScopes: [],
        timestamp: Date.now(),
      });

      mockApiCall.mockResolvedValue({
        ok: true,
        access_token: 'xoxb',
        scope: 'chat:write',
        bot_user_id: 'U-bot',
        app_id: 'A1',
        team: { id: 'T-fail', name: 'X' },
        authed_user: { id: 'U1', scope: 'identify', access_token: 'xoxp' },
      });

      await expect(customMgr.handleCallback('code-x', state)).rejects.toThrow(/storage down/i);

      // In-memory cache must be empty (rollback) and state must be cleaned up.
      expect((customMgr as any).installations.has('T-fail')).toBe(false);
      expect(((customMgr as any).stateStore as Map<string, any>).has(state)).toBe(false);
      expect(setSpy).toHaveBeenCalled();
    });
  });

  describe('installation store hooks', () => {
    it('storeInstallation populates listInstallations', async () => {
      const opts = InstallProviderCtor.mock.calls[0]![0] as any;
      await opts.installationStore.storeInstallation({
        team: { id: 'T-store' },
        bot: { token: 'xoxb' },
      });
      const list = await mgr.listInstallations();
      expect(list.find((i) => i.teamId === 'T-store')).toBeTruthy();
    });

    it('storeInstallation prefers enterprise.id over team.id as the key', async () => {
      const opts = InstallProviderCtor.mock.calls[0]![0] as any;
      await opts.installationStore.storeInstallation({
        team: { id: 'T-x' },
        enterprise: { id: 'E-x' },
      });
      const list = await mgr.listInstallations();
      expect(list.find((i) => i.teamId === 'E-x')).toBeTruthy();
      expect(list.find((i) => i.teamId === 'T-x')).toBeFalsy();
    });

    it('fetchInstallation rehydrates from tokenStore when in-memory cache is cold', async () => {
      // Inject a tokenStore that has a workspace persisted but the manager's
      // in-memory `installations` Map is empty (simulates a fresh process).
      const persisted = {
        teamId: 'T-rehy',
        userId: 'U1',
        botToken: 'bot-token-persisted',
        scopes: ['chat:write'],
        installedAt: 1700000000000,
        appId: 'A1',
        metadata: { teamName: 'Persisted', isEnterprise: false },
      };
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const customMgr = new SlackOAuthManager({
        ...baseConfig,
        tokenStore: {
          get: jest.fn(async (k: string) => (k === 'T-rehy' ? persisted : null)),
          set: jest.fn(async () => undefined),
          delete: jest.fn(async () => undefined),
          list: jest.fn(async () => [persisted]),
        } as never,
      });
      const opts = InstallProviderCtor.mock.calls.at(-1)![0] as any;
      const result = await opts.installationStore.fetchInstallation({ teamId: 'T-rehy' });
      expect(result.team.id).toBe('T-rehy');
      expect(result.bot.token).toBe('bot-token-persisted');
    });

    it('listInstallations merges in-memory cache with tokenStore', async () => {
      const persisted = {
        teamId: 'T-disk',
        userId: 'U1',
        botToken: 'bot-token-disk',
        scopes: ['chat:write'],
        installedAt: 1700000000000,
      };
      const customMgr = new SlackOAuthManager({
        ...baseConfig,
        tokenStore: {
          get: jest.fn(async () => null),
          set: jest.fn(async () => undefined),
          delete: jest.fn(async () => undefined),
          list: jest.fn(async () => [persisted]),
        } as never,
      });
      // Add an in-memory-only entry too
      const opts = InstallProviderCtor.mock.calls.at(-1)![0] as any;
      await opts.installationStore.storeInstallation({
        team: { id: 'T-mem' },
        bot: { token: 'bot-token-mem', scopes: ['chat:write'], userId: 'U1' },
        user: { id: 'U1' },
      });
      const list = await customMgr.listInstallations();
      const ids = list.map((e) => e.teamId).sort();
      expect(ids).toEqual(['T-disk', 'T-mem']);
    });

    it('fetchInstallation throws when missing', async () => {
      const opts = InstallProviderCtor.mock.calls[0]![0] as any;
      await expect(
        opts.installationStore.fetchInstallation({ teamId: 'T-missing' }),
      ).rejects.toThrow(/not found/i);
    });

    it('deleteInstallation removes a stored entry', async () => {
      const opts = InstallProviderCtor.mock.calls[0]![0] as any;
      await opts.installationStore.storeInstallation({ team: { id: 'T-del' } });
      await opts.installationStore.deleteInstallation({ teamId: 'T-del' });
      expect(await mgr.getInstallationInfo('T-del')).toBeNull();
    });

    it('getInstallationInfo returns the stored installation when present', async () => {
      const opts = InstallProviderCtor.mock.calls[0]![0] as any;
      await opts.installationStore.storeInstallation({
        team: { id: 'T-found' },
        bot: { token: 'xoxb' },
      });
      const info = await mgr.getInstallationInfo('T-found');
      expect(info).toBeTruthy();
      expect(info.team.id).toBe('T-found');
      expect(typeof info.stored_at).toBe('number');
    });

    it('revoke deletes both team-keyed and enterprise-keyed installations', async () => {
      const deleteSpy = jest.fn(async () => undefined);
      const customMgr = new SlackOAuthManager({
        ...baseConfig,
        tokenStore: {
          get: jest.fn(async () => null) as any,
          set: jest.fn(async () => undefined) as any,
          delete: deleteSpy as any,
          list: jest.fn(async () => []) as any,
        } as never,
      });
      // Seed the legacy installations Map via the storeInstallation hook (enterprise key)
      const opts = (InstallProviderCtor as unknown as jest.Mock).mock.calls.at(-1)![0] as any;
      await opts.installationStore.storeInstallation({
        team: { id: 'T-egrid', name: 'TeamA' },
        enterprise: { id: 'E-egrid', name: 'BigCo' },
        bot: { token: 'xoxb', scopes: [], userId: 'U1' },
        user: { id: 'U1' },
      });
      // Confirm it landed under E-egrid (Bug G premise)
      expect((customMgr as any).installations.has('E-egrid')).toBe(true);

      // Drive the revoke handler with team_id
      const router: any = customMgr.createRouter();
      const layer = router.stack.find(
        (l: any) => l.route?.path === '/revoke/:team_id' && l.route?.methods?.post,
      );
      const handler = layer.route.stack[0].handle;
      const req: any = { params: { team_id: 'T-egrid' }, ip: '127.0.0.1', get: () => undefined };
      const res: any = { json: jest.fn().mockReturnThis(), status: jest.fn().mockReturnThis() };
      await handler(req, res);

      // Both keys must be cleaned out
      expect((customMgr as any).installations.has('T-egrid')).toBe(false);
      expect((customMgr as any).installations.has('E-egrid')).toBe(false);
      expect(deleteSpy).toHaveBeenCalledWith('T-egrid'); // tokenStore is keyed by teamId only
    });

    it('writes to the injected TokenStore on successful install', async () => {
      const setSpy = jest.fn(async () => undefined);
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const customMgr = new SlackOAuthManager({
        ...baseConfig,
        tokenStore: {
          get: jest.fn(async () => null),
          set: setSpy as any,
          delete: jest.fn(async () => undefined),
          list: jest.fn(async () => []),
        } as never,
      });
      void customMgr;
      const opts = (InstallProviderCtor as unknown as jest.Mock).mock.calls.at(-1)![0] as any;
      await opts.installationStore.storeInstallation({
        team: { id: 'T-store', name: 'X' },
        bot: { token: 'xoxb', scopes: ['chat:write'], userId: 'U-bot' },
        user: { id: 'U1' },
        appId: 'A1',
      });
      expect(setSpy).toHaveBeenCalledWith(
        expect.objectContaining({ teamId: 'T-store', botToken: 'xoxb' }),
      );
    });

    it('uses enterprise.id as the persistence key for org-wide installs without team.id', async () => {
      // Bug FF: org-wide Enterprise Grid installs only carry enterprise.id;
      // the previous fallback to '' collapsed every such install into one
      // row in the TokenStore. The fix uses enterprise.id as a stable key.
      const setSpy = jest.fn(async () => undefined);
      const customMgr = new SlackOAuthManager({
        ...baseConfig,
        tokenStore: {
          get: jest.fn(async () => null),
          set: setSpy as any,
          delete: jest.fn(async () => undefined),
          list: jest.fn(async () => []),
        } as never,
      });
      const opts = (InstallProviderCtor as unknown as jest.Mock).mock.calls.at(-1)![0] as any;
      await opts.installationStore.storeInstallation({
        enterprise: { id: 'E-org', name: 'BigCo' },
        bot: { token: 'xoxb', scopes: [], userId: 'U-bot' },
        user: { id: 'U1' },
        appId: 'A1',
      });
      expect((customMgr as any).installations.has('E-org')).toBe(true);
      expect(setSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          teamId: 'E-org',
          enterpriseId: 'E-org',
          metadata: expect.objectContaining({ isEnterprise: true }),
        }),
      );
    });

    it('throws when both team.id and enterprise.id are missing', async () => {
      const setSpy = jest.fn(async () => undefined);
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const customMgr = new SlackOAuthManager({
        ...baseConfig,
        tokenStore: {
          get: jest.fn(async () => null),
          set: setSpy as any,
          delete: jest.fn(async () => undefined),
          list: jest.fn(async () => []),
        } as never,
      });
      void customMgr;
      const opts = (InstallProviderCtor as unknown as jest.Mock).mock.calls.at(-1)![0] as any;
      await expect(
        opts.installationStore.storeInstallation({
          bot: { token: 'xoxb', scopes: [], userId: 'U-bot' },
        }),
      ).rejects.toThrow(/no team.id or enterprise.id/i);
      expect(setSpy).not.toHaveBeenCalled();
    });
  });

  describe('createRouter', () => {
    it('returns an express router with /install and /callback routes registered', () => {
      const router: any = mgr.createRouter();
      const layers = router.stack.map(
        (l: any) => `${Object.keys(l.route?.methods ?? {})[0] ?? '?'}:${l.route?.path ?? ''}`,
      );
      expect(layers).toEqual(expect.arrayContaining(['get:/install', 'get:/callback']));
    });

    it('also registers status + revoke routes', () => {
      const router: any = mgr.createRouter();
      const paths = router.stack.map((l: any) => l.route?.path).filter(Boolean);
      expect(paths).toEqual(
        expect.arrayContaining(['/install', '/callback', '/status/:team_id', '/revoke/:team_id']),
      );
    });
  });

  describe('createRouter / revoke', () => {
    it('deletes the persisted token from the token store on revoke', async () => {
      // Easier path: inject a fresh manager with a spy store
      const setSpy = jest.fn(async () => undefined);
      const deleteSpy = jest.fn(async () => undefined);
      const getSpy = jest.fn(async () => null);
      const listSpy = jest.fn(async () => []);
      const customMgr = new SlackOAuthManager({
        ...baseConfig,
        tokenStore: {
          get: getSpy as any,
          set: setSpy as any,
          delete: deleteSpy as any,
          list: listSpy as any,
        } as never,
      });

      // Build the router and find the revoke handler
      const router: any = customMgr.createRouter();
      const layer = router.stack.find(
        (l: any) => l.route?.path === '/revoke/:team_id' && l.route?.methods?.post,
      );
      expect(layer).toBeDefined();
      const handler = layer.route.stack[0].handle;

      // Drive the handler
      const req: any = { params: { team_id: 'T-revoke' }, ip: '127.0.0.1', get: () => undefined };
      const res: any = { json: jest.fn().mockReturnThis(), status: jest.fn().mockReturnThis() };
      await handler(req, res);

      expect(deleteSpy).toHaveBeenCalledWith('T-revoke');
      expect(res.status).not.toHaveBeenCalledWith(500);
    });
  });

  describe('createOAuthManager', () => {
    it('returns a SlackOAuthManager instance', () => {
      expect(createOAuthManager(baseConfig)).toBeInstanceOf(SlackOAuthManager);
    });
  });
});
