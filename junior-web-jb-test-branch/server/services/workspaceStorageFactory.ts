import path from 'node:path';
import type { WorkspaceSummary } from '../types.js';
import { CachedBlobWorkspaceStorage } from './cachedBlobWorkspaceStorage.js';
import { FallbackWorkspaceStorage } from './fallbackWorkspaceStorage.js';
import { LocalWorkspaceStorage } from './localWorkspaceStorage.js';
import { updatePersistenceMode } from './persistenceModeTracker.js';
import type { WorkspaceStorage } from './workspaceStorage.js';

export type WorkspaceStorageBackend = 'local' | 'blob';

export interface WorkspaceStorageFactoryOptions {
  backend?: WorkspaceStorageBackend;
  blobConnectionString?: string;
  blobServiceUrl?: string;
  blobContainerName?: string;
  blobPrefix?: string;
  blobCacheRoot?: string;
  blobTimeoutMs?: number;
}

export function createWorkspaceStorageFactory(options: WorkspaceStorageFactoryOptions = {}) {
  const backend = options.backend ?? ((process.env.JUNIOR_WORKSPACE_STORAGE_BACKEND?.trim().toLowerCase() === 'blob') ? 'blob' : 'local');

  return (workspace: WorkspaceSummary): WorkspaceStorage => {
    if (backend === 'blob') {
      const connectionString = options.blobConnectionString ?? process.env.AZURE_STORAGE_CONNECTION_STRING;
      const serviceUrl = options.blobServiceUrl ?? process.env.AZURE_STORAGE_BLOB_SERVICE_URL;
      const containerName = options.blobContainerName ?? process.env.JUNIOR_WORKSPACE_BLOB_CONTAINER ?? 'junior-workspaces';
      const prefix = options.blobPrefix ?? process.env.JUNIOR_WORKSPACE_BLOB_PREFIX ?? 'workspaces';
      const cacheBaseRoot = options.blobCacheRoot ?? process.env.JUNIOR_WORKSPACE_LOCAL_CACHE_ROOT;
      const timeoutMs = options.blobTimeoutMs ?? Number(process.env.JUNIOR_WORKSPACE_BLOB_TIMEOUT_MS ?? '5000');
      const fallbackStorage = new LocalWorkspaceStorage(workspace.rootPath);

      if (!connectionString?.trim() && !serviceUrl?.trim()) {
        throw new Error('AZURE_STORAGE_CONNECTION_STRING or AZURE_STORAGE_BLOB_SERVICE_URL is required when JUNIOR_WORKSPACE_STORAGE_BACKEND=blob.');
      }

      return new FallbackWorkspaceStorage(new CachedBlobWorkspaceStorage({
        connectionString,
        serviceUrl,
        containerName,
        workspaceId: workspace.id,
        prefix,
        cacheRootPath: cacheBaseRoot?.trim()
          ? path.join(cacheBaseRoot, workspace.ownerId, workspace.id)
          : workspace.rootPath
      }), fallbackStorage, { timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 5000 });
    }

    updatePersistenceMode({ scope: 'workspace-storage', configured: 'local', effective: 'local', fallbackActive: false });

    return new LocalWorkspaceStorage(workspace.rootPath);
  };
}