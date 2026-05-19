import type { WorkspaceCatalog, WorkspaceMetadataStore } from './workspaceMetadataStore.js';
import type { CosmosContainerBinding } from './cosmosContainerFactory.js';
import { logCosmosOperationError } from './cosmosContainerFactory.js';

interface WorkspaceCatalogDocument extends WorkspaceCatalog {
  id: string;
  partitionKey: string;
  type: 'workspaceCatalog';
}

const catalogDocumentId = 'workspaceCatalog';

export class CosmosWorkspaceMetadataStore implements WorkspaceMetadataStore {
  constructor(private readonly binding: CosmosContainerBinding) {}

  async readCatalog(): Promise<WorkspaceCatalog | undefined> {
    try {
      const { resource } = await this.binding.container.item(catalogDocumentId, catalogDocumentId).read<WorkspaceCatalogDocument>();
      if (!resource) {
        return undefined;
      }

      return {
        defaultWorkspaceId: resource.defaultWorkspaceId,
        items: resource.items
      };
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 404) {
        return undefined;
      }

      logCosmosOperationError('workspace-metadata-store', 'read workspace catalog from Cosmos DB', this.binding.settings, error);
      throw error;
    }
  }

  async writeCatalog(catalog: WorkspaceCatalog): Promise<void> {
    try {
      await this.binding.container.items.upsert<WorkspaceCatalogDocument>({
        id: catalogDocumentId,
        partitionKey: catalogDocumentId,
        type: 'workspaceCatalog',
        ...catalog
      });
    } catch (error) {
      logCosmosOperationError('workspace-metadata-store', 'write workspace catalog to Cosmos DB', this.binding.settings, error);
      throw error;
    }
  }
}