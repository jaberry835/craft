import { BlobWorkspaceStorage, type BlobWorkspaceStorageOptions } from './blobWorkspaceStorage.js';
import { LocalWorkspaceStorage } from './localWorkspaceStorage.js';
import type { WorkspaceFile, WorkspaceTreeNode } from '../types.js';
import type { WorkspaceStorage } from './workspaceStorage.js';

export interface CachedBlobWorkspaceStorageOptions extends BlobWorkspaceStorageOptions {
  cacheRootPath: string;
}

export class CachedBlobWorkspaceStorage implements WorkspaceStorage {
  private readonly remoteStorage: BlobWorkspaceStorage;
  private readonly cacheStorage: LocalWorkspaceStorage;

  constructor(options: CachedBlobWorkspaceStorageOptions) {
    this.remoteStorage = new BlobWorkspaceStorage(options);
    this.cacheStorage = new LocalWorkspaceStorage(options.cacheRootPath);
  }

  async ensureSeedWorkspace(): Promise<void> {
    await this.remoteStorage.ensureSeedWorkspace();
  }

  async listTree(): Promise<WorkspaceTreeNode[]> {
    return this.remoteStorage.listTree();
  }

  async readTextFile(relativePath: string): Promise<WorkspaceFile> {
    const file = await this.remoteStorage.readTextFile(relativePath);
    await this.cacheStorage.writeTextFile(file.path, file.content);
    return file;
  }

  async writeTextFile(relativePath: string, content: string): Promise<WorkspaceFile> {
    const file = await this.remoteStorage.writeTextFile(relativePath, content);
    await this.cacheStorage.writeTextFile(file.path, file.content);
    return file;
  }

  async createDirectory(relativePath: string): Promise<WorkspaceTreeNode> {
    const directory = await this.remoteStorage.createDirectory(relativePath);
    await this.cacheStorage.createDirectory(relativePath);
    return directory;
  }

  async deletePath(relativePath: string): Promise<{ path: string; type: 'file' | 'directory' }> {
    const deleted = await this.remoteStorage.deletePath(relativePath);
    try {
      await this.cacheStorage.deletePath(relativePath);
    } catch {
      // Ignore cache misses; blob remains the source of truth.
    }
    return deleted;
  }

  async readMarkdownPackageFiles(): Promise<WorkspaceFile[]> {
    const files = await this.remoteStorage.readMarkdownPackageFiles();
    await Promise.all(files.map((file) => this.cacheStorage.writeTextFile(file.path, file.content)));
    return files;
  }

  getAbsoluteRoot(): string {
    return this.cacheStorage.getAbsoluteRoot();
  }
}