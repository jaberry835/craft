import assert from 'node:assert/strict';
import test from 'node:test';
import { FallbackWorkspaceStorage } from '../services/fallbackWorkspaceStorage.js';
import { LocalWorkspaceStorage } from '../services/localWorkspaceStorage.js';
import { createWorkspaceStorageFactory } from '../services/workspaceStorageFactory.js';

const sampleWorkspace = {
  id: 'demo-workspace',
  name: 'Demo Workspace',
  ownerId: 'admin',
  rootPath: '/tmp/demo-workspace'
};

test('workspace storage factory defaults to local storage', () => {
  const createStorage = createWorkspaceStorageFactory({ backend: 'local' });
  const storage = createStorage(sampleWorkspace);

  assert.ok(storage instanceof LocalWorkspaceStorage);
});

test('workspace storage factory creates blob storage when configured', () => {
  const createStorage = createWorkspaceStorageFactory({
    backend: 'blob',
    blobConnectionString: 'UseDevelopmentStorage=true',
    blobContainerName: 'junior-workspaces',
    blobPrefix: 'workspaces'
  });
  const storage = createStorage(sampleWorkspace);

  assert.ok(storage instanceof FallbackWorkspaceStorage);
  assert.equal(storage.getAbsoluteRoot(), '/tmp/demo-workspace');
});

test('workspace storage factory creates blob storage with service URL auth', () => {
  const createStorage = createWorkspaceStorageFactory({
    backend: 'blob',
    blobServiceUrl: 'https://juniorstorage.blob.core.windows.net',
    blobContainerName: 'junior-workspaces',
    blobPrefix: 'workspaces'
  });
  const storage = createStorage(sampleWorkspace);

  assert.ok(storage instanceof FallbackWorkspaceStorage);
  assert.equal(storage.getAbsoluteRoot(), '/tmp/demo-workspace');
});

test('workspace storage factory uses explicit local cache root for blob storage', () => {
  const createStorage = createWorkspaceStorageFactory({
    backend: 'blob',
    blobConnectionString: 'UseDevelopmentStorage=true',
    blobContainerName: 'junior-workspaces',
    blobPrefix: 'workspaces',
    blobCacheRoot: '/tmp/junior-cache'
  });
  const storage = createStorage(sampleWorkspace);

  assert.equal(storage.getAbsoluteRoot(), '/tmp/junior-cache/admin/demo-workspace');
});

test('workspace storage factory rejects blob mode without blob credentials', () => {
  const createStorage = createWorkspaceStorageFactory({
    backend: 'blob',
    blobContainerName: 'junior-workspaces',
    blobPrefix: 'workspaces'
  });

  assert.throws(() => createStorage(sampleWorkspace), /AZURE_STORAGE_CONNECTION_STRING or AZURE_STORAGE_BLOB_SERVICE_URL is required/);
});