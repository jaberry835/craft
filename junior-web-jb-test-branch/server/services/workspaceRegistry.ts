import type { WorkspaceSummary } from '../types.js';
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
  private readonly defaultWorkspaceId: string;

  constructor(workspaces: WorkspaceRuntime[], defaultWorkspaceId?: string) {
    for (const workspace of workspaces) {
      this.workspaces.set(workspace.id, workspace);
    }

    const fallbackWorkspaceId = workspaces[0]?.id;
    this.defaultWorkspaceId = defaultWorkspaceId ?? fallbackWorkspaceId ?? '';

    if (!this.defaultWorkspaceId || !this.workspaces.has(this.defaultWorkspaceId)) {
      throw new Error('Workspace registry requires at least one valid default workspace.');
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
  }

  getDefault(ownerId: string): WorkspaceRuntime {
    const defaultWorkspace = this.workspaces.get(this.defaultWorkspaceId);

    if (defaultWorkspace?.ownerId === ownerId) {
      return defaultWorkspace;
    }

    const fallbackWorkspace = this.listOwned(ownerId)[0];
    if (!fallbackWorkspace) {
      throw new Error(`No workspace is available for owner: ${ownerId}`);
    }

    return fallbackWorkspace;
  }

  get(workspaceId: string, ownerId: string): WorkspaceRuntime {
    const workspace = this.workspaces.get(workspaceId);

    if (!workspace || workspace.ownerId !== ownerId) {
      throw new Error(`Workspace not found: ${workspaceId}`);
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