import type { InstalledToken, TokenStore } from './token-store.js';

export class MemoryTokenStore implements TokenStore {
  private readonly map = new Map<string, InstalledToken>();

  async get(teamId: string): Promise<InstalledToken | null> {
    return this.map.get(teamId) ?? null;
  }

  async set(token: InstalledToken): Promise<void> {
    this.map.set(token.teamId, token);
  }

  async delete(teamId: string): Promise<void> {
    this.map.delete(teamId);
  }

  async list(): Promise<InstalledToken[]> {
    return Array.from(this.map.values());
  }

  async ping(): Promise<void> {
    // In-memory store is always healthy as long as the process is alive.
  }
}
