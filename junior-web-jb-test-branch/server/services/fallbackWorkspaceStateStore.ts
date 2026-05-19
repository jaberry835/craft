import type { WorkspaceStateStore } from './workspaceStateStore.js';
import { updatePersistenceMode } from './persistenceModeTracker.js';

export class FallbackWorkspaceStateStore implements WorkspaceStateStore {
  private degraded = false;

  constructor(
    private readonly primary: WorkspaceStateStore,
    private readonly fallback: WorkspaceStateStore
  ) {
    updatePersistenceMode({ scope: 'workspace-config-store', configured: 'cosmos', effective: 'cosmos', fallbackActive: false });
  }

  async readJson<T>(key: string, fallbackValue: T): Promise<T> {
    if (this.degraded) {
      return this.fallback.readJson(key, fallbackValue);
    }

    try {
      return await this.primary.readJson(key, fallbackValue);
    } catch {
      this.degraded = true;
      updatePersistenceMode({ scope: 'workspace-config-store', configured: 'cosmos', effective: 'local', fallbackActive: true });
      return this.fallback.readJson(key, fallbackValue);
    }
  }

  async writeJson<T>(key: string, value: T): Promise<void> {
    if (this.degraded) {
      await this.fallback.writeJson(key, value);
      return;
    }

    try {
      await this.primary.writeJson(key, value);
    } catch {
      this.degraded = true;
      updatePersistenceMode({ scope: 'workspace-config-store', configured: 'cosmos', effective: 'local', fallbackActive: true });
      await this.fallback.writeJson(key, value);
    }
  }
}
