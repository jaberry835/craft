import { createHash } from 'node:crypto';
import type { WorkspaceSummary } from '../types.js';
import type { KeyVaultSecretClientBinding } from './keyVaultSecretClientFactory.js';
import type { WorkspaceConnectionSecret, WorkspaceConnectionSecrets, WorkspaceMcpSecret, WorkspaceMcpSecrets, WorkspaceSecretStore } from './workspaceSecretStore.js';

export class KeyVaultWorkspaceSecretStore implements WorkspaceSecretStore {
  constructor(
    private readonly binding: KeyVaultSecretClientBinding,
    private readonly workspace: WorkspaceSummary
  ) {}

  async loadConnectionSecrets(connectionIds: string[]): Promise<WorkspaceConnectionSecrets> {
    const entries = await Promise.all(connectionIds.map(async (connectionId) => {
      const secret = await this.readSecret<WorkspaceConnectionSecret>(this.connectionSecretName(connectionId));
      return secret && Object.keys(secret).length > 0 ? [connectionId, secret] as const : undefined;
    }));

    return Object.fromEntries(entries.filter((entry): entry is readonly [string, WorkspaceConnectionSecret] => Boolean(entry)));
  }

  async saveConnectionSecret(connectionId: string, secret: WorkspaceConnectionSecret): Promise<void> {
    const nextSecret: WorkspaceConnectionSecret = {};
    if (secret.apiKey?.trim()) {
      nextSecret.apiKey = secret.apiKey.trim();
    }

    await this.writeSecret(this.connectionSecretName(connectionId), nextSecret, {
      scope: 'workspace',
      kind: 'connection',
      workspaceId: this.workspace.id,
      ownerId: this.workspace.ownerId,
      connectionId
    });
  }

  async deleteConnectionSecret(connectionId: string): Promise<void> {
    await this.writeSecret(this.connectionSecretName(connectionId), {}, {
      scope: 'workspace',
      kind: 'connection',
      workspaceId: this.workspace.id,
      ownerId: this.workspace.ownerId,
      connectionId
    });
  }

  async loadMcpSecrets(servers: Array<{ id: string }>): Promise<WorkspaceMcpSecrets> {
    const entries = await Promise.all(servers.map(async (server) => {
      const secret = await this.readSecret<WorkspaceMcpSecret>(this.mcpSecretName(server.id));
      return secret && Object.keys(secret).length > 0 ? [server.id, secret] as const : undefined;
    }));

    return Object.fromEntries(entries.filter((entry): entry is readonly [string, WorkspaceMcpSecret] => Boolean(entry)));
  }

  async saveMcpSecret(serverId: string, secret: WorkspaceMcpSecret): Promise<void> {
    const nextSecret: WorkspaceMcpSecret = {};
    if (secret.apiKey?.trim()) {
      nextSecret.apiKey = secret.apiKey.trim();
    }
    if (secret.bearerToken?.trim()) {
      nextSecret.bearerToken = secret.bearerToken.trim();
    }
    if (secret.customHeaders && Object.keys(secret.customHeaders).length > 0) {
      nextSecret.customHeaders = secret.customHeaders;
    }

    await this.writeSecret(this.mcpSecretName(serverId), nextSecret, {
      scope: 'workspace',
      kind: 'mcp',
      workspaceId: this.workspace.id,
      ownerId: this.workspace.ownerId,
      serverId
    });
  }

  async deleteMcpSecret(serverId: string): Promise<void> {
    await this.writeSecret(this.mcpSecretName(serverId), {}, {
      scope: 'workspace',
      kind: 'mcp',
      workspaceId: this.workspace.id,
      ownerId: this.workspace.ownerId,
      serverId
    });
  }

  private async readSecret<T>(name: string): Promise<T | undefined> {
    try {
      const secret = await this.binding.client.getSecret(name);
      if (!secret.value) {
        return undefined;
      }

      return JSON.parse(secret.value) as T;
    } catch (error) {
      if (error && typeof error === 'object' && 'statusCode' in error && error.statusCode === 404) {
        return undefined;
      }

      throw error;
    }
  }

  private async writeSecret(name: string, value: object, tags: Record<string, string>): Promise<void> {
    await this.binding.client.setSecret(name, JSON.stringify(value), {
      contentType: 'application/json',
      tags
    });
  }

  private connectionSecretName(connectionId: string): string {
    return this.secretName('connection', connectionId);
  }

  private mcpSecretName(serverId: string): string {
    return this.secretName('mcp', serverId);
  }

  private secretName(kind: string, identifier: string): string {
    const baseName = [
      this.binding.prefix,
      'workspace',
      this.workspace.ownerId,
      this.workspace.id,
      kind,
      identifier
    ].map((segment) => this.normalizeSegment(segment)).filter(Boolean).join('-');

    if (baseName.length <= 127) {
      return baseName;
    }

    const hash = createHash('sha256').update(baseName).digest('hex').slice(0, 16);
    return `${baseName.slice(0, 110)}-${hash}`;
  }

  private normalizeSegment(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').replace(/--+/g, '-');
  }
}