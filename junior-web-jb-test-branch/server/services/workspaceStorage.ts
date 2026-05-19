import type { WorkspaceFile, WorkspaceTreeNode } from '../types.js';

export interface WorkspaceStorage {
  ensureSeedWorkspace(): Promise<void>;
  listTree(): Promise<WorkspaceTreeNode[]>;
  readTextFile(relativePath: string): Promise<WorkspaceFile>;
  writeTextFile(relativePath: string, content: string): Promise<WorkspaceFile>;
  createDirectory(relativePath: string): Promise<WorkspaceTreeNode>;
  deletePath(relativePath: string): Promise<{ path: string; type: 'file' | 'directory' }>;
  readMarkdownPackageFiles(): Promise<WorkspaceFile[]>;
  getAbsoluteRoot(): string;
}