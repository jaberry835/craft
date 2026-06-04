import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import { LocalWorkspaceStorage } from '../services/localWorkspaceStorage.js';
import { PathIsDirectoryError } from '../httpErrors.js';

test('local workspace storage persists empty directories with a placeholder file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'junior-local-storage-'));
  const storage = new LocalWorkspaceStorage(root);

  try {
    await storage.createDirectory('notes');

    const tree = await storage.listTree();
    assert.deepEqual(tree.map((node) => ({ path: node.path, type: node.type })), [{ path: 'notes', type: 'directory' }]);

    const placeholder = await readFile(path.join(root, 'notes', '.keep'), 'utf8');
    assert.equal(placeholder, '');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('local workspace storage rejects reading a directory as a file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'junior-local-storage-'));
  const storage = new LocalWorkspaceStorage(root);

  try {
    await storage.createDirectory('notes');

    await assert.rejects(() => storage.readTextFile('notes'), (error: unknown) => {
      assert.ok(error instanceof PathIsDirectoryError);
      assert.match((error as Error).message, /notes/);
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});