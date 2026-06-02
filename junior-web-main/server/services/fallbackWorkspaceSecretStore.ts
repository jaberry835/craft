import type {
  WorkspaceConnectionSecret,
  WorkspaceConnectionSecrets,
  WorkspaceMcpSecret,
  WorkspaceMcpSecrets,
  WorkspaceSecretStore
} from './workspaceSecretStore.js';
import { updatePersistenceMode } from './persistenceModeTracker.js';

export class FallbackWorkspaceSecretStore implements WorkspaceSecretStore {
  private degraded = false;

  constructor(
    private readonly primary: WorkspaceSecretStore,
    private readonly fallback: WorkspaceSecretStore
  ) {
    updatePersistenceMode({ scope: 'workspace-secret-store', configured: 'key-vault', effective: 'key-vault', fallbackActive: false });
  }

  async loadConnectionSecrets(connectionIds: string[]): Promise<WorkspaceConnectionSecrets> {
    return this.run(() => this.primary.loadConnectionSecrets(connectionIds), () => this.fallback.loadConnectionSecrets(connectionIds));
  }

  async saveConnectionSecret(connectionId: string, secret: WorkspaceConnectionSecret): Promise<void> {
    await this.run(() => this.primary.saveConnectionSecret(connectionId, secret), () => this.fallback.saveConnectionSecret(connectionId, secret));
  }

  async deleteConnectionSecret(connectionId: string): Promise<void> {
    await this.run(() => this.primary.deleteConnectionSecret(connectionId), () => this.fallback.deleteConnectionSecret(connectionId));
  }

  async loadMcpSecrets(servers: Array<{ id: string }>): Promise<WorkspaceMcpSecrets> {
    return this.run(() => this.primary.loadMcpSecrets(servers), () => this.fallback.loadMcpSecrets(servers));
  }

  async saveMcpSecret(serverId: string, secret: WorkspaceMcpSecret): Promise<void> {
    await this.run(() => this.primary.saveMcpSecret(serverId, secret), () => this.fallback.saveMcpSecret(serverId, secret));
  }

  async deleteMcpSecret(serverId: string): Promise<void> {
    await this.run(() => this.primary.deleteMcpSecret(serverId), () => this.fallback.deleteMcpSecret(serverId));
  }

  private async run<T>(primary: () => Promise<T>, fallback: () => Promise<T>): Promise<T> {
    if (this.degraded) {
      return fallback();
    }

    try {
      return await primary();
    } catch (error) {
      this.degraded = true;
      updatePersistenceMode({
        scope: 'workspace-secret-store',
        configured: 'key-vault',
        effective: 'local',
        fallbackActive: true,
        reason: error instanceof Error ? error.message : String(error)
      });
      return fallback();
    }
  }
}
