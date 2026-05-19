import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { WorkspaceConnectionSecret, WorkspaceConnectionSecrets, WorkspaceMcpSecret, WorkspaceMcpSecrets, WorkspaceSecretStore } from './workspaceSecretStore.js';

const connectorSecretsPath = '.junior/workspace-connector-secrets.local.json';
const mcpSecretsPath = '.junior/workspace-mcp-secrets.local.json';

export class LocalWorkspaceSecretStore implements WorkspaceSecretStore {
  constructor(private readonly rootPath: string) {}

  async loadConnectionSecrets(connectionIds: string[]): Promise<WorkspaceConnectionSecrets> {
    const secrets = await this.readJson<WorkspaceConnectionSecrets>(connectorSecretsPath, {});
    return Object.fromEntries(connectionIds.flatMap((connectionId) => secrets[connectionId] ? [[connectionId, secrets[connectionId]]] : []));
  }

  async saveConnectionSecret(connectionId: string, secret: WorkspaceConnectionSecret): Promise<void> {
    const secrets = await this.readJson<WorkspaceConnectionSecrets>(connectorSecretsPath, {});
    if (secret.apiKey?.trim()) {
      secrets[connectionId] = { apiKey: secret.apiKey.trim() };
    } else {
      delete secrets[connectionId];
    }
    await this.writeJson(connectorSecretsPath, secrets);
  }

  async deleteConnectionSecret(connectionId: string): Promise<void> {
    const secrets = await this.readJson<WorkspaceConnectionSecrets>(connectorSecretsPath, {});
    if (!secrets[connectionId]) {
      return;
    }

    delete secrets[connectionId];
    await this.writeJson(connectorSecretsPath, secrets);
  }

  async loadMcpSecrets(servers: Array<{ id: string }>): Promise<WorkspaceMcpSecrets> {
    const secrets = await this.readJson<WorkspaceMcpSecrets>(mcpSecretsPath, {});
    return Object.fromEntries(servers.flatMap((server) => secrets[server.id] ? [[server.id, secrets[server.id]]] : []));
  }

  async saveMcpSecret(serverId: string, secret: WorkspaceMcpSecret): Promise<void> {
    const secrets = await this.readJson<WorkspaceMcpSecrets>(mcpSecretsPath, {});
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

    if (Object.keys(nextSecret).length > 0) {
      secrets[serverId] = nextSecret;
    } else {
      delete secrets[serverId];
    }

    await this.writeJson(mcpSecretsPath, secrets);
  }

  async deleteMcpSecret(serverId: string): Promise<void> {
    const secrets = await this.readJson<WorkspaceMcpSecrets>(mcpSecretsPath, {});
    if (!secrets[serverId]) {
      return;
    }

    delete secrets[serverId];
    await this.writeJson(mcpSecretsPath, secrets);
  }

  private async readJson<T>(relativePath: string, fallback: T): Promise<T> {
    try {
      const content = await readFile(this.resolvePath(relativePath), 'utf8');
      return JSON.parse(content) as T;
    } catch {
      return fallback;
    }
  }

  private async writeJson<T>(relativePath: string, value: T): Promise<void> {
    const absolutePath = this.resolvePath(relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  }

  private resolvePath(relativePath: string): string {
    return path.join(this.rootPath, relativePath.replaceAll('/', path.sep));
  }
}