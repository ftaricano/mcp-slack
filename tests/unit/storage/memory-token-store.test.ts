import { MemoryTokenStore } from '../../../src/storage/memory-token-store.js';
import type { InstalledToken } from '../../../src/storage/token-store.js';

const mkToken = (teamId: string): InstalledToken => ({
  teamId,
  userId: 'U1',
  botToken: 'xoxb',
  scopes: ['chat:write'],
  installedAt: Date.now(),
});

describe('MemoryTokenStore', () => {
  let s: MemoryTokenStore;
  beforeEach(() => {
    s = new MemoryTokenStore();
  });

  it('get returns null for unknown team', async () => {
    expect(await s.get('T-missing')).toBeNull();
  });

  it('set + get round-trips', async () => {
    await s.set(mkToken('T1'));
    expect(await s.get('T1')).toMatchObject({ teamId: 'T1' });
  });

  it('list returns all stored tokens', async () => {
    await s.set(mkToken('T1'));
    await s.set(mkToken('T2'));
    const list = await s.list();
    expect(list.map((t) => t.teamId).sort()).toEqual(['T1', 'T2']);
  });

  it('list returns [] when empty', async () => {
    expect(await s.list()).toEqual([]);
  });

  it('delete removes a token', async () => {
    await s.set(mkToken('T1'));
    await s.delete('T1');
    expect(await s.get('T1')).toBeNull();
  });

  it('set replaces an existing token', async () => {
    await s.set(mkToken('T1'));
    await s.set({ ...mkToken('T1'), botToken: 'bot-token-new' });
    expect((await s.get('T1'))!.botToken).toBe('bot-token-new');
  });

  it('ping() resolves', async () => {
    await expect(s.ping!()).resolves.toBeUndefined();
  });
});
