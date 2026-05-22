import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileTokenStore } from '../../../src/storage/factory.js';

describe('FileTokenStore.ping', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'mcp-fts-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('resolves when parent dir exists and file does not yet', async () => {
    const store = new FileTokenStore(join(tmp, 'tokens.json'));
    await expect(store.ping!()).resolves.toBeUndefined();
  });

  it('resolves when grandparent dir exists but parent does not (creates parent)', async () => {
    const store = new FileTokenStore(join(tmp, 'newdir', 'tokens.json'));
    await expect(store.ping!()).resolves.toBeUndefined();
    expect(existsSync(join(tmp, 'newdir'))).toBe(true);
  });

  it('throws when tokens.json is corrupt JSON', async () => {
    // Bug EE: a swallowed parse error meant the next set() overwrote the
    // broken file with an empty map — silent data loss. read() must propagate.
    const path = join(tmp, 'tokens.json');
    writeFileSync(path, '{not json');
    const store = new FileTokenStore(path);
    await expect(store.list()).rejects.toThrow(/corrupt/);
  });

  it('returns empty list when tokens.json is an empty file', async () => {
    const path = join(tmp, 'tokens.json');
    writeFileSync(path, '');
    const store = new FileTokenStore(path);
    await expect(store.list()).resolves.toEqual([]);
  });

  it('throws when the parent dir is not writable', async () => {
    if (process.platform === 'win32') {
      return; // chmod is a no-op on Windows
    }
    if (process.getuid && process.getuid() === 0) {
      return; // root bypasses POSIX permissions; skip
    }
    const ro = join(tmp, 'readonly');
    mkdirSync(ro, { recursive: true });
    chmodSync(ro, 0o500); // r-x------
    try {
      const store = new FileTokenStore(join(ro, 'subdir', 'tokens.json'));
      await expect(store.ping!()).rejects.toThrow();
    } finally {
      chmodSync(ro, 0o700); // restore so the rmSync teardown can run
    }
  });
});
