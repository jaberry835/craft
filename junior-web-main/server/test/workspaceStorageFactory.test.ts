import assert from 'node:assert/strict';
import test from 'node:test';
import { FallbackWorkspaceStorage } from '../services/fallbackWorkspaceStorage.js';
import { LocalWorkspaceStorage } from '../services/localWorkspaceStorage.js';
import type { WorkspaceFile, WorkspaceTreeNode } from '../types.js';
import { createWorkspaceStorageFactory } from '../services/workspaceStorageFactory.js';

class RecordingStorage {
  readonly writes: string[] = [];

  constructor(
    private readonly options: {
      readError?: Error & { statusCode?: number; code?: string };
    } = {}
  ) {}

  async ensureSeedWorkspace(): Promise<void> {}

  async listTree(): Promise<WorkspaceTreeNode[]> {
    return [];
  }

  async readTextFile(relativePath: string): Promise<WorkspaceFile> {
    if (this.options.readError) {
      throw this.options.readError;
    }

    return {
      path: relativePath,
      content: 'primary',
      updatedAt: new Date().toISOString()
    };
  }

  async writeTextFile(relativePath: string, content: string): Promise<WorkspaceFile> {
    this.writes.push(`${relativePath}:${content}`);
    return {
      path: relativePath,
      content,
      updatedAt: new Date().toISOString()
    };
  }

  async createDirectory(relativePath: string): Promise<WorkspaceTreeNode> {
    return { name: relativePath, path: relativePath, type: 'directory' };
  }

  async deletePath(relativePath: string): Promise<{ path: string; type: 'file' | 'directory' }> {
    return { path: relativePath, type: 'file' };
  }

  async readMarkdownPackageFiles(): Promise<WorkspaceFile[]> {
    return [];
  }

  getAbsoluteRoot(): string {
    return '/tmp/fake';
  }
}

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

test('fallback storage does not permanently degrade after a missing-file read', async () => {
  const missingBlobError = Object.assign(new Error('Blob not found'), {
    statusCode: 404,
    code: 'BlobNotFound'
  });
  const primary = new RecordingStorage({ readError: missingBlobError });
  const fallback = new RecordingStorage();
  const storage = new FallbackWorkspaceStorage(primary, fallback);

  await assert.rejects(() => storage.readTextFile('.junior/workspace-config.json'), /Blob not found/);

  await storage.writeTextFile('uploads/blob-backed.md', 'saved remotely');

  assert.deepEqual(primary.writes, ['uploads/blob-backed.md:saved remotely']);
  assert.deepEqual(fallback.writes, []);
});

test('fallback storage degrades after non-missing primary errors', async () => {
  const primary = new RecordingStorage({ readError: new Error('Blob auth failed') });
  const fallback = new RecordingStorage();
  const storage = new FallbackWorkspaceStorage(primary, fallback);

  const file = await storage.readTextFile('package/index.md');

  assert.equal(file.path, 'package/index.md');
  assert.equal(file.content, 'primary');

  await storage.writeTextFile('uploads/local-fallback.md', 'saved locally');

  assert.deepEqual(primary.writes, []);
  assert.deepEqual(fallback.writes, ['uploads/local-fallback.md:saved locally']);
});