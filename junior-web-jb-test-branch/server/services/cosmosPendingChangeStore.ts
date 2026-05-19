import type { PendingChange } from '../types.js';
import type { WorkspaceSummary } from '../types.js';
import type { CosmosContainerBinding } from './cosmosContainerFactory.js';
import { logCosmosOperationError } from './cosmosContainerFactory.js';
import type { PendingChangeStore } from './pendingChangeStore.js';

interface PendingChangeDocument extends PendingChange {
  partitionKey: string;
  workspaceId: string;
  ownerId: string;
  type: 'pendingChange';
}

export class CosmosPendingChangeStore implements PendingChangeStore {
  private readonly partitionKey: string;

  constructor(
    private readonly binding: CosmosContainerBinding,
    private readonly workspace: WorkspaceSummary
  ) {
    this.partitionKey = `${workspace.ownerId}:${workspace.id}`;
  }

  async list(): Promise<PendingChange[]> {
    try {
      const { resources } = await this.binding.container.items.query<PendingChangeDocument>({
        query: 'SELECT * FROM c WHERE c.partitionKey = @partitionKey AND c.type = @type ORDER BY c.createdAt ASC',
        parameters: [
          { name: '@partitionKey', value: this.partitionKey },
          { name: '@type', value: 'pendingChange' }
        ]
      }, { partitionKey: this.partitionKey }).fetchAll();

      return resources.map((change) => this.fromDocument(change));
    } catch (error) {
      logCosmosOperationError('pending-change-store', 'list pending changes from Cosmos DB', this.binding.settings, error);
      throw error;
    }
  }

  async get(changeId: string): Promise<PendingChange | undefined> {
    try {
      const { resource } = await this.binding.container.item(changeId, this.partitionKey).read<PendingChangeDocument>();
      return resource ? this.fromDocument(resource) : undefined;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 404) {
        return undefined;
      }

      logCosmosOperationError('pending-change-store', `read pending change ${changeId} from Cosmos DB`, this.binding.settings, error);
      throw error;
    }
  }

  async findByPath(path: string): Promise<PendingChange | undefined> {
    try {
      const { resources } = await this.binding.container.items.query<PendingChangeDocument>({
        query: 'SELECT TOP 1 * FROM c WHERE c.partitionKey = @partitionKey AND c.type = @type AND c.path = @path',
        parameters: [
          { name: '@partitionKey', value: this.partitionKey },
          { name: '@type', value: 'pendingChange' },
          { name: '@path', value: path }
        ]
      }, { partitionKey: this.partitionKey }).fetchAll();

      return resources[0] ? this.fromDocument(resources[0]) : undefined;
    } catch (error) {
      logCosmosOperationError('pending-change-store', `find pending change for path ${path} in Cosmos DB`, this.binding.settings, error);
      throw error;
    }
  }

  async save(change: PendingChange): Promise<void> {
    try {
      await this.binding.container.items.upsert<PendingChangeDocument>({
        ...change,
        partitionKey: this.partitionKey,
        workspaceId: this.workspace.id,
        ownerId: this.workspace.ownerId,
        type: 'pendingChange'
      });
    } catch (error) {
      logCosmosOperationError('pending-change-store', `save pending change ${change.id} to Cosmos DB`, this.binding.settings, error);
      throw error;
    }
  }

  async delete(changeId: string): Promise<void> {
    try {
      await this.binding.container.item(changeId, this.partitionKey).delete();
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 404) {
        return;
      }

      logCosmosOperationError('pending-change-store', `delete pending change ${changeId} from Cosmos DB`, this.binding.settings, error);
      throw error;
    }
  }

  async clear(): Promise<void> {
    const changes = await this.list();
    await Promise.all(changes.map((change) => this.delete(change.id)));
  }

  private fromDocument(document: PendingChangeDocument): PendingChange {
    return {
      id: document.id,
      path: document.path,
      action: document.action,
      originalContent: document.originalContent,
      proposedContent: document.proposedContent,
      summary: document.summary,
      createdAt: document.createdAt
    };
  }
}