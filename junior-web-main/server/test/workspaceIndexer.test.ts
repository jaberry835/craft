import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkspaceIndexer } from '../services/workspaceIndexer.js';
import type { WorkspaceFile, WorkspaceTreeNode } from '../types.js';

class StubStorage {
  constructor(
    private readonly files: Record<string, string>,
    private readonly missingPaths = new Set<string>()
  ) {}

  async ensureSeedWorkspace(): Promise<void> {}

  async listTree(): Promise<WorkspaceTreeNode[]> {
    return Object.keys(this.files)
      .filter((filePath) => !filePath.split('/').some((segment) => segment.startsWith('.')))
      .map((filePath) => ({
        name: filePath.split('/').at(-1) ?? filePath,
        path: filePath,
        type: 'file' as const
      }));
  }

  async readTextFile(relativePath: string): Promise<WorkspaceFile> {
    if (this.missingPaths.has(relativePath)) {
      throw Object.assign(new Error(`Blob not found: ${relativePath}`), {
        statusCode: 404,
        code: 'BlobNotFound'
      });
    }

    const content = this.files[relativePath];
    if (content === undefined) {
      throw Object.assign(new Error(`File not found: ${relativePath}`), {
        code: 'ENOENT'
      });
    }

    return {
      path: relativePath,
      content,
      updatedAt: new Date('2026-06-04T00:00:00.000Z').toISOString()
    };
  }

  async writeTextFile(relativePath: string, content: string): Promise<WorkspaceFile> {
    this.files[relativePath] = content;
    return {
      path: relativePath,
      content,
      updatedAt: new Date().toISOString()
    };
  }

  async createDirectory(relativePath: string): Promise<WorkspaceTreeNode> {
    return { name: relativePath, path: relativePath, type: 'directory' };
  }

  async deletePath(relativePath: string): Promise<{ path: string; type: 'file' | 'directory' }> {
    delete this.files[relativePath];
    return { path: relativePath, type: 'file' };
  }

  async readMarkdownPackageFiles(): Promise<WorkspaceFile[]> {
    return [];
  }

  getAbsoluteRoot(): string {
    return '/tmp/workspace';
  }
}

test('workspace indexer skips missing blob-backed files during refresh', async () => {
  const storage = new StubStorage({
    'README.md': '# Workspace\n',
    'notes/todo.md': 'keep me indexed\n'
  }, new Set(['README.md']));
  const indexer = new WorkspaceIndexer(storage);

  const index = await indexer.refresh();

  assert.equal(index.fileCount, 2);
  assert.equal(index.indexedFileCount, 1);
  assert.deepEqual(index.entries.map((entry) => entry.path), ['notes/todo.md']);
  assert.deepEqual(indexer.search('indexed').map((result) => result.path), ['notes/todo.md']);
});