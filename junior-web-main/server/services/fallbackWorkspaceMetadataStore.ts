import type { OwnedWorkspaceCatalog, WorkspaceCatalog, WorkspaceMetadataStore } from './workspaceMetadataStore.js';
import { updatePersistenceMode } from './persistenceModeTracker.js';

export class FallbackWorkspaceMetadataStore implements WorkspaceMetadataStore {
  private degraded = false;

  constructor(
    private readonly primary: WorkspaceMetadataStore,
    private readonly fallback: WorkspaceMetadataStore
  ) {
    updatePersistenceMode({ scope: 'workspace-metadata-store', configured: 'cosmos', effective: 'cosmos', fallbackActive: false });
  }

  async readCatalog(ownerId: string): Promise<WorkspaceCatalog | undefined> {
    if (this.degraded) {
      return this.fallback.readCatalog(ownerId);
    }

    try {
      return await this.primary.readCatalog(ownerId);
    } catch {
      this.degraded = true;
      updatePersistenceMode({ scope: 'workspace-metadata-store', configured: 'cosmos', effective: 'local', fallbackActive: true });
      return this.fallback.readCatalog(ownerId);
    }
  }

  async writeCatalog(ownerId: string, catalog: WorkspaceCatalog): Promise<void> {
    if (this.degraded) {
      await this.fallback.writeCatalog(ownerId, catalog);
      return;
    }

    try {
      await this.primary.writeCatalog(ownerId, catalog);
    } catch {
      this.degraded = true;
      updatePersistenceMode({ scope: 'workspace-metadata-store', configured: 'cosmos', effective: 'local', fallbackActive: true });
      await this.fallback.writeCatalog(ownerId, catalog);
    }
  }

  async listCatalogs(): Promise<OwnedWorkspaceCatalog[]> {
    if (this.degraded) {
      return this.fallback.listCatalogs();
    }

    try {
      return await this.primary.listCatalogs();
    } catch {
      this.degraded = true;
      updatePersistenceMode({ scope: 'workspace-metadata-store', configured: 'cosmos', effective: 'local', fallbackActive: true });
      return this.fallback.listCatalogs();
    }
  }
}
