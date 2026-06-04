import assert from 'node:assert/strict';
import test from 'node:test';
import { BlobWorkspaceStorage } from '../services/blobWorkspaceStorage.js';
import type { WorkspaceTreeNode } from '../types.js';

test('blob workspace storage treats placeholder leaf paths as directories', () => {
  const storage = new BlobWorkspaceStorage({
    connectionString: 'UseDevelopmentStorage=true',
    containerName: 'junior-workspaces',
    workspaceId: 'default',
    prefix: 'workspaces'
  });

  const roots: WorkspaceTreeNode[] = [];
  const insertNode = (storage as unknown as {
    insertNode: (nodes: WorkspaceTreeNode[], relativePath: string, forceLeafDirectory?: boolean) => void;
  }).insertNode;

  insertNode(roots, 'notes', true);

  assert.equal(roots.length, 1);
  assert.equal(roots[0]?.path, 'notes');
  assert.equal(roots[0]?.type, 'directory');
  assert.deepEqual(roots[0]?.children ?? [], []);
});