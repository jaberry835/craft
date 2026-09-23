import assert from 'node:assert/strict';
import test from 'node:test';
import { CosmosChatSessionStore } from '../cosmosChatSessionStore.js';
import { JsonSessionStore } from '../sessionStore.js';
import { createSessionPersistence } from '../sessionStoreFactory.js';
import { resolveStorageConfig } from '../storageConfig.js';

test('session persistence defaults to project-specific local JSON storage', () => {
  const persistence = createSessionPersistence('C:\\aaa-data', { environment: {} });

  assert.equal(persistence.storageStatus.sessions.backend, 'local');
  assert.equal(persistence.storageStatus.sessions.ready, true);
  assert.ok(persistence.sessionStoreFactory('project-a') instanceof JsonSessionStore);
});

test('Cosmos configuration reports missing and invalid environment variable names', async () => {
  const persistence = createSessionPersistence('C:\\aaa-data', {
    environment: {
      COSMOS_DB_ENDPOINT: 'https://example.documents.azure.com/',
      COSMOS_DB_AUTH_MODE: 'unsupported'
    }
  });

  assert.deepEqual(persistence.storageStatus.sessions.missing, [
    'COSMOS_DB_DATABASE',
    'COSMOS_DB_CHAT_CONTAINER'
  ]);
  assert.deepEqual(persistence.storageStatus.sessions.invalid, ['COSMOS_DB_AUTH_MODE']);
  assert.equal(persistence.storageStatus.sessions.ready, false);
  await assert.rejects(
    () => persistence.sessionStoreFactory('project-a').list(),
    (error: Error & { statusCode?: number; code?: string }) => {
      assert.equal(error.statusCode, 503);
      assert.equal(error.code, 'storage_unavailable');
      assert.match(error.message, /COSMOS_DB_DATABASE/);
      return true;
    }
  );
});

test('complete Cosmos configuration selects Cosmos without constructing a local fallback', () => {
  let selected = false;
  const persistence = createSessionPersistence('C:\\aaa-data', {
    environment: {
      COSMOS_DB_ENDPOINT: 'https://safe-account.documents.azure.com/',
      COSMOS_DB_DATABASE: 'Aaa',
      COSMOS_DB_CHAT_CONTAINER: 'ChatSessions',
      COSMOS_DB_AUTH_MODE: 'entra'
    },
    createContainer: () => {
      selected = true;
      return {
        container: {} as never,
        settings: {
          endpointHost: 'safe-account.documents.azure.com',
          database: 'Aaa',
          container: 'ChatSessions',
          authMode: 'entra',
          keyConfigured: false
        }
      };
    }
  });

  assert.equal(selected, true);
  assert.equal(persistence.storageStatus.sessions.backend, 'cosmos');
  assert.ok(persistence.sessionStoreFactory('project-a') instanceof CosmosChatSessionStore);
});

test('API-key Cosmos auth is not ready without COSMOS_DB_KEY', () => {
  const resolved = resolveStorageConfig({
    COSMOS_DB_ENDPOINT: 'https://safe-account.documents.azure.com/',
    COSMOS_DB_DATABASE: 'Aaa',
    COSMOS_DB_CHAT_CONTAINER: 'ChatSessions',
    COSMOS_DB_AUTH_MODE: 'api-key'
  });

  assert.deepEqual(resolved.status.sessions.missing, ['COSMOS_DB_KEY']);
  assert.equal(resolved.status.sessions.ready, false);
});

test('storage status exposes safe metadata without Cosmos or blob credentials', () => {
  const cosmosKey = ['not', 'a', 'real', 'key'].join('-');
  const storageConnection = ['DefaultEndpointsProtocol=https', 'AccountName=fake', 'AccountKey=fake'].join(';');
  const resolved = resolveStorageConfig({
    COSMOS_DB_ENDPOINT: 'https://safe-account.documents.azure.com/',
    COSMOS_DB_DATABASE: 'Aaa',
    COSMOS_DB_CHAT_CONTAINER: 'ChatSessions',
    COSMOS_DB_AUTH_MODE: 'api-key',
    COSMOS_DB_KEY: cosmosKey,
    JUNIOR_WORKSPACE_STORAGE_BACKEND: 'blob',
    AZURE_STORAGE_CONNECTION_STRING: storageConnection
  });
  const serialized = JSON.stringify(resolved.status);

  assert.equal(resolved.status.sessions.endpointHost, 'safe-account.documents.azure.com');
  assert.equal(resolved.status.sessions.ready, true);
  assert.equal(resolved.status.workspaceFiles.backend, 'blob');
  assert.equal(resolved.status.workspaceFiles.ready, true);
  assert.equal(resolved.status.workspaceFiles.active, false);
  assert.doesNotMatch(serialized, new RegExp(cosmosKey));
  assert.doesNotMatch(serialized, /AccountKey/);
});

test('blob readiness names both supported credential settings when neither is configured', () => {
  const resolved = resolveStorageConfig({
    JUNIOR_WORKSPACE_STORAGE_BACKEND: 'blob'
  });

  assert.deepEqual(resolved.status.workspaceFiles.missing, [
    'AZURE_STORAGE_CONNECTION_STRING',
    'AZURE_STORAGE_BLOB_SERVICE_URL'
  ]);
  assert.equal(resolved.status.workspaceFiles.ready, false);
  assert.equal(resolved.status.workspaceFiles.active, false);
});

test('Cosmos readiness rejects malformed or non-HTTPS endpoints', () => {
  const resolved = resolveStorageConfig({
    COSMOS_DB_ENDPOINT: 'http://not-secure.example.test',
    COSMOS_DB_DATABASE: 'Aaa',
    COSMOS_DB_CHAT_CONTAINER: 'ChatSessions',
    COSMOS_DB_AUTH_MODE: 'entra'
  });

  assert.deepEqual(resolved.status.sessions.invalid, ['COSMOS_DB_ENDPOINT']);
  assert.equal(resolved.status.sessions.ready, false);
});
