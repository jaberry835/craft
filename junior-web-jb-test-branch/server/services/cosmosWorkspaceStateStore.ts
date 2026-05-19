import type { WorkspaceSummary } from '../types.js';
import type { CosmosContainerBinding } from './cosmosContainerFactory.js';
import { logCosmosOperationError } from './cosmosContainerFactory.js';
import type { WorkspaceStateStore } from './workspaceStateStore.js';

interface WorkspaceStateDocument<T> {
  id: string;
  partitionKey: string;
  workspaceId: string;
  ownerId: string;
  type: 'workspaceState';
  key: string;
  value: T;
}

export class CosmosWorkspaceStateStore implements WorkspaceStateStore {
  private readonly partitionKey: string;

  constructor(
    private readonly binding: CosmosContainerBinding,
    private readonly workspace: WorkspaceSummary
  ) {
    this.partitionKey = `${workspace.ownerId}:${workspace.id}`;
  }

  async readJson<T>(key: string, fallback: T): Promise<T> {
    const id = this.documentId(key);

    try {
      const { resource } = await this.binding.container.item(id, this.partitionKey).read<WorkspaceStateDocument<T>>();
      return resource?.value ?? fallback;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 404) {
        return fallback;
      }

      logCosmosOperationError('workspace-state-store', `read workspace state ${key} from Cosmos DB`, this.binding.settings, error);
      throw error;
    }
  }

  async writeJson<T>(key: string, value: T): Promise<void> {
    const id = this.documentId(key);

    try {
      await this.binding.container.items.upsert<WorkspaceStateDocument<T>>({
        id,
        partitionKey: this.partitionKey,
        workspaceId: this.workspace.id,
        ownerId: this.workspace.ownerId,
        type: 'workspaceState',
        key,
        value
      });
    } catch (error) {
      logCosmosOperationError('workspace-state-store', `write workspace state ${key} to Cosmos DB`, this.binding.settings, error);
      throw error;
    }
  }

  private documentId(key: string): string {
    return `workspace-state:${Buffer.from(key, 'utf8').toString('base64url')}`;
  }
}