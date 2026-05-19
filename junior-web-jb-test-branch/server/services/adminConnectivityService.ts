import { CosmosClient } from '@azure/cosmos';
import { DefaultAzureCredential } from '@azure/identity';
import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob';
import { randomUUID } from 'node:crypto';
import type { AgentConfigStore } from './agentConfigStore.js';
import type { LocalWorkspaceManager } from './localWorkspaceManager.js';
import { listPersistenceModes } from './persistenceModeTracker.js';
import type {
  AdminConnectivityReport,
  AdminConnectivityTestResult,
  ConnectivityCheck,
  ConnectivitySection,
  ConnectivityState,
  RequestIdentity
} from '../types.js';

interface CosmosContainerTarget {
  id: string;
  label: string;
  containerId: string;
}

export class AdminConnectivityService {
  constructor(
    private readonly agentConfigStore: AgentConfigStore,
    private readonly workspaceManager: LocalWorkspaceManager
  ) {}

  async getReport(): Promise<AdminConnectivityReport> {
    const [cosmos, storage] = await Promise.all([
      this.getCosmosSection(),
      this.getStorageSection()
    ]);

    return {
      generatedAt: new Date().toISOString(),
      sections: [cosmos, storage, this.getSecretsSection(), this.getAiSection()]
    };
  }

  async runTest(target: 'cosmos' | 'storage', identity: RequestIdentity): Promise<AdminConnectivityTestResult> {
    const startedAt = new Date().toISOString();
    const result = target === 'cosmos'
      ? await this.runCosmosTest()
      : await this.runStorageTest(identity);

    return {
      target,
      startedAt,
      completedAt: new Date().toISOString(),
      ...result
    };
  }

  private async getCosmosSection(): Promise<ConnectivitySection> {
    if (!process.env.COSMOS_DB_ENDPOINT) {
      return {
        id: 'cosmos',
        label: 'Cosmos DB',
        status: 'disabled',
        message: 'Cosmos DB is not configured for this runtime.',
        checks: this.cosmosTargets().map((target) => ({
          id: target.id,
          label: target.label,
          status: 'disabled',
          message: 'Disabled'
        }))
      };
    }

    const runtimeModes = listPersistenceModes().filter((status) => status.configured === 'cosmos');
    const fallbackModes = runtimeModes.filter((status) => status.effective === 'local');
    if (fallbackModes.length > 0) {
      return {
        id: 'cosmos',
        label: 'Cosmos DB',
        status: 'disabled',
        message: 'Cosmos-backed stores are configured, but the runtime is using local fallback mode.',
        checks: fallbackModes.map((status) => ({
          id: status.scope,
          label: this.labelForScope(status.scope),
          status: 'disabled',
          message: 'Running in local fallback mode',
          detail: status.reason
        }))
      };
    }

    const database = this.createCosmosClient().database(process.env.COSMOS_DB_DATABASE ?? 'JuniorWeb');
    const checks = await Promise.all(this.cosmosTargets().map(async (target) => {
      try {
        await database.container(target.containerId).read();
        return {
          id: target.id,
          label: target.label,
          status: 'ok',
          message: 'Reachable',
          detail: target.containerId
        } satisfies ConnectivityCheck;
      } catch (error) {
        return {
          id: target.id,
          label: target.label,
          status: 'error',
          message: this.describeError(error),
          detail: target.containerId
        } satisfies ConnectivityCheck;
      }
    }));

    return this.toSection('cosmos', 'Cosmos DB', checks, 'Container connectivity');
  }

  private async getStorageSection(): Promise<ConnectivitySection> {
    const backend = (process.env.JUNIOR_WORKSPACE_STORAGE_BACKEND?.trim().toLowerCase() === 'blob') ? 'blob' : 'local';
    const storageMode = listPersistenceModes().find((status) => status.scope === 'workspace-storage');
    if (backend !== 'blob') {
      return {
        id: 'storage',
        label: 'Workspace Storage',
        status: 'disabled',
        message: 'Workspace storage is running in local filesystem mode.',
        checks: [{
          id: 'workspace-storage',
          label: 'Workspace storage backend',
          status: 'disabled',
          message: 'Local filesystem mode'
        }]
      };
    }

    if (storageMode?.effective === 'local') {
      return {
        id: 'storage',
        label: 'Workspace Storage',
        status: 'disabled',
        message: 'Blob storage is configured, but the runtime is using local fallback mode.',
        checks: [{
          id: 'workspace-storage',
          label: 'Workspace storage backend',
          status: 'disabled',
          message: 'Running in local fallback mode',
          detail: storageMode.reason
        }]
      };
    }

    const containerName = process.env.JUNIOR_WORKSPACE_BLOB_CONTAINER ?? 'junior-workspaces';
    try {
      const container = this.createBlobContainerClient(containerName);
      const exists = await container.exists();
      const check: ConnectivityCheck = exists
        ? { id: 'workspace-storage', label: 'Blob container', status: 'ok', message: 'Reachable', detail: containerName }
        : { id: 'workspace-storage', label: 'Blob container', status: 'error', message: 'Container does not exist', detail: containerName };
      return this.toSection('storage', 'Workspace Storage', [check], 'Blob-backed workspace storage');
    } catch (error) {
      return this.toSection('storage', 'Workspace Storage', [{
        id: 'workspace-storage',
        label: 'Blob container',
        status: 'error',
        message: this.describeError(error),
        detail: containerName
      }], 'Blob-backed workspace storage');
    }
  }

  private getAiSection(): ConnectivitySection {
    const checks = this.agentConfigStore.listConnections()
      .filter((connection) => connection.type === 'azure-openai' || connection.type === 'azure-ai-search')
      .map((connection) => ({
        id: connection.id,
        label: connection.name,
        status: connection.configured ? 'ok' : 'error',
        message: connection.configured ? 'Configured' : `Missing ${connection.missing.join(', ') || 'required settings'}`,
        detail: connection.type === 'azure-openai' ? 'Azure OpenAI' : 'Azure AI Search'
      } satisfies ConnectivityCheck));

    return this.toSection('ai', 'AI Services', checks, 'Configured AI connectors');
  }

  private getSecretsSection(): ConnectivitySection {
    if (!process.env.AZURE_KEY_VAULT_URL && !process.env.KEY_VAULT_URI) {
      return {
        id: 'secrets',
        label: 'Workspace Secrets',
        status: 'disabled',
        message: 'Workspace secrets are running in local filesystem mode.',
        checks: [{
          id: 'workspace-secret-store',
          label: 'Workspace secret store',
          status: 'disabled',
          message: 'Local filesystem mode'
        }]
      };
    }

    const secretMode = listPersistenceModes().find((status) => status.scope === 'workspace-secret-store');
    if (secretMode?.effective === 'local') {
      return {
        id: 'secrets',
        label: 'Workspace Secrets',
        status: 'disabled',
        message: 'Key Vault is configured, but the runtime is using local fallback mode.',
        checks: [{
          id: 'workspace-secret-store',
          label: 'Workspace secret store',
          status: 'disabled',
          message: 'Running in local fallback mode',
          detail: secretMode.reason
        }]
      };
    }

    return {
      id: 'secrets',
      label: 'Workspace Secrets',
      status: 'ok',
      message: 'Key Vault-backed workspace secrets are configured.',
      checks: [{
        id: 'workspace-secret-store',
        label: 'Workspace secret store',
        status: 'ok',
        message: 'Key Vault mode configured',
        detail: process.env.AZURE_KEY_VAULT_URL ?? process.env.KEY_VAULT_URI
      }]
    };
  }

  private async runCosmosTest(): Promise<Omit<AdminConnectivityTestResult, 'target' | 'startedAt' | 'completedAt'>> {
    if (!process.env.COSMOS_DB_ENDPOINT) {
      return {
        status: 'disabled',
        message: 'Cosmos DB is not configured for this runtime.',
        checks: this.cosmosTargets().map((target) => ({
          id: target.id,
          label: target.label,
          status: 'disabled',
          message: 'Disabled'
        }))
      };
    }

    const fallbackModes = listPersistenceModes().filter((status) => status.configured === 'cosmos' && status.effective === 'local');
    if (fallbackModes.length > 0) {
      return {
        status: 'disabled',
        message: 'Cosmos-backed stores are currently running in local fallback mode.',
        checks: fallbackModes.map((status) => ({
          id: status.scope,
          label: this.labelForScope(status.scope),
          status: 'disabled',
          message: 'Running in local fallback mode',
          detail: status.reason
        }))
      };
    }

    const database = this.createCosmosClient().database(process.env.COSMOS_DB_DATABASE ?? 'JuniorWeb');
    const checks = await Promise.all(this.cosmosTargets().map(async (target) => {
      const container = database.container(target.containerId);
      const id = `diagnostic-${randomUUID()}`;
      const partitionKey = id;

      try {
        await container.items.upsert({ id, partitionKey, type: 'diagnostic', createdAt: new Date().toISOString() });
        const { resource } = await container.item(id, partitionKey).read();
        await container.item(id, partitionKey).delete();
        return {
          id: target.id,
          label: target.label,
          status: resource ? 'ok' : 'error',
          message: resource ? 'Write/read/delete succeeded' : 'Read after write returned no document',
          detail: target.containerId
        } satisfies ConnectivityCheck;
      } catch (error) {
        return {
          id: target.id,
          label: target.label,
          status: 'error',
          message: this.describeError(error),
          detail: target.containerId
        } satisfies ConnectivityCheck;
      }
    }));

    return {
      status: this.aggregateStatus(checks),
      message: 'Cosmos read/write diagnostic finished.',
      checks
    };
  }

  private async runStorageTest(identity: RequestIdentity): Promise<Omit<AdminConnectivityTestResult, 'target' | 'startedAt' | 'completedAt'>> {
    const backend = (process.env.JUNIOR_WORKSPACE_STORAGE_BACKEND?.trim().toLowerCase() === 'blob') ? 'blob' : 'local';
    const storageMode = listPersistenceModes().find((status) => status.scope === 'workspace-storage');
    if (backend !== 'blob') {
      return {
        status: 'disabled',
        message: 'Workspace storage is running in local filesystem mode.',
        checks: [{
          id: 'workspace-storage',
          label: 'Workspace storage backend',
          status: 'disabled',
          message: 'Local filesystem mode'
        }]
      };
    }

    if (storageMode?.effective === 'local') {
      const workspace = this.workspaceManager.getDefault(identity.userId);
      const path = `.junior/diagnostics/storage-${Date.now()}.txt`;
      const content = `local fallback storage diagnostic ${new Date().toISOString()}`;
      await workspace.storage.writeTextFile(path, content);
      const file = await workspace.storage.readTextFile(path);
      await workspace.storage.deletePath(path);
      return {
        status: file.content === content ? 'disabled' : 'error',
        message: file.content === content
          ? 'Workspace storage is running in local fallback mode and passed the local read/write test.'
          : 'Workspace storage is running in local fallback mode but the local read/write test failed.',
        checks: [{
          id: 'workspace-storage',
          label: 'Workspace storage backend',
          status: file.content === content ? 'disabled' : 'error',
          message: file.content === content ? 'Local fallback read/write/delete succeeded' : 'Local fallback content mismatch',
          detail: storageMode.reason
        }]
      };
    }

    const workspace = this.workspaceManager.getDefault(identity.userId);
    const path = `.junior/diagnostics/storage-${Date.now()}.txt`;
    const content = `storage diagnostic ${new Date().toISOString()}`;

    try {
      await workspace.storage.writeTextFile(path, content);
      const file = await workspace.storage.readTextFile(path);
      await workspace.storage.deletePath(path);
      const ok = file.content === content;
      return {
        status: ok ? 'ok' : 'error',
        message: ok ? 'Storage read/write/delete succeeded.' : 'Storage read/write content mismatch.',
        checks: [{
          id: 'workspace-storage',
          label: 'Workspace storage backend',
          status: ok ? 'ok' : 'error',
          message: ok ? 'Write/read/delete succeeded' : 'Content mismatch',
          detail: path
        }]
      };
    } catch (error) {
      return {
        status: 'error',
        message: 'Storage read/write diagnostic failed.',
        checks: [{
          id: 'workspace-storage',
          label: 'Workspace storage backend',
          status: 'error',
          message: this.describeError(error),
          detail: path
        }]
      };
    }
  }

  private createCosmosClient(): CosmosClient {
    const endpoint = process.env.COSMOS_DB_ENDPOINT;
    const requestedAuthMode = (process.env.COSMOS_DB_AUTH_MODE ?? 'entra').trim().toLowerCase();
    if (!endpoint) {
      throw new Error('COSMOS_DB_ENDPOINT is not configured.');
    }

    if (requestedAuthMode === 'api-key') {
      if (!process.env.COSMOS_DB_KEY) {
        throw new Error('COSMOS_DB_KEY is required when COSMOS_DB_AUTH_MODE=api-key.');
      }

      return new CosmosClient({ endpoint, key: process.env.COSMOS_DB_KEY });
    }

    return new CosmosClient({ endpoint, aadCredentials: new DefaultAzureCredential() });
  }

  private createBlobContainerClient(containerName: string): ContainerClient {
    const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
    const serviceUrl = process.env.AZURE_STORAGE_BLOB_SERVICE_URL;
    const client = connectionString?.trim()
      ? BlobServiceClient.fromConnectionString(connectionString)
      : serviceUrl?.trim()
        ? new BlobServiceClient(serviceUrl.trim(), new DefaultAzureCredential())
        : undefined;

    if (!client) {
      throw new Error('AZURE_STORAGE_CONNECTION_STRING or AZURE_STORAGE_BLOB_SERVICE_URL is required for blob storage.');
    }

    return client.getContainerClient(containerName);
  }

  private cosmosTargets(): CosmosContainerTarget[] {
    return [
      { id: 'agents', label: 'Agents', containerId: process.env.COSMOS_DB_CONFIG_CONTAINER ?? 'Agents' },
      { id: 'workspaces', label: 'Workspaces', containerId: process.env.COSMOS_DB_WORKSPACE_CONTAINER ?? 'Workspaces' },
      { id: 'workspace-config', label: 'WorkspaceConfig', containerId: process.env.COSMOS_DB_WORKSPACE_CONFIG_CONTAINER ?? process.env.COSMOS_DB_WORKSPACE_STATE_CONTAINER ?? 'WorkspaceConfig' },
      { id: 'chat-sessions', label: 'ChatSessions', containerId: process.env.COSMOS_DB_CHAT_CONTAINER ?? 'ChatSessions' },
      { id: 'pending-changes', label: 'PendingChanges', containerId: process.env.COSMOS_DB_PENDING_CHANGE_CONTAINER ?? 'PendingChanges' }
    ];
  }

  private toSection(id: ConnectivitySection['id'], label: string, checks: ConnectivityCheck[], message: string): ConnectivitySection {
    return {
      id,
      label,
      status: this.aggregateStatus(checks),
      message,
      checks
    };
  }

  private aggregateStatus(checks: ConnectivityCheck[]): ConnectivityState {
    if (checks.length === 0) {
      return 'disabled';
    }
    if (checks.every((check) => check.status === 'disabled')) {
      return 'disabled';
    }
    if (checks.some((check) => check.status === 'error')) {
      return 'error';
    }
    return 'ok';
  }

  private describeError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }

  private labelForScope(scope: string): string {
    switch (scope) {
      case 'config-store':
        return 'Admin config store';
      case 'workspace-metadata-store':
        return 'Workspace metadata store';
      case 'workspace-config-store':
        return 'Workspace config store';
      case 'chat-session-store':
        return 'Chat session store';
      case 'pending-change-store':
        return 'Pending change store';
      case 'workspace-storage':
        return 'Workspace storage backend';
      case 'workspace-secret-store':
        return 'Workspace secret store';
      default:
        return scope;
    }
  }
}
