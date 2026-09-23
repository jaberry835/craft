import { CosmosClient, type Container } from '@azure/cosmos';
import { DefaultAzureCredential } from '@azure/identity';
import type { CosmosSessionConfig } from './storageConfig.js';

export interface CosmosContainerSettings {
  endpointHost: string;
  database: string;
  container: string;
  authMode: CosmosSessionConfig['authMode'];
  keyConfigured: boolean;
}

export interface CosmosContainerBinding {
  container: Container;
  settings: CosmosContainerSettings;
}

export function createCosmosContainer(config: CosmosSessionConfig): CosmosContainerBinding {
  const client = config.authMode === 'api-key'
    ? new CosmosClient({ endpoint: config.endpoint, key: config.key })
    : new CosmosClient({
        endpoint: config.endpoint,
        aadCredentials: new DefaultAzureCredential()
      });

  return {
    container: client.database(config.database).container(config.container),
    settings: {
      endpointHost: safeEndpointHost(config.endpoint),
      database: config.database,
      container: config.container,
      authMode: config.authMode,
      keyConfigured: Boolean(config.key)
    }
  };
}

export function logCosmosError(
  operation: string,
  settings: CosmosContainerSettings,
  error: unknown
): void {
  const details = error && typeof error === 'object'
    ? {
        code: 'code' in error ? String(error.code) : 'unknown',
        substatus: 'substatus' in error ? String(error.substatus) : 'unknown'
      }
    : { code: 'unknown', substatus: 'unknown' };
  console.error(
    `[chat-session-store] Cosmos DB ${operation} failed: `
    + `endpointHost=${settings.endpointHost}, database=${settings.database}, `
    + `container=${settings.container}, authMode=${settings.authMode}, `
    + `keyConfigured=${settings.keyConfigured}, code=${details.code}, substatus=${details.substatus}.`
  );
}

function safeEndpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return 'invalid-endpoint';
  }
}
