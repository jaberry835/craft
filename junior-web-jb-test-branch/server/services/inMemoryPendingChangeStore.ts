import type { PendingChange } from '../types.js';
import type { PendingChangeStore } from './pendingChangeStore.js';

export class InMemoryPendingChangeStore implements PendingChangeStore {
  private readonly changes = new Map<string, PendingChange>();

  async list(): Promise<PendingChange[]> {
    return Array.from(this.changes.values()).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async get(changeId: string): Promise<PendingChange | undefined> {
    return this.changes.get(changeId);
  }

  async findByPath(path: string): Promise<PendingChange | undefined> {
    const changes = await this.list();
    return changes.find((change) => change.path === path);
  }

  async save(change: PendingChange): Promise<void> {
    this.changes.set(change.id, change);
  }

  async delete(changeId: string): Promise<void> {
    this.changes.delete(changeId);
  }

  async clear(): Promise<void> {
    this.changes.clear();
  }
}