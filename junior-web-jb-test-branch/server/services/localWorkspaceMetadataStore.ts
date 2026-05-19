import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { WorkspaceCatalog, WorkspaceMetadataStore } from './workspaceMetadataStore.js';

export class LocalWorkspaceMetadataStore implements WorkspaceMetadataStore {
  private readonly catalogPath: string;

  constructor(private readonly workspacesRoot: string) {
    this.catalogPath = path.join(this.workspacesRoot, 'catalog.json');
  }

  async readCatalog(): Promise<WorkspaceCatalog | undefined> {
    await mkdir(this.workspacesRoot, { recursive: true });

    try {
      const raw = await readFile(this.catalogPath, 'utf8');
      return JSON.parse(raw) as WorkspaceCatalog;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return undefined;
      }

      throw error;
    }
  }

  async writeCatalog(catalog: WorkspaceCatalog): Promise<void> {
    await mkdir(this.workspacesRoot, { recursive: true });
    await writeFile(this.catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
  }
}