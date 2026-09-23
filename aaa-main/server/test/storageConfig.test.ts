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
    createContainer: (config) => {
      selected = true;
      assert.equal(config.ownerId, 'aaa');
      assert.equal(config.schemaMode, 'native');
      assert.equal(config.autoCreate, false);
      return {
        container: {} as never,
        settings: {
          endpointHost: 'safe-account.documents.azure.com',
          database: 'Aaa',
          container: 'ChatSessions',
          authMode: 'entra',
          keyConfigured: false,
          schemaMode: 'native',
          autoCreate: false
        }
      };
    }
  });

  assert.equal(selected, true);
  assert.equal(persistence.storageStatus.sessions.backend, 'cosmos');
  assert.ok(persistence.sessionStoreFactory('project-a') instanceof CosmosChatSessionStore);
});

test('Cosmos schema and auto-create settings are explicit and validated', () => {
  const configured = resolveStorageConfig({
    COSMOS_DB_ENDPOINT: 'https://safe-account.documents.azure.com/',
    COSMOS_DB_DATABASE: 'Aaa',
    COSMOS_DB_CHAT_CONTAINER: 'ChatSessions',
    COSMOS_DB_AUTH_MODE: 'entra',
    COSMOS_DB_CHAT_SCHEMA_MODE: 'junior-compatible',
    COSMOS_DB_AUTO_CREATE: 'true',
    COSMOS_DB_OWNER_ID: 'aaa-local'
  });
  assert.equal(configured.cosmos?.ownerId, 'aaa-local');
  assert.equal(configured.cosmos?.schemaMode, 'junior-compatible');
  assert.equal(configured.cosmos?.autoCreate, true);
  assert.equal(configured.status.sessions.schemaMode, 'junior-compatible');
  assert.equal(configured.status.sessions.autoCreate, true);

  const invalid = resolveStorageConfig({
    COSMOS_DB_ENDPOINT: 'https://safe-account.documents.azure.com/',
    COSMOS_DB_DATABASE: 'Aaa',
    COSMOS_DB_CHAT_CONTAINER: 'ChatSessions',
    COSMOS_DB_AUTH_MODE: 'entra',
    COSMOS_DB_CHAT_SCHEMA_MODE: 'shared',
    COSMOS_DB_AUTO_CREATE: 'sometimes',
    COSMOS_DB_OWNER_ID: 'other:owner'
  });
  assert.deepEqual(invalid.status.sessions.invalid, [
    'COSMOS_DB_CHAT_SCHEMA_MODE',
    'COSMOS_DB_AUTO_CREATE'
  ]);
  assert.equal(invalid.status.sessions.ready, false);
  assert.equal(invalid.cosmos, undefined);
});

test('Junior-compatible mode rejects unsafe owner partition prefixes', () => {
  const resolved = resolveStorageConfig({
    COSMOS_DB_ENDPOINT: 'https://safe-account.documents.azure.com/',
    COSMOS_DB_DATABASE: 'Aaa',
    COSMOS_DB_CHAT_CONTAINER: 'ChatSessions',
    COSMOS_DB_AUTH_MODE: 'entra',
    COSMOS_DB_CHAT_SCHEMA_MODE: 'junior-compatible',
    COSMOS_DB_OWNER_ID: 'other:owner'
  });

  assert.deepEqual(resolved.status.sessions.invalid, ['COSMOS_DB_OWNER_ID']);
  assert.equal(resolved.status.sessions.ready, false);
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
  assert.equal(resolved.status.sessions.schemaMode, 'native');
  assert.equal(resolved.status.sessions.autoCreate, false);
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
