import path from 'node:path';
import type { WorkspaceCreateRequest, WorkspaceSummary, WorkspaceUpdateRequest } from '../types.js';
import { LocalWorkspaceMetadataStore } from './localWorkspaceMetadataStore.js';
import type { WorkspaceMetadataStore } from './workspaceMetadataStore.js';
import { WorkspaceRegistry, type WorkspaceRuntime } from './workspaceRegistry.js';

const defaultOwnerId = 'admin';

export type WorkspaceRuntimeFactory = (workspace: WorkspaceSummary) => Promise<WorkspaceRuntime>;

export class LocalWorkspaceManager {
  private registry?: WorkspaceRegistry;

  constructor(
    private readonly workspacesRoot: string,
    private readonly runtimeFactory: WorkspaceRuntimeFactory,
    private readonly metadataStore: WorkspaceMetadataStore = new LocalWorkspaceMetadataStore(workspacesRoot)
  ) {}

  async load(): Promise<void> {
    const catalog = await this.loadCatalog();
    const runtimes = await Promise.all(catalog.items.map((workspace) => this.runtimeFactory(workspace)));
    this.registry = new WorkspaceRegistry(runtimes, catalog.defaultWorkspaceId);
  }

  list(ownerId = defaultOwnerId): WorkspaceSummary[] {
    return this.getRegistry().list(ownerId);
  }

  getDefault(ownerId = defaultOwnerId): WorkspaceRuntime {
    return this.getRegistry().getDefault(ownerId);
  }

  resolve(ownerId = defaultOwnerId, workspaceId?: string): WorkspaceRuntime {
    return this.getRegistry().resolve(ownerId, workspaceId);
  }

  async createWorkspace(request: WorkspaceCreateRequest, ownerId = defaultOwnerId): Promise<WorkspaceSummary> {
    const name = request.name.trim();
    if (!name) {
      throw new Error('Workspace name is required.');
    }

    const catalog = await this.loadCatalog();
    const id = this.uniqueId(this.slugify(name), catalog.items.map((workspace) => workspace.id));
    const summary: WorkspaceSummary = {
      id,
      name,
      description: request.description?.trim() || undefined,
      ownerId,
      rootPath: path.join(this.workspacesRoot, id),
      templateId: request.templateId?.trim() || undefined,
      templateName: request.templateName?.trim() || undefined
    };

    const runtime = await this.runtimeFactory(summary);
    const nextCatalog = {
      ...catalog,
      items: [...catalog.items, summary]
    };

    await this.metadataStore.writeCatalog(nextCatalog);
    this.getRegistry().register(runtime);
    return summary;
  }

  async updateWorkspace(workspaceId: string, request: WorkspaceUpdateRequest, ownerId = defaultOwnerId): Promise<WorkspaceSummary> {
    const registry = this.getRegistry();
    const currentRuntime = registry.get(workspaceId, ownerId);
    const catalog = await this.loadCatalog();
    const itemIndex = catalog.items.findIndex((workspace) => workspace.id === workspaceId && workspace.ownerId === ownerId);

    if (itemIndex === -1) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }

    const current = catalog.items[itemIndex];
    const next: WorkspaceSummary = {
      ...current,
      name: request.name?.trim() || current.name,
      description: request.description === undefined ? current.description : request.description.trim() || undefined,
      templateId: request.templateId === undefined ? current.templateId : request.templateId.trim() || undefined,
      templateName: request.templateName === undefined ? current.templateName : request.templateName.trim() || undefined
    };

    catalog.items[itemIndex] = next;
    await this.metadataStore.writeCatalog(catalog);
    currentRuntime.name = next.name;
    currentRuntime.description = next.description;
    currentRuntime.templateId = next.templateId;
    currentRuntime.templateName = next.templateName;
    registry.register(currentRuntime);
    return next;
  }

  private async loadCatalog() {
    const existing = await this.metadataStore.readCatalog();
    if (existing) {
      return this.normalizeCatalog(existing);
    }

    const defaultWorkspace: WorkspaceSummary = {
      id: 'default',
      name: 'Default Workspace',
      description: 'Local development workspace',
      ownerId: defaultOwnerId,
      rootPath: path.join(this.workspacesRoot, 'default')
    };
    const catalog = {
      defaultWorkspaceId: defaultWorkspace.id,
      items: [defaultWorkspace]
    };
    await this.metadataStore.writeCatalog(catalog);
    return catalog;
  }

  private normalizeCatalog(catalog: import('./workspaceMetadataStore.js').WorkspaceCatalog) {
    return {
      ...catalog,
      items: catalog.items.map((workspace) => ({
        ...workspace,
        ownerId: workspace.ownerId || defaultOwnerId
      }))
    };
  }

  private getRegistry(): WorkspaceRegistry {
    if (!this.registry) {
      throw new Error('Workspace manager has not been loaded.');
    }

    return this.registry;
  }

  private slugify(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace';
  }

  private uniqueId(baseId: string, existingIds: string[]): string {
    if (!existingIds.includes(baseId)) {
      return baseId;
    }

    let index = 2;
    while (existingIds.includes(`${baseId}-${index}`)) {
      index += 1;
    }

    return `${baseId}-${index}`;
  }
}