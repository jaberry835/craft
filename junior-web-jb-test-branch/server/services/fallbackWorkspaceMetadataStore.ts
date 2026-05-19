import type { WorkspaceCatalog, WorkspaceMetadataStore } from './workspaceMetadataStore.js';
import { updatePersistenceMode } from './persistenceModeTracker.js';

export class FallbackWorkspaceMetadataStore implements WorkspaceMetadataStore {
  private degraded = false;

  constructor(
    private readonly primary: WorkspaceMetadataStore,
    private readonly fallback: WorkspaceMetadataStore
  ) {
    updatePersistenceMode({ scope: 'workspace-metadata-store', configured: 'cosmos', effective: 'cosmos', fallbackActive: false });
  }

  async readCatalog(): Promise<WorkspaceCatalog | undefined> {
    if (this.degraded) {
      return this.fallback.readCatalog();
    }

    try {
      return await this.primary.readCatalog();
    } catch {
      this.degraded = true;
      updatePersistenceMode({ scope: 'workspace-metadata-store', configured: 'cosmos', effective: 'local', fallbackActive: true });
      return this.fallback.readCatalog();
    }
  }

  async writeCatalog(catalog: WorkspaceCatalog): Promise<void> {
    if (this.degraded) {
      await this.fallback.writeCatalog(catalog);
      return;
    }

    try {
      await this.primary.writeCatalog(catalog);
    } catch {
      this.degraded = true;
      updatePersistenceMode({ scope: 'workspace-metadata-store', configured: 'cosmos', effective: 'local', fallbackActive: true });
      await this.fallback.writeCatalog(catalog);
    }
  }
}
