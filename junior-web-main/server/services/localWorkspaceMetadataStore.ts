import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { OwnedWorkspaceCatalog, WorkspaceCatalog, WorkspaceMetadataStore } from './workspaceMetadataStore.js';

export class LocalWorkspaceMetadataStore implements WorkspaceMetadataStore {
  private readonly catalogPath: string;
  private readonly ownerCatalogsRoot: string;

  constructor(private readonly workspacesRoot: string) {
    this.catalogPath = path.join(this.workspacesRoot, 'catalog.json');
    this.ownerCatalogsRoot = path.join(this.workspacesRoot, '.workspace-catalogs');
  }

  async readCatalog(ownerId: string): Promise<WorkspaceCatalog | undefined> {
    await mkdir(this.ownerCatalogsRoot, { recursive: true });

    try {
      const raw = await readFile(this.catalogPathForOwner(ownerId), 'utf8');
      return JSON.parse(raw) as WorkspaceCatalog;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return this.readLegacyCatalog(ownerId);
      }

      throw error;
    }
  }

  async writeCatalog(ownerId: string, catalog: WorkspaceCatalog): Promise<void> {
    await mkdir(this.ownerCatalogsRoot, { recursive: true });
    await writeFile(this.catalogPathForOwner(ownerId), `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
  }

  async listCatalogs(): Promise<OwnedWorkspaceCatalog[]> {
    await mkdir(this.ownerCatalogsRoot, { recursive: true });

    const entries = await readdir(this.ownerCatalogsRoot, { withFileTypes: true });
    const ownerCatalogs = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map(async (entry) => {
        const ownerId = decodeURIComponent(entry.name.slice(0, -'.json'.length));
        const catalog = await this.readCatalog(ownerId);
        return catalog ? { ownerId, catalog } : null;
      }));

    const concreteCatalogs = ownerCatalogs.filter((entry): entry is OwnedWorkspaceCatalog => entry !== null);
    if (concreteCatalogs.length > 0) {
      return concreteCatalogs;
    }

    return this.readLegacyCatalogs();
  }

  private catalogPathForOwner(ownerId: string): string {
    return path.join(this.ownerCatalogsRoot, `${encodeURIComponent(ownerId)}.json`);
  }

  private async readLegacyCatalog(ownerId: string): Promise<WorkspaceCatalog | undefined> {
    try {
      const raw = await readFile(this.catalogPath, 'utf8');
      const catalog = JSON.parse(raw) as WorkspaceCatalog;
      const items = catalog.items.filter((workspace) => (workspace.ownerId || 'admin') === ownerId);
      if (items.length === 0) {
        return undefined;
      }

      const defaultWorkspaceId = items.some((workspace) => workspace.id === catalog.defaultWorkspaceId)
        ? catalog.defaultWorkspaceId
        : items[0]?.id ?? '';

      return {
        defaultWorkspaceId,
        items
      };
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return undefined;
      }

      throw error;
    }
  }

  private async readLegacyCatalogs(): Promise<OwnedWorkspaceCatalog[]> {
    try {
      const raw = await readFile(this.catalogPath, 'utf8');
      const catalog = JSON.parse(raw) as WorkspaceCatalog;
      const byOwner = new Map<string, WorkspaceCatalog>();

      for (const workspace of catalog.items) {
        const ownerId = workspace.ownerId || 'admin';
        const existing = byOwner.get(ownerId) ?? { defaultWorkspaceId: '', items: [] };
        existing.items.push({ ...workspace, ownerId });
        if (!existing.defaultWorkspaceId || existing.defaultWorkspaceId === catalog.defaultWorkspaceId) {
          existing.defaultWorkspaceId = existing.defaultWorkspaceId || workspace.id;
        }
        byOwner.set(ownerId, existing);
      }

      return Array.from(byOwner.entries()).map(([ownerId, ownerCatalog]) => ({
        ownerId,
        catalog: {
          defaultWorkspaceId: ownerCatalog.items.some((workspace) => workspace.id === catalog.defaultWorkspaceId)
            ? catalog.defaultWorkspaceId
            : ownerCatalog.items[0]?.id ?? '',
          items: ownerCatalog.items
        }
      }));
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return [];
      }

      throw error;
    }
  }
}