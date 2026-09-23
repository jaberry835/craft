export type SessionStorageBackend = 'local' | 'cosmos';
export type WorkspaceStorageBackend = 'local' | 'blob' | 'unsupported';
export type CosmosAuthMode = 'entra' | 'api-key';

export interface SessionStorageStatus {
  backend: SessionStorageBackend;
  configured: boolean;
  ready: boolean;
  active: boolean;
  missing: string[];
  invalid: string[];
  authMode?: CosmosAuthMode;
  endpointHost?: string;
  database?: string;
  container?: string;
}

export interface WorkspaceFileStorageStatus {
  backend: WorkspaceStorageBackend;
  configured: boolean;
  ready: boolean;
  active: boolean;
  missing: string[];
  invalid: string[];
}

export interface StorageStatus {
  sessions: SessionStorageStatus;
  workspaceFiles: WorkspaceFileStorageStatus;
}

export interface CosmosSessionConfig {
  endpoint: string;
  database: string;
  container: string;
  authMode: CosmosAuthMode;
  key?: string;
}

export interface ResolvedStorageConfig {
  status: StorageStatus;
  cosmos?: CosmosSessionConfig;
}

const cosmosEnvNames = [
  'COSMOS_DB_ENDPOINT',
  'COSMOS_DB_DATABASE',
  'COSMOS_DB_CHAT_CONTAINER',
  'COSMOS_DB_AUTH_MODE',
  'COSMOS_DB_KEY'
] as const;

export function resolveStorageConfig(environment: NodeJS.ProcessEnv = process.env): ResolvedStorageConfig {
  const cosmosSelected = cosmosEnvNames.some((name) => Boolean(environment[name]?.trim()));
  const workspaceFiles = resolveWorkspaceFileStatus(environment);

  if (!cosmosSelected) {
    return {
      status: {
        sessions: {
          backend: 'local',
          configured: true,
          ready: true,
          active: true,
          missing: [],
          invalid: []
        },
        workspaceFiles
      }
    };
  }

  const required = [
    'COSMOS_DB_ENDPOINT',
    'COSMOS_DB_DATABASE',
    'COSMOS_DB_CHAT_CONTAINER',
    'COSMOS_DB_AUTH_MODE'
  ] as const;
  const missing: string[] = required.filter((name) => !environment[name]?.trim());
  const requestedAuthMode = environment.COSMOS_DB_AUTH_MODE?.trim().toLowerCase();
  const authMode = requestedAuthMode === 'entra' || requestedAuthMode === 'api-key'
    ? requestedAuthMode
    : undefined;
  const invalid: string[] = requestedAuthMode && !authMode ? ['COSMOS_DB_AUTH_MODE'] : [];
  if (authMode === 'api-key' && !environment.COSMOS_DB_KEY?.trim()) {
    missing.push('COSMOS_DB_KEY');
  }

  const endpoint = environment.COSMOS_DB_ENDPOINT?.trim() ?? '';
  const database = environment.COSMOS_DB_DATABASE?.trim() ?? '';
  const container = environment.COSMOS_DB_CHAT_CONTAINER?.trim() ?? '';
  if (endpoint && !isHttpsUrl(endpoint)) {
    invalid.push('COSMOS_DB_ENDPOINT');
  }
  const ready = missing.length === 0 && invalid.length === 0;
  const sessions: SessionStorageStatus = {
    backend: 'cosmos',
    configured: true,
    ready,
    active: ready,
    missing,
    invalid,
    authMode,
    endpointHost: endpointHost(endpoint),
    database: database || undefined,
    container: container || undefined
  };

  return {
    status: { sessions, workspaceFiles },
    cosmos: ready && authMode
      ? {
          endpoint,
          database,
          container,
          authMode,
          key: authMode === 'api-key' ? environment.COSMOS_DB_KEY : undefined
        }
      : undefined
  };
}

function resolveWorkspaceFileStatus(environment: NodeJS.ProcessEnv): WorkspaceFileStorageStatus {
  const requested = environment.JUNIOR_WORKSPACE_STORAGE_BACKEND?.trim().toLowerCase() || 'local';
  if (requested === 'local') {
    return {
      backend: 'local',
      configured: true,
      ready: true,
      active: true,
      missing: [],
      invalid: []
    };
  }
  if (requested !== 'blob') {
    return {
      backend: 'unsupported',
      configured: true,
      ready: false,
      active: false,
      missing: [],
      invalid: ['JUNIOR_WORKSPACE_STORAGE_BACKEND']
    };
  }

  const hasConnectionString = Boolean(environment.AZURE_STORAGE_CONNECTION_STRING?.trim());
  const hasServiceUrl = Boolean(environment.AZURE_STORAGE_BLOB_SERVICE_URL?.trim());
  return {
    backend: 'blob',
    configured: true,
    ready: hasConnectionString || hasServiceUrl,
    active: false,
    missing: hasConnectionString || hasServiceUrl
      ? []
      : ['AZURE_STORAGE_CONNECTION_STRING', 'AZURE_STORAGE_BLOB_SERVICE_URL'],
    invalid: []
  };
}

function endpointHost(endpoint: string): string | undefined {
  if (!endpoint) {
    return undefined;
  }
  try {
    return new URL(endpoint).host;
  } catch {
    return 'invalid-endpoint';
  }
}

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname);
  } catch {
    return false;
  }
}
