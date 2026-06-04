import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import type { WorkspaceRuntime } from '../services/workspaceRegistry.js';
import { LocalWorkspaceManager } from '../services/localWorkspaceManager.js';
import type { OwnedWorkspaceCatalog, WorkspaceCatalog, WorkspaceMetadataStore } from '../services/workspaceMetadataStore.js';
import type { WorkspaceSummary } from '../types.js';

class InMemoryMetadataStore implements WorkspaceMetadataStore {
  constructor(private readonly catalogs: OwnedWorkspaceCatalog[]) {}

  async readCatalog(ownerId: string): Promise<WorkspaceCatalog | undefined> {
    return this.catalogs.find((entry) => entry.ownerId === ownerId)?.catalog;
  }

  async writeCatalog(ownerId: string, catalog: WorkspaceCatalog): Promise<void> {
    const index = this.catalogs.findIndex((entry) => entry.ownerId === ownerId);
    if (index >= 0) {
      this.catalogs[index] = { ownerId, catalog };
      return;
    }

    this.catalogs.push({ ownerId, catalog });
  }

  async listCatalogs(): Promise<OwnedWorkspaceCatalog[]> {
    return this.catalogs;
  }
}

test('local workspace manager normalizes catalog root paths to current environment', async () => {
  const workspacesRoot = path.join(process.cwd(), 'data', 'workspaces');
  const metadata = new InMemoryMetadataStore([{
    ownerId: 'admin',
    catalog: {
      defaultWorkspaceId: 'anothertestworkspace',
      items: [{
        id: 'anothertestworkspace',
        name: 'Another Test Workspace',
        ownerId: 'admin',
        rootPath: 'C:/home/site/wwwroot/data/workspaces/anothertestworkspace'
      }]
    }
  }]);

  const manager = new LocalWorkspaceManager(
    workspacesRoot,
    async (workspace: WorkspaceSummary) => ({
      ...workspace,
      storage: {} as WorkspaceRuntime['storage'],
      configStore: {} as WorkspaceRuntime['configStore'],
      workspaceIndexer: {} as WorkspaceRuntime['workspaceIndexer'],
      changeManager: {} as WorkspaceRuntime['changeManager'],
      agent: {} as WorkspaceRuntime['agent']
    }),
    metadata
  );

  await manager.load();
  const resolved = manager.getDefault('admin');

  assert.equal(resolved.rootPath, path.join(workspacesRoot, 'anothertestworkspace'));
});