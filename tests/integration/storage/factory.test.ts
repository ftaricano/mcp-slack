import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDefaultTokenStore, FileTokenStore } from '../../../src/storage/factory.js';
import { MemoryTokenStore } from '../../../src/storage/memory-token-store.js';

describe('createDefaultTokenStore', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'mcp-slack-store-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns a FileTokenStore by default at the configured path', async () => {
    const path = join(tmp, 'tokens.json');
    const store = await createDefaultTokenStore({ env: { MCP_SLACK_TOKEN_STORE_PATH: path } });
    expect(store).toBeInstanceOf(FileTokenStore);
    await store.set({
      teamId: 'T1',
      userId: 'U1',
      botToken: 'xoxb',
      scopes: [],
      installedAt: 1,
    });
    const onDisk = JSON.parse(readFileSync(path, 'utf8'));
    expect(onDisk).toEqual({ T1: expect.objectContaining({ teamId: 'T1' }) });
  });

  it('returns a MemoryTokenStore when MCP_SLACK_TOKEN_STORE_PATH=:memory:', async () => {
    const store = await createDefaultTokenStore({
      env: { MCP_SLACK_TOKEN_STORE_PATH: ':memory:' },
    });
    expect(store).toBeInstanceOf(MemoryTokenStore);
  });

  // Skipped without a real Redis; mock-based unit cover happens in storage/redis-token-store.test.ts.
  it.skip('returns a RedisTokenStore when REDIS_URL is set', async () => {
    /* requires real redis */
  });
});

describe('CLI + bootstrap share state via FileTokenStore', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'mcp-slack-share-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('two separate factory calls with same path see each other writes', async () => {
    const path = join(tmp, 'tokens.json');
    const a = await createDefaultTokenStore({ env: { MCP_SLACK_TOKEN_STORE_PATH: path } });
    await a.set({
      teamId: 'T-shared',
      userId: 'U1',
      botToken: 'xoxb',
      scopes: [],
      installedAt: 1,
    });
    const b = await createDefaultTokenStore({ env: { MCP_SLACK_TOKEN_STORE_PATH: path } });
    expect(await b.get('T-shared')).toMatchObject({ teamId: 'T-shared' });
  });
});
