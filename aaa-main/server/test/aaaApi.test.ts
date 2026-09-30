import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aaaApi,
  ApiRequestError,
  setApiAuthProvider,
  type ApiAuthProvider
} from '../../src/api/aaaApi.js';
import type { ChatStreamEvent } from '../../src/types/api.js';

const noAuth: ApiAuthProvider = {
  enabled: () => false,
  headers: async () => ({}),
  onAuthRequired: () => undefined
};

test('API requests refresh authentication once after a 401', async (t) => {
  const refreshes: boolean[] = [];
  let authRequired = 0;
  let requests = 0;
  setApiAuthProvider({
    enabled: () => true,
    headers: async (forceRefresh) => {
      refreshes.push(forceRefresh);
      return { Authorization: forceRefresh ? 'Bearer fresh' : 'Bearer cached' };
    },
    onAuthRequired: () => { authRequired += 1; }
  });
  t.after(() => setApiAuthProvider(noAuth));
  t.mock.method(globalThis, 'fetch', async (
    _input: string | URL | Request,
    init?: RequestInit
  ) => {
    requests += 1;
    if (requests === 1) return new Response(null, { status: 401 });
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fresh');
    return Response.json({ id: 'model', ready: true });
  });

  assert.deepEqual(await aaaApi.getModelStatus(), { id: 'model', ready: true });
  assert.deepEqual(refreshes, [false, true]);
  assert.equal(authRequired, 0);
});

test('API errors preserve server status and code and notify after persistent authentication failure', async (t) => {
  let authRequired = 0;
  setApiAuthProvider({
    enabled: () => true,
    headers: async () => ({}),
    onAuthRequired: () => { authRequired += 1; }
  });
  t.after(() => setApiAuthProvider(noAuth));
  t.mock.method(console, 'error', () => undefined);
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ error: 'Sign in again.', code: 'auth_required' }, { status: 401 }));

  await assert.rejects(
    () => aaaApi.getModelStatus(),
    (error: unknown) => error instanceof ApiRequestError
      && error.status === 401
      && error.code === 'auth_required'
      && error.message === 'Sign in again.'
  );
  assert.equal(authRequired, 1);
});

test('streaming chat sends encoded paths and delivers a complete NDJSON response', async (t) => {
  const encoder = new TextEncoder();
  t.mock.method(globalThis, 'fetch', async (
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    assert.equal(String(input), '/api/projects/project%20one/sessions/session%2Fone/chat/stream');
    assert.equal(init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(init?.body)), { content: 'hello' });
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"type":"assistant_text","text":"Hello"}\n'));
        controller.enqueue(encoder.encode('{"type":"completed"}\n'));
        controller.close();
      }
    }));
  });
  const events: ChatStreamEvent[] = [];

  await aaaApi.streamChat(
    'project one',
    'session/one',
    { content: 'hello' },
    (event) => { events.push(event); }
  );

  assert.deepEqual(events, [
    { type: 'assistant_text', text: 'Hello' },
    { type: 'completed' }
  ]);
});

test('streaming chat rejects a response that ends without a terminal event', async (t) => {
  const encoder = new TextEncoder();
  t.mock.method(console, 'error', () => undefined);
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('{"type":"assistant_text","text":"Partial"}\n'));
      controller.close();
    }
  })));

  await assert.rejects(
    () => aaaApi.streamChat('project', 'session', { content: 'hello' }, () => undefined),
    /ended before the agent finished/
  );
});
