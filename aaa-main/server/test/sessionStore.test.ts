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

test('concurrent updates through separate per-request store instances are serialized', async () => {
  const root = `${testRoot}-instances`;
  await rm(root, { recursive: true, force: true });
  try {
    const session = await new JsonSessionStore(root, 'project-a').create();
    const messages = Array.from({ length: 12 }, (_, index) => `Message ${index + 1}`);
    // The API creates a new store for every request, so the lock must be shared across instances.
    await Promise.all(messages.map((content) =>
      new JsonSessionStore(root, 'project-a').append(session.id, { role: 'user', content })));

    const stored = await new JsonSessionStore(root, 'project-a').get(session.id);
    assert.equal(stored.messageCount, messages.length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('append saves its run in the same write and completed runs are stored without duplicated output', async () => {
  const root = `${testRoot}-runs`;
  await rm(root, { recursive: true, force: true });
  try {
    const store = new JsonSessionStore(root, 'project-a');
    const session = await store.create();
    const event = { id: 'e1', type: 'read' as const, label: 'Read project file', createdAt: '2026-01-01T00:00:00.000Z' };
    const afterUser = await store.append(session.id, { role: 'user', content: 'Assess' }, (message) => ({
      id: 'run-1',
      status: 'running',
      startedAt: '2026-01-01T00:00:00.000Z',
      userMessageId: message.id,
      modelConnectionId: 'model',
      reasoning: '',
      toolEvents: [],
      changedFiles: []
    }));
    assert.equal(afterUser.runs[0]?.userMessageId, afterUser.messages[0]?.id);

    const afterAssistant = await store.append(session.id, {
      role: 'assistant',
      content: 'Done.',
      display: [{ kind: 'reasoning', text: 'Thinking' }, { kind: 'working', title: 'Agent steps', events: [event] }]
    }, (message) => ({
      ...afterUser.runs[0]!,
      status: 'completed',
      assistantMessageId: message.id,
      reasoning: 'Thinking',
      toolEvents: [event],
      changedFiles: ['a.md'],
      assistantText: 'Done.'
    }));
    assert.equal(afterAssistant.runs.length, 1);
    const run = afterAssistant.runs[0]!;
    assert.equal(run.assistantMessageId, afterAssistant.messages[1]?.id);
    assert.equal(run.reasoning, '');
    assert.deepEqual(run.toolEvents, []);
    assert.equal('assistantText' in run, false);
    assert.deepEqual(run.changedFiles, ['a.md']);
    assert.deepEqual(afterAssistant.messages[1]?.display?.[1], { kind: 'working', title: 'Agent steps', events: [event] });

    const raw = await readFile(path.join(root, 'projects', 'project-a', 'sessions', `${session.id}.json`), 'utf8');
    assert.equal(raw.trimEnd().includes('\n'), false, 'sessions are stored as compact JSON');
    assert.deepEqual(await store.get(session.id), afterAssistant);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('session summaries are cached but always reflect the latest write', async () => {
  const root = `${testRoot}-summaries`;
  await rm(root, { recursive: true, force: true });
  try {
    const first = new JsonSessionStore(root, 'project-a');
    const session = await first.create();
    assert.equal((await first.list())[0]?.title, 'New session');
    await new JsonSessionStore(root, 'project-a').rename(session.id, 'Renamed elsewhere');
    await new JsonSessionStore(root, 'project-a').append(session.id, { role: 'user', content: 'Hello' });
    const [summary] = await first.list();
    assert.equal(summary?.title, 'Renamed elsewhere');
    assert.equal(summary?.messageCount, 1);
    assert.equal('messages' in (summary ?? {}), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('concurrent session updates are serialized without losing messages', async () => {
  const root = `${testRoot}-concurrent`;
  await rm(root, { recursive: true, force: true });
  const store = new JsonSessionStore(root, 'project-a');
  try {
    const session = await store.create();
    const messages = Array.from({ length: 12 }, (_, index) => `Message ${index + 1}`);
    await Promise.all(messages.map((content) => store.append(session.id, { role: 'user', content })));

    const stored = await store.get(session.id);
    assert.equal(stored.messageCount, messages.length);
    assert.deepEqual(stored.messages.map((message) => message.content).sort(), messages.sort());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
