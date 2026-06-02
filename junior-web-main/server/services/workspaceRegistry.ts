import type { WorkspaceSummary } from '../types.js';
import { AuthorizationError, NotFoundError } from '../httpErrors.js';
import type { ChangeManager } from './changeManager.js';
import type { SimpleJuniorAgent } from './simpleJuniorAgent.js';
import type { WorkspaceConfigStore } from './workspaceConfigStore.js';
import type { WorkspaceIndexer } from './workspaceIndexer.js';
import type { WorkspaceStorage } from './workspaceStorage.js';

export interface WorkspaceRuntime extends WorkspaceSummary {
  storage: WorkspaceStorage;
  configStore: WorkspaceConfigStore;
  workspaceIndexer: WorkspaceIndexer;
  changeManager: ChangeManager;
  agent: SimpleJuniorAgent;
}

export class WorkspaceRegistry {
  private readonly workspaces = new Map<string, WorkspaceRuntime>();
  private readonly defaultWorkspaceIdsByOwner = new Map<string, string>();

  constructor(workspaces: WorkspaceRuntime[], defaultWorkspaceIdsByOwner: Record<string, string> = {}) {
    for (const workspace of workspaces) {
      this.workspaces.set(workspace.id, workspace);
    }

    for (const [ownerId, workspaceId] of Object.entries(defaultWorkspaceIdsByOwner)) {
      this.defaultWorkspaceIdsByOwner.set(ownerId, workspaceId);
    }

    if (this.workspaces.size === 0) {
      throw new Error('Workspace registry requires at least one workspace runtime.');
    }
  }

  list(ownerId: string): WorkspaceSummary[] {
    return this.listOwned(ownerId).map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      description: workspace.description,
      ownerId: workspace.ownerId,
      rootPath: workspace.rootPath,
      templateId: workspace.templateId,
      templateName: workspace.templateName
    }));
  }

  register(workspace: WorkspaceRuntime): void {
    this.workspaces.set(workspace.id, workspace);
    if (!this.defaultWorkspaceIdsByOwner.has(workspace.ownerId)) {
      this.defaultWorkspaceIdsByOwner.set(workspace.ownerId, workspace.id);
    }
  }

  setOwnerDefault(ownerId: string, workspaceId: string): void {
    this.defaultWorkspaceIdsByOwner.set(ownerId, workspaceId);
  }

  getDefault(ownerId: string): WorkspaceRuntime {
    const defaultWorkspaceId = this.defaultWorkspaceIdsByOwner.get(ownerId);
    const defaultWorkspace = defaultWorkspaceId ? this.workspaces.get(defaultWorkspaceId) : undefined;

    if (defaultWorkspace?.ownerId === ownerId) {
      return defaultWorkspace;
    }

    const fallbackWorkspace = this.listOwned(ownerId)[0];
    if (!fallbackWorkspace) {
      throw new NotFoundError(`No workspace is available for owner: ${ownerId}`);
    }

    return fallbackWorkspace;
  }

  get(workspaceId: string, ownerId: string): WorkspaceRuntime {
    const workspace = this.workspaces.get(workspaceId);

    if (!workspace) {
      throw new NotFoundError(`Workspace not found: ${workspaceId}`);
    }

    if (workspace.ownerId !== ownerId) {
      throw new AuthorizationError(`You do not have access to workspace: ${workspaceId}`);
    }

    return workspace;
  }

  resolve(ownerId: string, workspaceId?: string): WorkspaceRuntime {
    if (!workspaceId || workspaceId === 'current') {
      return this.getDefault(ownerId);
    }

    return this.get(workspaceId, ownerId);
  }

  private listOwned(ownerId: string): WorkspaceRuntime[] {
    return Array.from(this.workspaces.values()).filter((workspace) => workspace.ownerId === ownerId);
  }
}