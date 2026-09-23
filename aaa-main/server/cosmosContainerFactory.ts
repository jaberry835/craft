import {
  CosmosClient,
  type Container,
  type ContainerDefinition
} from '@azure/cosmos';
import { DefaultAzureCredential } from '@azure/identity';
import type { CosmosSessionConfig } from './storageConfig.js';

export interface CosmosContainerSettings {
  endpointHost: string;
  database: string;
  container: string;
  authMode: CosmosSessionConfig['authMode'];
  keyConfigured: boolean;
  schemaMode: CosmosSessionConfig['schemaMode'];
  autoCreate: boolean;
}

export interface CosmosContainerBinding {
  container: Container;
  settings: CosmosContainerSettings;
  ensureReady?: () => Promise<void>;
}

export function createCosmosContainer(
  config: CosmosSessionConfig,
  clientOverride?: CosmosClient
): CosmosContainerBinding {
  const client = clientOverride ?? (config.authMode === 'api-key'
    ? new CosmosClient({ endpoint: config.endpoint, key: config.key })
    : new CosmosClient({
        endpoint: config.endpoint,
        aadCredentials: new DefaultAzureCredential()
      }));
  const expectedPartitionPath = partitionPathForSchema(config.schemaMode);
  const binding: CosmosContainerBinding = {
    container: client.database(config.database).container(config.container),
    settings: {
      endpointHost: safeEndpointHost(config.endpoint),
      database: config.database,
      container: config.container,
      authMode: config.authMode,
      keyConfigured: Boolean(config.key),
      schemaMode: config.schemaMode,
      autoCreate: config.autoCreate
    }
  };
  let initialization: Promise<void> | undefined;
  binding.ensureReady = () => {
    initialization ??= initializeContainer(client, binding, config, expectedPartitionPath);
    return initialization;
  };
  return binding;
}

export function partitionPathForSchema(
  schemaMode: CosmosSessionConfig['schemaMode']
): '/projectId' | '/partitionKey' {
  return schemaMode === 'native' ? '/projectId' : '/partitionKey';
}

export function validateContainerPartitionKey(
  definition: Pick<ContainerDefinition, 'partitionKey'> | undefined,
  expectedPath: string
): void {
  const actualPaths = definition?.partitionKey?.paths ?? [];
  if (actualPaths.length !== 1 || actualPaths[0] !== expectedPath) {
    throw new CosmosSchemaMismatchError(expectedPath, actualPaths);
  }
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
    + `schemaMode=${settings.schemaMode}, autoCreate=${settings.autoCreate}, `
    + `keyConfigured=${settings.keyConfigured}, code=${details.code}, substatus=${details.substatus}.`
  );
}

export class CosmosSchemaMismatchError extends Error {
  readonly code = 'partition_key_mismatch';

  constructor(expectedPath: string, actualPaths: string[]) {
    super(
      `Cosmos DB chat container partition key mismatch: expected ${expectedPath}, `
      + `found ${actualPaths.length > 0 ? actualPaths.join(', ') : 'no partition path'}.`
    );
  }
}

async function initializeContainer(
  client: CosmosClient,
  binding: CosmosContainerBinding,
  config: CosmosSessionConfig,
  expectedPartitionPath: string
): Promise<void> {
  if (config.autoCreate) {
    const { database } = await client.databases.createIfNotExists({ id: config.database });
    const { container } = await database.containers.createIfNotExists({
      id: config.container,
      partitionKey: { paths: [expectedPartitionPath] }
    });
    binding.container = container;
  }
  const { resource } = await binding.container.read();
  validateContainerPartitionKey(resource, expectedPartitionPath);
}

function safeEndpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return 'invalid-endpoint';
  }
}
