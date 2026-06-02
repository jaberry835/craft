export interface WorkspaceConnectionSecret {
  apiKey?: string;
}

export interface WorkspaceMcpSecret {
  apiKey?: string;
  bearerToken?: string;
  customHeaders?: Record<string, string>;
}

export type WorkspaceConnectionSecrets = Record<string, WorkspaceConnectionSecret>;
export type WorkspaceMcpSecrets = Record<string, WorkspaceMcpSecret>;

export interface WorkspaceSecretStore {
  loadConnectionSecrets(connectionIds: string[]): Promise<WorkspaceConnectionSecrets>;
  saveConnectionSecret(connectionId: string, secret: WorkspaceConnectionSecret): Promise<void>;
  deleteConnectionSecret(connectionId: string): Promise<void>;
  loadMcpSecrets(servers: Array<{ id: string }>): Promise<WorkspaceMcpSecrets>;
  saveMcpSecret(serverId: string, secret: WorkspaceMcpSecret): Promise<void>;
  deleteMcpSecret(serverId: string): Promise<void>;
}