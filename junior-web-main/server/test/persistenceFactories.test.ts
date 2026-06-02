import assert from 'node:assert/strict';
import test from 'node:test';
import { FallbackChatSessionStore } from '../services/fallbackChatSessionStore.js';
import { FallbackPendingChangeStore } from '../services/fallbackPendingChangeStore.js';
import { FallbackWorkspaceMetadataStore } from '../services/fallbackWorkspaceMetadataStore.js';
import { FallbackWorkspaceSecretStore } from '../services/fallbackWorkspaceSecretStore.js';
import { FallbackWorkspaceStateStore } from '../services/fallbackWorkspaceStateStore.js';
import { InMemoryPendingChangeStore } from '../services/inMemoryPendingChangeStore.js';
import { LocalChatSessionStore } from '../services/localChatSessionStore.js';
import { LocalWorkspaceMetadataStore } from '../services/localWorkspaceMetadataStore.js';
import { LocalWorkspaceSecretStore } from '../services/localWorkspaceSecretStore.js';
import { LocalWorkspaceStateStore } from '../services/localWorkspaceStateStore.js';
import { LocalWorkspaceStorage } from '../services/localWorkspaceStorage.js';
import { createChatSessionStore, createPendingChangeStore, createWorkspaceMetadataStore, createWorkspaceSecretStore, createWorkspaceStateStore } from '../services/persistenceFactories.js';

const sampleWorkspace = {
  id: 'demo-workspace',
  name: 'Demo Workspace',
  ownerId: 'admin',
  rootPath: '/tmp/demo-workspace'
};

function withCosmosEnv(run: () => void): void {
  process.env.COSMOS_DB_ENDPOINT = 'https://example.documents.azure.com:443/';
  process.env.COSMOS_DB_DATABASE = 'JuniorWeb';
  process.env.COSMOS_DB_WORKSPACE_CONTAINER = 'Workspaces';
  process.env.COSMOS_DB_CHAT_CONTAINER = 'ChatSessions';
  process.env.COSMOS_DB_PENDING_CHANGE_CONTAINER = 'PendingChanges';
  process.env.COSMOS_DB_WORKSPACE_CONFIG_CONTAINER = 'WorkspaceConfig';
  process.env.AZURE_KEY_VAULT_URL = 'https://junior-test-kv.vault.azure.net/';

  try {
    run();
  } finally {
    delete process.env.COSMOS_DB_ENDPOINT;
    delete process.env.COSMOS_DB_DATABASE;
    delete process.env.COSMOS_DB_WORKSPACE_CONTAINER;
    delete process.env.COSMOS_DB_CHAT_CONTAINER;
    delete process.env.COSMOS_DB_PENDING_CHANGE_CONTAINER;
    delete process.env.COSMOS_DB_WORKSPACE_CONFIG_CONTAINER;
    delete process.env.AZURE_KEY_VAULT_URL;
  }
}

test('persistence factories default to local metadata and session storage with in-memory pending changes', () => {
  const storage = new LocalWorkspaceStorage(sampleWorkspace.rootPath);
  const metadataStore = createWorkspaceMetadataStore('/tmp/workspaces');
  const chatStore = createChatSessionStore(sampleWorkspace);
  const pendingStore = createPendingChangeStore(sampleWorkspace);
  const workspaceStateStore = createWorkspaceStateStore(sampleWorkspace, storage);
  const workspaceSecretStore = createWorkspaceSecretStore(sampleWorkspace);

  assert.ok(metadataStore instanceof LocalWorkspaceMetadataStore);
  assert.ok(chatStore instanceof LocalChatSessionStore);
  assert.ok(pendingStore instanceof InMemoryPendingChangeStore);
  assert.ok(workspaceStateStore instanceof LocalWorkspaceStateStore);
  assert.ok(workspaceSecretStore instanceof LocalWorkspaceSecretStore);
});

test('persistence factories wrap Cosmos-backed stores with local fallbacks when Cosmos is configured', () => {
  withCosmosEnv(() => {
    const storage = new LocalWorkspaceStorage(sampleWorkspace.rootPath);
    const metadataStore = createWorkspaceMetadataStore('/tmp/workspaces');
    const chatStore = createChatSessionStore(sampleWorkspace);
    const pendingStore = createPendingChangeStore(sampleWorkspace);
    const workspaceStateStore = createWorkspaceStateStore(sampleWorkspace, storage);
    const workspaceSecretStore = createWorkspaceSecretStore(sampleWorkspace);

    assert.ok(metadataStore instanceof FallbackWorkspaceMetadataStore);
    assert.ok(chatStore instanceof FallbackChatSessionStore);
    assert.ok(pendingStore instanceof FallbackPendingChangeStore);
    assert.ok(workspaceStateStore instanceof FallbackWorkspaceStateStore);
    assert.ok(workspaceSecretStore instanceof FallbackWorkspaceSecretStore);
  });
});