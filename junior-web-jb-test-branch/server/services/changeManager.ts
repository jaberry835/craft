import { randomUUID } from 'node:crypto';
import type { PendingChange } from '../types.js';
import type { PendingChangeStore } from './pendingChangeStore.js';
import type { WorkspaceStorage } from './workspaceStorage.js';

export class ChangeManager {
  constructor(
    private readonly storage: WorkspaceStorage,
    private readonly store: PendingChangeStore
  ) {}

  async list(): Promise<PendingChange[]> {
    return this.store.list();
  }

  async stageFileChange(path: string, proposedContent: string, summary: string): Promise<PendingChange> {
    let originalContent = '';
    let action: PendingChange['action'] = 'edit';

    try {
      originalContent = (await this.storage.readTextFile(path)).content;
    } catch {
      action = 'create';
    }

    const existing = await this.store.findByPath(path);
    const change: PendingChange = {
      id: existing?.id ?? randomUUID(),
      path,
      action,
      originalContent,
      proposedContent,
      summary,
      createdAt: existing?.createdAt ?? new Date().toISOString()
    };

    await this.store.save(change);
    return change;
  }

  async approve(changeId: string): Promise<PendingChange> {
    const change = await this.get(changeId);
    await this.storage.writeTextFile(change.path, change.proposedContent);
    await this.store.delete(change.id);
    return change;
  }

  async undo(changeId: string): Promise<PendingChange> {
    const change = await this.get(changeId);
    await this.store.delete(change.id);
    return change;
  }

  async approveAll(): Promise<PendingChange[]> {
    const changes = await this.list();
    for (const change of changes) {
      await this.approve(change.id);
    }
    return changes;
  }

  async undoAll(): Promise<PendingChange[]> {
    const changes = await this.list();
    await this.store.clear();
    return changes;
  }

  private async get(changeId: string): Promise<PendingChange> {
    const change = await this.store.get(changeId);

    if (!change) {
      throw new Error(`Pending change not found: ${changeId}`);
    }

    return change;
  }
}
