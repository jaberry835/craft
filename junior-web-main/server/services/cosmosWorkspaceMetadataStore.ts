import type { OwnedWorkspaceCatalog, WorkspaceCatalog, WorkspaceMetadataStore } from './workspaceMetadataStore.js';
import type { CosmosContainerBinding } from './cosmosContainerFactory.js';
import { logCosmosOperationError } from './cosmosContainerFactory.js';

interface WorkspaceCatalogDocument extends WorkspaceCatalog {
  id: string;
  partitionKey: string;
  ownerId?: string;
  type: 'workspaceCatalog';
}

const catalogDocumentId = 'workspaceCatalog';

export class CosmosWorkspaceMetadataStore implements WorkspaceMetadataStore {
  constructor(private readonly binding: CosmosContainerBinding) {}

  async readCatalog(ownerId: string): Promise<WorkspaceCatalog | undefined> {
    try {
      const { resource } = await this.binding.container.item(this.catalogDocumentId(ownerId), ownerId).read<WorkspaceCatalogDocument>();
      if (!resource) {
        return await this.readLegacyCatalog(ownerId);
      }

      return {
        defaultWorkspaceId: resource.defaultWorkspaceId,
        items: resource.items
      };
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 404) {
        return this.readLegacyCatalog(ownerId);
      }

      logCosmosOperationError('workspace-metadata-store', 'read workspace catalog from Cosmos DB', this.binding.settings, error);
      throw error;
    }
  }

  async writeCatalog(ownerId: string, catalog: WorkspaceCatalog): Promise<void> {
    try {
      await this.binding.container.items.upsert<WorkspaceCatalogDocument>({
        id: this.catalogDocumentId(ownerId),
        partitionKey: ownerId,
        ownerId,
        type: 'workspaceCatalog',
        ...catalog
      });
    } catch (error) {
      logCosmosOperationError('workspace-metadata-store', 'write workspace catalog to Cosmos DB', this.binding.settings, error);
      throw error;
    }
  }

  async listCatalogs(): Promise<OwnedWorkspaceCatalog[]> {
    try {
      const { resources } = await this.binding.container.items.query<WorkspaceCatalogDocument>({
        query: 'SELECT * FROM c WHERE c.type = @type',
        parameters: [
          { name: '@type', value: 'workspaceCatalog' }
        ]
      }).fetchAll();

      const ownerCatalogs: OwnedWorkspaceCatalog[] = [];
      const seenOwners = new Set<string>();

      for (const resource of resources) {
        if (resource.ownerId) {
          ownerCatalogs.push({
            ownerId: resource.ownerId,
            catalog: {
              defaultWorkspaceId: resource.defaultWorkspaceId,
              items: resource.items
            }
          });
          seenOwners.add(resource.ownerId);
        } else if (resource.id === catalogDocumentId) {
          for (const grouped of this.groupLegacyCatalog(resource)) {
            if (!seenOwners.has(grouped.ownerId)) {
              ownerCatalogs.push(grouped);
            }
          }
        }
      }

      return ownerCatalogs;
    } catch (error) {
      logCosmosOperationError('workspace-metadata-store', 'list workspace catalogs from Cosmos DB', this.binding.settings, error);
      throw error;
    }
  }

  private catalogDocumentId(ownerId: string): string {
    return `${catalogDocumentId}:${ownerId}`;
  }

  private async readLegacyCatalog(ownerId: string): Promise<WorkspaceCatalog | undefined> {
    try {
      const { resource } = await this.binding.container.item(catalogDocumentId, catalogDocumentId).read<WorkspaceCatalogDocument>();
      if (!resource) {
        return undefined;
      }

      const grouped = this.groupLegacyCatalog(resource).find((entry) => entry.ownerId === ownerId);
      return grouped?.catalog;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 404) {
        return undefined;
      }

      logCosmosOperationError('workspace-metadata-store', 'read legacy workspace catalog from Cosmos DB', this.binding.settings, error);
      throw error;
    }
  }

  private groupLegacyCatalog(resource: WorkspaceCatalogDocument): OwnedWorkspaceCatalog[] {
    const byOwner = new Map<string, WorkspaceCatalog>();

    for (const workspace of resource.items) {
      const ownerId = workspace.ownerId || 'admin';
      const catalog = byOwner.get(ownerId) ?? { defaultWorkspaceId: '', items: [] };
      catalog.items.push({ ...workspace, ownerId });
      byOwner.set(ownerId, catalog);
    }

    return Array.from(byOwner.entries()).map(([ownerId, ownerCatalog]) => ({
      ownerId,
      catalog: {
        defaultWorkspaceId: ownerCatalog.items.some((workspace) => workspace.id === resource.defaultWorkspaceId)
          ? resource.defaultWorkspaceId
          : ownerCatalog.items[0]?.id ?? '',
        items: ownerCatalog.items
      }
    }));
  }
}