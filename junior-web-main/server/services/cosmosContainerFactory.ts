import { CosmosClient, type Container } from '@azure/cosmos';
import { DefaultAzureCredential } from '@azure/identity';

export type CosmosAuthMode = 'entra' | 'api-key';

export interface CosmosContainerSettings {
  endpointHost: string;
  databaseId: string;
  containerId: string;
  authMode: CosmosAuthMode;
  keyConfigured: boolean;
}

export interface CosmosContainerBinding {
  container: Container;
  settings: CosmosContainerSettings;
}

export interface CosmosContainerFactoryOptions {
  label: string;
  containerEnvVar: string;
  defaultContainerId: string;
}

export function createOptionalCosmosContainer(options: CosmosContainerFactoryOptions): CosmosContainerBinding | undefined {
  const endpoint = process.env.COSMOS_DB_ENDPOINT;

  if (!endpoint) {
    console.info(`[${options.label}] Cosmos DB storage is disabled; using local persistence.`);
    return undefined;
  }

  const requestedAuthMode = (process.env.COSMOS_DB_AUTH_MODE ?? 'entra').trim().toLowerCase();
  const authMode: CosmosAuthMode = requestedAuthMode === 'api-key' ? 'api-key' : 'entra';
  const databaseId = process.env.COSMOS_DB_DATABASE ?? 'JuniorWeb';
  const containerId = process.env[options.containerEnvVar] ?? options.defaultContainerId;
  const keyConfigured = Boolean(process.env.COSMOS_DB_KEY);

  if (requestedAuthMode !== 'entra' && requestedAuthMode !== 'api-key') {
    console.warn(`[${options.label}] Unsupported COSMOS_DB_AUTH_MODE="${requestedAuthMode}"; using Entra ID auth.`);
  }

  if (authMode === 'api-key' && !keyConfigured) {
    throw new Error('COSMOS_DB_KEY is required when COSMOS_DB_AUTH_MODE=api-key.');
  }

  const settings: CosmosContainerSettings = {
    endpointHost: endpointHost(endpoint),
    databaseId,
    containerId,
    authMode,
    keyConfigured
  };

  console.info(`[${options.label}] Cosmos DB storage enabled: endpointHost=${settings.endpointHost}, database=${databaseId}, container=${containerId}, authMode=${authMode}, keyConfigured=${keyConfigured}.`);

  const client = authMode === 'api-key'
    ? new CosmosClient({ endpoint, key: process.env.COSMOS_DB_KEY })
    : new CosmosClient({ endpoint, aadCredentials: new DefaultAzureCredential() });

  return {
    container: client.database(databaseId).container(containerId),
    settings
  };
}

export function logCosmosOperationError(label: string, operation: string, settings: CosmosContainerSettings | undefined, error: unknown): void {
  const details = error && typeof error === 'object'
    ? {
      code: 'code' in error ? error.code : undefined,
      substatus: 'substatus' in error ? error.substatus : undefined,
      message: 'message' in error ? error.message : undefined
    }
    : { code: undefined, substatus: undefined, message: String(error) };
  const localAuthDisabledHint = settings?.authMode === 'api-key' && details.code === 401 && details.substatus === 5202
    ? ' Cosmos reported local/key authorization is disabled for this account; enable local auth on the account or use COSMOS_DB_AUTH_MODE=entra.'
    : '';

  console.error(`[${label}] Failed to ${operation}: endpointHost=${settings?.endpointHost ?? 'unknown'}, database=${settings?.databaseId ?? 'unknown'}, container=${settings?.containerId ?? 'unknown'}, authMode=${settings?.authMode ?? 'unknown'}, keyConfigured=${settings?.keyConfigured ?? false}, code=${details.code ?? 'unknown'}, substatus=${details.substatus ?? 'unknown'}, message=${details.message ?? 'unknown'}.${localAuthDisabledHint}`);
}

function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return 'invalid-endpoint';
  }
}