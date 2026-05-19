import assert from 'node:assert/strict';
import test from 'node:test';
import { FallbackWorkspaceMetadataStore } from '../services/fallbackWorkspaceMetadataStore.js';
import { LocalWorkspaceMetadataStore } from '../services/localWorkspaceMetadataStore.js';
import { createWorkspaceMetadataStore } from '../services/persistenceFactories.js';

test('workspace metadata store factory defaults to local storage', () => {
  const store = createWorkspaceMetadataStore('/tmp/workspaces');
  assert.ok(store instanceof LocalWorkspaceMetadataStore);
});

test('workspace metadata store factory wraps Cosmos storage with a local fallback when configured', () => {
  process.env.COSMOS_DB_ENDPOINT = 'https://example.documents.azure.com:443/';
  process.env.COSMOS_DB_DATABASE = 'JuniorWeb';
  process.env.COSMOS_DB_WORKSPACE_CONTAINER = 'Workspaces';

  try {
    const store = createWorkspaceMetadataStore('/tmp/workspaces');
    assert.ok(store instanceof FallbackWorkspaceMetadataStore);
  } finally {
    delete process.env.COSMOS_DB_ENDPOINT;
    delete process.env.COSMOS_DB_DATABASE;
    delete process.env.COSMOS_DB_WORKSPACE_CONTAINER;
  }
});