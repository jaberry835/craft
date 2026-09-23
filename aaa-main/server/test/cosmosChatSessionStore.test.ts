import type { Container } from '@azure/cosmos';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatSession } from '../../src/types/api.js';
import { CosmosChatSessionStore } from '../cosmosChatSessionStore.js';
import type { CosmosContainerBinding } from '../cosmosContainerFactory.js';

interface StoredDocument extends ChatSession {
  type: 'chatSession';
}

function createMockBinding() {
  const documents = new Map<string, StoredDocument>();
  const partitions: string[] = [];
  const container = {
    items: {
      query: (_query: unknown, options: { partitionKey: string }) => {
        partitions.push(options.partitionKey);
        return {
          fetchAll: async () => ({
            resources: [...documents.values()]
              .filter((document) => document.projectId === options.partitionKey)
              .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
          })
        };
      },
      upsert: async (document: StoredDocument) => {
        documents.set(`${document.projectId}:${document.id}`, structuredClone(document));
        return { resource: document };
      }
    },
    item: (id: string, partitionKey: string) => ({
      read: async () => {
        const resource = documents.get(`${partitionKey}:${id}`);
        if (!resource) {
          throw Object.assign(new Error('missing'), { code: 404 });
        }
        return { resource: structuredClone(resource) };
      },
      delete: async () => {
        if (!documents.delete(`${partitionKey}:${id}`)) {
          throw Object.assign(new Error('missing'), { code: 404 });
        }
        return {};
      }
    })
  } as unknown as Container;
  const binding: CosmosContainerBinding = {
    container,
    settings: {
      endpointHost: 'safe-account.documents.azure.com',
      database: 'Aaa',
      container: 'ChatSessions',
      authMode: 'entra',
      keyConfigured: false
    }
  };
  return { binding, documents, partitions };
}

test('Cosmos session storage maps AAA CRUD operations into project partitions', async () => {
  const mock = createMockBinding();
  const store = new CosmosChatSessionStore(mock.binding, 'project-a');
  const created = await store.create();
  const appended = await store.append(created.id, {
    role: 'user',
    content: 'Assess privileged access'
  });

  assert.equal(appended.title, 'Assess privileged access');
  assert.equal(appended.messageCount, 1);
  assert.equal(mock.documents.get(`project-a:${created.id}`)?.type, 'chatSession');
  assert.equal(mock.documents.get(`project-a:${created.id}`)?.projectId, 'project-a');
  assert.deepEqual((await store.list()).map((session) => session.id), [created.id]);
  assert.deepEqual(mock.partitions, ['project-a']);

  const renamed = await store.rename(created.id, 'Privileged access assessment');
  assert.equal(renamed.title, 'Privileged access assessment');
  assert.equal((await store.get(created.id)).messages[0]?.content, 'Assess privileged access');

  const otherProject = new CosmosChatSessionStore(mock.binding, 'project-b');
  await assert.rejects(() => otherProject.get(created.id), /Session was not found/);

  await store.delete(created.id);
  assert.deepEqual(await store.list(), []);
});

test('configured Cosmos operation failures surface storage_unavailable without fallback', async () => {
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
