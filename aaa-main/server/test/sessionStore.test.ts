import assert from 'node:assert/strict';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { JsonSessionStore } from '../sessionStore.js';

const testRoot = path.join(process.cwd(), '.test-data', 'session-store');

test('sessions persist messages, generated titles, renames, and deletes as project-specific JSON', async () => {
  await rm(testRoot, { recursive: true, force: true });
  await mkdir(testRoot, { recursive: true });
  try {
    const store = new JsonSessionStore(testRoot, 'project-a');
    const created = await store.create();
    const appended = await store.append(created.id, {
      role: 'user',
      content: 'Assess access controls for this application'
    });
    assert.equal(appended.title, 'Assess access controls for this application');
    assert.equal(appended.messages[0]?.content, 'Assess access controls for this application');
    const withRun = await store.saveRun(created.id, {
      id: 'run-1',
      status: 'completed',
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:00:01.000Z',
      userMessageId: appended.messages[0]!.id,
      modelConnectionId: 'model',
      reasoning: 'Reviewed the request.',
      toolEvents: [],
      changedFiles: []
    });
    assert.equal(withRun.runs[0]?.status, 'completed');

    const restartedStore = new JsonSessionStore(testRoot, 'project-a');
    assert.deepEqual(await restartedStore.get(created.id), withRun);
    assert.equal((await restartedStore.list())[0]?.messageCount, 1);

    const persisted = JSON.parse(await readFile(
      path.join(testRoot, 'projects', 'project-a', 'sessions', `${created.id}.json`),
      'utf8'
    )) as { projectId: string };
    assert.equal(persisted.projectId, 'project-a');

    const renamed = await restartedStore.rename(created.id, 'Access control assessment');
    assert.equal(renamed.title, 'Access control assessment');
    await restartedStore.delete(created.id);
    assert.deepEqual(await restartedStore.list(), []);
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});

test('session ids cannot traverse outside project persistence', async () => {
  const store = new JsonSessionStore(testRoot, 'project-a');
  await assert.rejects(() => store.get('../../outside'), /Invalid session id/);
});
