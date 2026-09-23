import type { Container, PartitionKey } from '@azure/cosmos';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import type { ChatSession } from '../../src/types/api.js';
import { createAaaApp } from '../app.js';
import { CosmosChatSessionStore } from '../cosmosChatSessionStore.js';
import {
  CosmosSchemaMismatchError,
  type CosmosContainerBinding
} from '../cosmosContainerFactory.js';
import type { ProjectRegistry } from '../projectRegistry.js';

interface StoredDocument extends ChatSession {
  ownerId?: string;
  workspaceId?: string;
  partitionKey?: string;
  type: 'chatSession';
}

function partitionName(partitionKey: PartitionKey | undefined): string {
  return typeof partitionKey === 'string' ? partitionKey : '<none>';
}

function createMockBinding() {
  const documents = new Map<string, StoredDocument>();
  const queryPartitions: string[] = [];
  const itemPartitions: string[] = [];
  const container = {
    items: {
      query: (
        querySpec: { parameters?: Array<{ name: string; value: unknown }> },
        options: { partitionKey?: PartitionKey }
      ) => {
        const partition = partitionName(options.partitionKey);
        queryPartitions.push(partition);
        const parameters = Object.fromEntries(
          (querySpec.parameters ?? []).map(({ name, value }) => [name, value])
        );
        return {
          fetchAll: async () => ({
            resources: [...documents.entries()]
              .filter(([key]) => key.startsWith(`${partition}:`))
              .map(([, document]) => document)
              .filter((document) =>
                (!parameters['@projectId'] || document.projectId === parameters['@projectId'])
                && (!parameters['@ownerId'] || document.ownerId === parameters['@ownerId'])
                && (!parameters['@partitionKey']
                  || document.partitionKey === parameters['@partitionKey'])
                && (!parameters['@type'] || document.type === parameters['@type'])
                && (partition !== '<none>' || document.partitionKey === undefined))
              .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
          })
        };
      },
      upsert: async (document: StoredDocument) => {
        const partition = document.partitionKey ?? document.projectId;
        documents.set(`${partition}:${document.id}`, structuredClone(document));
        return { resource: document };
      }
    },
    item: (id: string, partitionKey?: PartitionKey) => {
      const partition = partitionName(partitionKey);
      itemPartitions.push(partition);
      return {
        read: async () => {
          const resource = documents.get(`${partition}:${id}`);
          if (!resource) {
            throw Object.assign(new Error('missing'), { code: 404 });
          }
          return { resource: structuredClone(resource) };
        },
        delete: async () => {
          if (!documents.delete(`${partition}:${id}`)) {
            throw Object.assign(new Error('missing'), { code: 404 });
          }
          return {};
        }
      };
    }
  } as unknown as Container;
  const binding: CosmosContainerBinding = {
    container,
    settings: {
      endpointHost: 'safe-account.documents.azure.com',
      database: 'Aaa',
      container: 'ChatSessions',
      authMode: 'entra',
      keyConfigured: false,
      schemaMode: 'native',
      autoCreate: false
    }
  };
  return { binding, documents, queryPartitions, itemPartitions };
}

function assertCompatibilityFieldsArePrivate(value: object): void {
  assert.equal('ownerId' in value, false);
  assert.equal('workspaceId' in value, false);
  assert.equal('partitionKey' in value, false);
  assert.equal('type' in value, false);
}

test('native Cosmos session CRUD uses clean projectId partition semantics and document shape', async () => {
  const mock = createMockBinding();
  const store = new CosmosChatSessionStore(mock.binding, 'project-a');
  const created = await store.create();
  const appended = await store.append(created.id, {
    role: 'user',
    content: 'Assess privileged access'
  });

  assert.equal(appended.title, 'Assess privileged access');
  assert.equal(appended.messageCount, 1);
  const withRun = await store.saveRun(created.id, {
    id: 'run-1',
    status: 'running',
    startedAt: '2026-01-01T00:00:00.000Z',
    userMessageId: appended.messages[0]!.id,
    modelConnectionId: 'model',
    reasoning: '',
    toolEvents: [],
    changedFiles: []
  });
  assert.equal(withRun.runs[0]?.status, 'running');
  const document = mock.documents.get(`project-a:${created.id}`);
  assert.equal(document?.type, 'chatSession');
  assert.equal(document?.projectId, 'project-a');
  assert.equal(document?.workspaceId, undefined);
  assert.equal(document?.ownerId, undefined);
  assert.equal(document?.partitionKey, undefined);
  assertCompatibilityFieldsArePrivate(created);
  assertCompatibilityFieldsArePrivate(appended);

  assert.deepEqual((await store.list()).map((session) => session.id), [created.id]);
  assert.deepEqual(mock.queryPartitions, ['project-a']);
  const fetched = await store.get(created.id);
  assert.equal(fetched.messages[0]?.content, 'Assess privileged access');
  assert.equal(fetched.runs[0]?.id, 'run-1');
  assertCompatibilityFieldsArePrivate(fetched);

  const renamed = await store.rename(created.id, 'Privileged access assessment');
  assert.equal(renamed.title, 'Privileged access assessment');
  await store.delete(created.id);
  assert.deepEqual(await store.list(), []);
  assert.ok(mock.itemPartitions.every((partition) => partition === 'project-a'));
});

test('session API responses omit Cosmos compatibility fields', async (t) => {
  const mock = createMockBinding();
  const store = new CosmosChatSessionStore(mock.binding, 'project-a');
  const registry = {
    assertProjectId: (projectId: string) => assert.equal(projectId, 'project-a'),
    get: () => ({
      id: 'project-a',
      name: 'Project A',
      rootPath: 'C:\\project-a',
      active: true
    })
  } as unknown as ProjectRegistry;
  const storageStatus = {
    sessions: {
      backend: 'cosmos' as const,
      configured: true,
      ready: true,
      active: true,
      missing: [],
      invalid: []
    },
    workspaceFiles: {
      backend: 'local' as const,
      configured: true,
      ready: true,
      active: true,
      missing: [],
      invalid: []
    }
  };
  const server = createServer(createAaaApp({
    registry,
    dataRoot: 'C:\\unused',
    sessionStoreFactory: () => store,
    storageStatus
  }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  const response = await fetch(
    `http://127.0.0.1:${address.port}/api/projects/project-a/sessions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    }
  );
  assert.equal(response.status, 201);
  assertCompatibilityFieldsArePrivate(await response.json() as object);
});

test('native Cosmos session access is isolated by project', async () => {
  const mock = createMockBinding();
  const store = new CosmosChatSessionStore(mock.binding, 'project-a');
  const created = await store.create();
  const otherProject = new CosmosChatSessionStore(mock.binding, 'project-b');

  await assert.rejects(() => otherProject.get(created.id), /Session was not found/);
  assert.deepEqual(await otherProject.list(), []);
  assert.equal(mock.documents.has(`project-a:${created.id}`), true);
});

test('Junior-compatible mode is explicit and isolated by owner and project', async () => {
  const mock = createMockBinding();
  const store = new CosmosChatSessionStore(
    mock.binding,
    'project-a',
    'junior-compatible',
    'aaa'
  );
  const created = await store.create();
  const document = mock.documents.get(`aaa:project-a:${created.id}`);
  assert.equal(document?.ownerId, 'aaa');
  assert.equal(document?.workspaceId, 'project-a');
  assert.equal(document?.partitionKey, 'aaa:project-a');

  const otherProject = new CosmosChatSessionStore(
    mock.binding,
    'project-b',
    'junior-compatible',
    'aaa'
  );
  const otherOwner = new CosmosChatSessionStore(
    mock.binding,
    'project-a',
    'junior-compatible',
    'junior-user'
  );
  await assert.rejects(() => otherProject.get(created.id), /Session was not found/);
  await assert.rejects(() => otherOwner.get(created.id), /Session was not found/);
  assert.deepEqual(await otherProject.list(), []);
  assert.deepEqual(await otherOwner.list(), []);
});

test('legacy AAA documents fall back only to the unpartitioned logical partition', async () => {
  const mock = createMockBinding();
  const legacy: StoredDocument = {
    id: '11111111-1111-4111-8111-111111111111',
    projectId: 'project-a',
    title: 'Legacy session',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    messageCount: 0,
    messages: [],
    runs: [],
    type: 'chatSession'
  };
  mock.documents.set(`<none>:${legacy.id}`, legacy);
  const store = new CosmosChatSessionStore(mock.binding, 'project-a', 'junior-compatible');

  assert.deepEqual((await store.list()).map(({ id }) => id), [legacy.id]);
  assert.deepEqual(mock.queryPartitions, ['aaa:project-a', '<none>']);
  assert.equal((await store.get(legacy.id)).title, 'Legacy session');
  assert.equal(mock.documents.has(`<none>:${legacy.id}`), false);
  assert.equal(mock.documents.has(`aaa:project-a:${legacy.id}`), true);
  await store.delete(legacy.id);
  assert.equal(mock.documents.has(`aaa:project-a:${legacy.id}`), false);
});

test('configured Cosmos operation failures surface storage_unavailable without credentials', async () => {
  const mock = createMockBinding();
  mock.binding.container.items.query = (() => ({
    fetchAll: async () => {
      throw Object.assign(new Error('credential detail that must not reach clients'), { code: 401 });
    }
  })) as unknown as typeof mock.binding.container.items.query;
  const store = new CosmosChatSessionStore(mock.binding, 'project-a');

  await assert.rejects(
    () => store.list(),
    (error: Error & { statusCode?: number; code?: string }) => {
      assert.equal(error.statusCode, 503);
      assert.equal(error.code, 'storage_unavailable');
      assert.doesNotMatch(error.message, /credential detail/);
      return true;
    }
  );
});

test('Cosmos delete reports missing sessions explicitly', async () => {
  const mock = createMockBinding();
  const store = new CosmosChatSessionStore(mock.binding, 'project-a');

  await assert.rejects(
    () => store.delete('11111111-1111-4111-8111-111111111111'),
    (error: Error & { statusCode?: number; code?: string }) => {
      assert.equal(error.statusCode, 404);
      assert.equal(error.code, 'not_found');
      return true;
    }
  );
});

test('partition schema mismatch fails explicitly before data access', async () => {
  const mock = createMockBinding();
  mock.binding.ensureReady = async () => {
    throw new CosmosSchemaMismatchError('/projectId', ['/partitionKey']);
  };
  const store = new CosmosChatSessionStore(mock.binding, 'project-a');

  await assert.rejects(
    () => store.list(),
    (error: Error & { statusCode?: number; code?: string }) => {
      assert.equal(error.statusCode, 503);
      assert.equal(error.code, 'storage_unavailable');
      assert.match(error.message, /expected \/projectId, found \/partitionKey/);
      return true;
    }
  );
  assert.deepEqual(mock.queryPartitions, []);
});
