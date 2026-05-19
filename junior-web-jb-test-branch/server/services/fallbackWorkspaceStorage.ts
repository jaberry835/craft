import type { WorkspaceFile, WorkspaceTreeNode } from '../types.js';
import type { WorkspaceStorage } from './workspaceStorage.js';
import { updatePersistenceMode } from './persistenceModeTracker.js';

export interface FallbackWorkspaceStorageOptions {
  timeoutMs?: number;
}

export class FallbackWorkspaceStorage implements WorkspaceStorage {
  private degraded = false;
  private failureReason?: string;

  constructor(
    private readonly primary: WorkspaceStorage,
    private readonly fallback: WorkspaceStorage,
    private readonly options: FallbackWorkspaceStorageOptions = {}
  ) {
    this.report('blob', 'blob', false);
  }

  async ensureSeedWorkspace(): Promise<void> {
    await this.run(() => this.primary.ensureSeedWorkspace(), () => this.fallback.ensureSeedWorkspace());
  }

  async listTree(): Promise<WorkspaceTreeNode[]> {
    return this.run(() => this.primary.listTree(), () => this.fallback.listTree());
  }

  async readTextFile(relativePath: string): Promise<WorkspaceFile> {
    return this.run(() => this.primary.readTextFile(relativePath), () => this.fallback.readTextFile(relativePath));
  }

  async writeTextFile(relativePath: string, content: string): Promise<WorkspaceFile> {
    return this.run(() => this.primary.writeTextFile(relativePath, content), () => this.fallback.writeTextFile(relativePath, content));
  }

  async createDirectory(relativePath: string): Promise<WorkspaceTreeNode> {
    return this.run(() => this.primary.createDirectory(relativePath), () => this.fallback.createDirectory(relativePath));
  }

  async deletePath(relativePath: string): Promise<{ path: string; type: 'file' | 'directory' }> {
    return this.run(() => this.primary.deletePath(relativePath), () => this.fallback.deletePath(relativePath));
  }

  async readMarkdownPackageFiles(): Promise<WorkspaceFile[]> {
    return this.run(() => this.primary.readMarkdownPackageFiles(), () => this.fallback.readMarkdownPackageFiles());
  }

  getAbsoluteRoot(): string {
    return this.degraded ? this.fallback.getAbsoluteRoot() : this.primary.getAbsoluteRoot();
  }

  private async run<T>(primary: () => Promise<T>, fallback: () => Promise<T>): Promise<T> {
    if (this.degraded) {
      return fallback();
    }

    try {
      const primaryPromise = primary();
      if (!this.options.timeoutMs || this.options.timeoutMs <= 0) {
        return await primaryPromise;
      }

      return await Promise.race([
        primaryPromise,
        new Promise<T>((_resolve, reject) => {
          setTimeout(() => reject(new Error(`Blob storage timed out after ${this.options.timeoutMs}ms.`)), this.options.timeoutMs);
        })
      ]);
    } catch (error) {
      this.degraded = true;
      this.failureReason = error instanceof Error ? error.message : String(error);
      this.report('blob', 'local', true, this.failureReason);
      return fallback();
    }
  }

  private report(configured: 'blob', effective: 'blob' | 'local', fallbackActive: boolean, reason?: string): void {
    updatePersistenceMode({
      scope: 'workspace-storage',
      configured,
      effective,
      fallbackActive,
      reason
    });
  }
}
