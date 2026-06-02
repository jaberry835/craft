import type { WorkspaceStorage } from './workspaceStorage.js';
import type { WorkspaceStateStore } from './workspaceStateStore.js';

export class LocalWorkspaceStateStore implements WorkspaceStateStore {
  constructor(private readonly storage: WorkspaceStorage) {}

  async readJson<T>(key: string, fallback: T): Promise<T> {
    try {
      const file = await this.storage.readTextFile(key);
      return JSON.parse(file.content) as T;
    } catch {
      return fallback;
    }
  }

  async writeJson<T>(key: string, value: T): Promise<void> {
    await this.storage.writeTextFile(key, `${JSON.stringify(value, null, 2)}\n`);
  }
}