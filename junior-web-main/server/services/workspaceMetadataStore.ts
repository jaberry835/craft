import type { WorkspaceSummary } from '../types.js';

export interface WorkspaceCatalog {
  defaultWorkspaceId: string;
  items: WorkspaceSummary[];
}

export interface OwnedWorkspaceCatalog {
  ownerId: string;
  catalog: WorkspaceCatalog;
}

export interface WorkspaceMetadataStore {
  readCatalog(ownerId: string): Promise<WorkspaceCatalog | undefined>;
  writeCatalog(ownerId: string, catalog: WorkspaceCatalog): Promise<void>;
  listCatalogs(): Promise<OwnedWorkspaceCatalog[]>;
}