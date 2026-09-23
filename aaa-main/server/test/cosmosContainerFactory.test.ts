import type { Container, CosmosClient } from '@azure/cosmos';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CosmosSchemaMismatchError,
  createCosmosContainer,
  validateContainerPartitionKey
} from '../cosmosContainerFactory.js';
import type { CosmosSessionConfig } from '../storageConfig.js';

const baseConfig: CosmosSessionConfig = {
  endpoint: 'https://safe-account.documents.azure.com/',
  database: 'AaaChat',
  container: 'AaaChatSessions',
  authMode: 'entra',
  schemaMode: 'native',
  autoCreate: false,
  ownerId: 'aaa'
};

function mockContainer(partitionPath: string): Container {
  return {
    read: async () => ({
      resource: {
        id: 'AaaChatSessions',
        partitionKey: { paths: [partitionPath] }
      }
    })
  } as unknown as Container;
}

test('container initialization validates native partition schema without creating resources', async () => {
  const container = mockContainer('/projectId');
  let createCalls = 0;
  const client = {
    database: () => ({ container: () => container }),
    databases: {
      createIfNotExists: async () => {
        createCalls += 1;
        throw new Error('should not create');
      }
    }
  } as unknown as CosmosClient;

  const binding = createCosmosContainer(baseConfig, client);
  await binding.ensureReady?.();
  assert.equal(binding.container, container);
  assert.equal(createCalls, 0);
});

test('auto-create uses createIfNotExists with the configured native partition path', async () => {
  const initialContainer = mockContainer('/unused');
  const createdContainer = mockContainer('/projectId');
  const calls: string[] = [];
  const database = {
    container: () => initialContainer,
    containers: {
      createIfNotExists: async (request: {
        id: string;
        partitionKey: { paths: string[] };
      }) => {
        calls.push(`container:${request.id}:${request.partitionKey.paths.join(',')}`);
        return { container: createdContainer };
      }
    }
  };
  const client = {
    database: () => database,
    databases: {
      createIfNotExists: async ({ id }: { id: string }) => {
        calls.push(`database:${id}`);
        return { database };
      }
    }
  } as unknown as CosmosClient;

  const binding = createCosmosContainer({ ...baseConfig, autoCreate: true }, client);
  await binding.ensureReady?.();
  await binding.ensureReady?.();

  assert.deepEqual(calls, [
    'database:AaaChat',
    'container:AaaChatSessions:/projectId'
  ]);
  assert.equal(binding.container, createdContainer);
});

test('partition schema validation reports an explicit mismatch', () => {
  assert.throws(
    () => validateContainerPartitionKey(
      { partitionKey: { paths: ['/partitionKey'] } },
      '/projectId'
    ),
    (error: Error & { code?: string }) => {
      assert.ok(error instanceof CosmosSchemaMismatchError);
      assert.equal(error.code, 'partition_key_mismatch');
      assert.match(error.message, /expected \/projectId, found \/partitionKey/);
      return true;
    }
  );
});
