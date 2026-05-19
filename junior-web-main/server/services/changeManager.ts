import { randomUUID } from 'node:crypto';
import type { PendingChange } from '../types.js';
import { LocalWorkspaceStorage } from './localWorkspaceStorage.js';

export class ChangeManager {
  private readonly changes = new Map<string, PendingChange>();

  constructor(private readonly storage: LocalWorkspaceStorage) {}

  list(): PendingChange[] {
    return Array.from(this.changes.values()).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async stageFileChange(path: string, proposedContent: string, summary: string): Promise<PendingChange> {
    let originalContent = '';
    let action: PendingChange['action'] = 'edit';

    try {
      originalContent = (await this.storage.readTextFile(path)).content;
    } catch {
      action = 'create';
    }

    const existing = this.list().find((change) => change.path === path);
    const change: PendingChange = {
      id: existing?.id ?? randomUUID(),
      path,
      action,
      originalContent,
      proposedContent,
      summary,
      createdAt: existing?.createdAt ?? new Date().toISOString()
    };

    this.changes.set(change.id, change);
    return change;
  }

  async approve(changeId: string): Promise<PendingChange> {
    const change = this.get(changeId);
    await this.storage.writeTextFile(change.path, change.proposedContent);
    this.changes.delete(change.id);
    return change;
  }

  undo(changeId: string): PendingChange {
    const change = this.get(changeId);
    this.changes.delete(change.id);
    return change;
  }

  async approveAll(): Promise<PendingChange[]> {
    const changes = this.list();
    for (const change of changes) {
      await this.approve(change.id);
    }
    return changes;
  }

  undoAll(): PendingChange[] {
    const changes = this.list();
    this.changes.clear();
    return changes;
  }

  private get(changeId: string): PendingChange {
    const change = this.changes.get(changeId);

    if (!change) {
      throw new Error(`Pending change not found: ${changeId}`);
    }

    return change;
  }
}
