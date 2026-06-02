import type { PendingChange } from '../types.js';
import type { PendingChangeStore } from './pendingChangeStore.js';
import { updatePersistenceMode } from './persistenceModeTracker.js';

export class FallbackPendingChangeStore implements PendingChangeStore {
  private degraded = false;

  constructor(
    private readonly primary: PendingChangeStore,
    private readonly fallback: PendingChangeStore
  ) {
    updatePersistenceMode({ scope: 'pending-change-store', configured: 'cosmos', effective: 'cosmos', fallbackActive: false });
  }

  async list(): Promise<PendingChange[]> {
    return this.run(() => this.primary.list(), () => this.fallback.list());
  }

  async get(changeId: string): Promise<PendingChange | undefined> {
    return this.run(() => this.primary.get(changeId), () => this.fallback.get(changeId));
  }

  async findByPath(path: string): Promise<PendingChange | undefined> {
    return this.run(() => this.primary.findByPath(path), () => this.fallback.findByPath(path));
  }

  async save(change: PendingChange): Promise<void> {
    await this.run(() => this.primary.save(change), () => this.fallback.save(change));
  }

  async delete(changeId: string): Promise<void> {
    await this.run(() => this.primary.delete(changeId), () => this.fallback.delete(changeId));
  }

  async clear(): Promise<void> {
    await this.run(() => this.primary.clear(), () => this.fallback.clear());
  }

  private async run<T>(primary: () => Promise<T>, fallback: () => Promise<T>): Promise<T> {
    if (this.degraded) {
      return fallback();
    }

    try {
      return await primary();
    } catch {
      this.degraded = true;
      updatePersistenceMode({ scope: 'pending-change-store', configured: 'cosmos', effective: 'local', fallbackActive: true });
      return fallback();
    }
  }
}
