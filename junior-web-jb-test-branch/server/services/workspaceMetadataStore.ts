import type { WorkspaceSummary } from '../types.js';

export interface WorkspaceCatalog {
  defaultWorkspaceId: string;
  items: WorkspaceSummary[];
}

export interface WorkspaceMetadataStore {
  readCatalog(): Promise<WorkspaceCatalog | undefined>;
  writeCatalog(catalog: WorkspaceCatalog): Promise<void>;
}