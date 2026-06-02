import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { LocalWorkspaceMetadataStore } from '../services/localWorkspaceMetadataStore.js';

test('local workspace metadata store keeps catalogs per owner', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'junior-workspace-metadata-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const store = new LocalWorkspaceMetadataStore(root);

  await store.writeCatalog('alice', {
    defaultWorkspaceId: 'alice-default',
    items: [{
      id: 'alice-default',
      name: 'Alice Workspace',
      ownerId: 'alice',
      rootPath: path.join(root, 'alice-default')
    }]
  });

  await store.writeCatalog('bob', {
    defaultWorkspaceId: 'bob-default',
    items: [{
      id: 'bob-default',
      name: 'Bob Workspace',
      ownerId: 'bob',
      rootPath: path.join(root, 'bob-default')
    }]
  });

  const aliceCatalog = await store.readCatalog('alice');
  const bobCatalog = await store.readCatalog('bob');
  const catalogs = await store.listCatalogs();

  assert.equal(aliceCatalog?.items.length, 1);
  assert.equal(aliceCatalog?.items[0]?.ownerId, 'alice');
  assert.equal(bobCatalog?.items.length, 1);
  assert.equal(bobCatalog?.items[0]?.ownerId, 'bob');
  assert.equal(catalogs.length, 2);
  assert.deepEqual(catalogs.map((entry) => entry.ownerId).sort(), ['alice', 'bob']);
});