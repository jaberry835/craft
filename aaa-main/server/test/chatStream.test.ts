import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { setTimeout as wait } from 'node:timers/promises';
import path from 'node:path';
import test from 'node:test';
import { createAaaApp } from '../app.js';
import type { ModelChatClient } from '../modelTypes.js';
import type { ChatSession } from '../../src/types/api.js';
import { ProjectRegistry } from '../projectRegistry.js';
import { ModelConnectionConfig } from '../services/modelConnectionConfig.js';

const testRoot = path.join(process.cwd(), '.test-data', 'chat-stream');

test('chat stream emits NDJSON and persists assistant only after successful completion', async (t) => {
  await rm(testRoot, { recursive: true, force: true });
  const projectRoot = path.join(testRoot, 'project');
  const dataRoot = path.join(testRoot, 'data');
  const projectsPath = path.join(testRoot, 'projects.json');
  const connectionsPath = path.join(testRoot, 'agent-connections.json');
  await mkdir(projectRoot, { recursive: true });
  await writeFile(projectsPath, JSON.stringify({
    activeProjectId: 'project',
    projects: [{ id: 'project', name: 'Security Package', rootPath: projectRoot }]
  }));
  await writeFile(connectionsPath, JSON.stringify([{
    id: 'model',
    name: 'Test model',
    type: 'azure-openai',
    authMode: 'api-key',
    endpointEnv: 'MODEL_ENDPOINT',
    apiKeyEnv: 'MODEL_KEY',
    deploymentEnv: 'MODEL_DEPLOYMENT',
    defaultApiVersion: '2025-01-01-preview'
  }]));

  const seenPrompts: string[][] = [];
  const modelClient: ModelChatClient = {
    async *stream(_connection, messages, signal) {
      seenPrompts.push(messages.map((message) => message.content));
      const latest = messages.at(-1)?.content;
      yield { type: 'reasoning', text: 'Reviewing' };
      if (latest === 'abort') {
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      yield { type: 'assistant_text', text: 'Assessment ' };
      if (latest === 'fail') {
        throw new Error('provider included MODEL_KEY');
      }
      yield { type: 'assistant_text', text: 'complete.' };
      yield { type: 'completed' };
    }
  };
  const registry = await ProjectRegistry.load(projectsPath);
  const modelConfig = await ModelConnectionConfig.load(connectionsPath, {
    MODEL_ENDPOINT: 'https://example.openai.azure.com',
    MODEL_KEY: 'super-secret-test-value',
    MODEL_DEPLOYMENT: 'chat'
  });
  const server = createServer(createAaaApp({ registry, dataRoot, modelConfig, modelClient }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
    await rm(testRoot, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const root = `http://127.0.0.1:${address.port}`;

  const statusText = await (await fetch(`${root}/api/model/status`)).text();
  assert.doesNotMatch(statusText, /super-secret-test-value/);
  assert.doesNotMatch(statusText, /MODEL_KEY/);

  const created = await (await fetch(`${root}/api/projects/project/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  })).json() as { id: string };
  const streamResponse = await fetch(
    `${root}/api/projects/project/sessions/${created.id}/chat/stream`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'assess this package' })
    }
  );
  assert.match(streamResponse.headers.get('content-type') ?? '', /^application\/x-ndjson/);
  const events = (await streamResponse.text()).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(events.map((event) => event.type), [
    'reasoning',
    'assistant_text',
    'assistant_text',
    'usage',
    'completed'
  ]);
  // The fake provider reports no usage, so the run records an estimate.
  assert.equal(events[3].usage.requests, 1);
  assert.equal(events[3].usage.estimated, true);
  const completed = events.at(-1);
  assert.equal(completed.response.message.content, 'Assessment complete.');
  assert.match(seenPrompts[0]?.[0] ?? '', /security package/i);
  assert.deepEqual(seenPrompts[0]?.slice(-1), ['assess this package']);

  const persisted = await (await fetch(
    `${root}/api/projects/project/sessions/${created.id}`
  )).json() as {
    messages: Array<{
      role: string;
      content: string;
      display?: Array<{ kind: string; text?: string }>;
    }>;
    runs: Array<{
      status: string;
      reasoning: string;
      assistantMessageId?: string;
      error?: string;
    }>;
  };
  assert.deepEqual(persisted.messages.map((message) => message.role), ['user', 'assistant']);
  assert.deepEqual(persisted.messages[1]?.display, [{ kind: 'reasoning', text: 'Reviewing' }]);
  assert.equal(persisted.runs.length, 1);
  assert.equal(persisted.runs[0]?.status, 'completed');
  assert.equal(persisted.runs[0]?.reasoning, 'Reviewing');
  assert.equal(persisted.runs[0]?.assistantMessageId, completed.response.message.id);

  const failedResponse = await fetch(
    `${root}/api/projects/project/sessions/${created.id}/chat/stream`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'fail' })
    }
  );
  const failedText = await failedResponse.text();
  const failedEvents = failedText.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(failedEvents.at(-1).type, 'error');
  assert.equal(failedEvents.at(-1).message, 'Model response failed.');
  assert.doesNotMatch(failedText, /MODEL_KEY|super-secret-test-value/);

  const afterFailure = await (await fetch(
    `${root}/api/projects/project/sessions/${created.id}`
  )).json() as {
    messages: Array<{ role: string }>;
    runs: Array<{ status: string; reasoning: string; assistantText?: string; error?: string }>;
  };
  assert.deepEqual(afterFailure.messages.map((message) => message.role), [
    'user',
    'assistant',
    'user'
  ]);
  assert.deepEqual(afterFailure.runs.map((run) => run.status), ['completed', 'failed']);
  assert.equal(afterFailure.runs[1]?.reasoning, 'Reviewing');
  assert.equal(afterFailure.runs[1]?.assistantText, 'Assessment ');
  assert.equal(afterFailure.runs[1]?.error, 'Model response failed.');

  const abortController = new AbortController();
  const abortedResponse = await fetch(
    `${root}/api/projects/project/sessions/${created.id}/chat/stream`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'abort' }),
      signal: abortController.signal
    }
  );
  abortController.abort();
  await assert.rejects(() => abortedResponse.text(), /abort/i);
  await wait(50);

  const afterAbort = await (await fetch(
    `${root}/api/projects/project/sessions/${created.id}`
  )).json() as {
    messages: Array<{ role: string }>;
    runs: Array<{ status: string; reasoning: string; error?: string }>;
  };
  assert.deepEqual(afterAbort.messages.map((message) => message.role), [
    'user',
    'assistant',
    'user',
    'user'
  ]);
  assert.deepEqual(afterAbort.runs.map((run) => run.status), ['completed', 'failed', 'aborted']);
  assert.equal(afterAbort.runs[2]?.reasoning, 'Reviewing');
  assert.equal(afterAbort.runs[2]?.error, 'Request aborted.');
});

test('chat sessions compact manually and automatically and the model sees the summary instead', async (t) => {
  const root = path.join(process.cwd(), '.test-data', 'chat-compaction');
  await rm(root, { recursive: true, force: true });
  const projectRoot = path.join(root, 'project');
  await mkdir(projectRoot, { recursive: true });
  await writeFile(path.join(root, 'projects.json'), JSON.stringify({
    activeProjectId: 'project',
    projects: [{ id: 'project', name: 'Security Package', rootPath: projectRoot }]
  }));
  await writeFile(path.join(root, 'agent-connections.json'), JSON.stringify([{
    id: 'model',
    name: 'Test model',
    type: 'azure-openai',
    authMode: 'api-key',
    endpointEnv: 'MODEL_ENDPOINT',
    apiKeyEnv: 'MODEL_KEY',
    deploymentEnv: 'MODEL_DEPLOYMENT',
    defaultApiVersion: '2025-01-01-preview',
    contextWindow: 1024,
    compaction: { threshold: 0.3 }
  }]));

  const agentRequests: string[][] = [];
  let summaries = 0;
  const modelClient: ModelChatClient = {
    async *stream(_connection, messages) {
      if (messages[0]?.content.startsWith('You compact conversations')) {
        summaries += 1;
        yield { type: 'assistant_text', text: `Summary ${summaries}.` };
        yield { type: 'usage', usage: { inputTokens: 400, cachedInputTokens: 0, outputTokens: 20, reasoningTokens: 0, totalTokens: 420 } };
        yield { type: 'completed' };
        return;
      }
      agentRequests.push(messages.map((message) => message.content));
      yield { type: 'assistant_text', text: `Reply to ${messages.at(-1)?.content}` };
      yield { type: 'usage', usage: { inputTokens: 700, cachedInputTokens: 512, outputTokens: 10, reasoningTokens: 0, totalTokens: 710 } };
      yield { type: 'completed' };
    }
  };
  const registry = await ProjectRegistry.load(path.join(root, 'projects.json'));
  const modelConfig = await ModelConnectionConfig.load(path.join(root, 'agent-connections.json'), {
    MODEL_ENDPOINT: 'https://example.openai.azure.com',
    MODEL_KEY: 'key',
    MODEL_DEPLOYMENT: 'chat'
  });
  const server = createServer(createAaaApp({ registry, dataRoot: path.join(root, 'data'), modelConfig, modelClient }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/projects/project/sessions`;
  const status = await (await fetch(`http://127.0.0.1:${address.port}/api/model/status`)).json() as {
    contextWindow?: number;
    autoCompact: boolean;
  };
  assert.equal(status.contextWindow, 1024);
  assert.equal(status.autoCompact, true);

  const { id } = await (await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json() as { id: string };
  const send = async (content: string) => (await (await fetch(`${base}/${id}/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content })
  })).text()).trim().split('\n').map((line) => JSON.parse(line) as { type: string; [key: string]: unknown });

  const first = await send('first');
  assert.equal(first.some((event) => event.type === 'compaction'), false);
  assert.equal(first.at(-1)?.type, 'completed');

  const manual = await fetch(`${base}/${id}/compact`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ focus: 'AC-2' })
  });
  assert.equal(manual.status, 200);
  const afterManual = await manual.json() as ChatSession;
  assert.equal(afterManual.compactions?.[0]?.trigger, 'manual');
  assert.equal(afterManual.compactions?.[0]?.focus, 'AC-2');
  assert.equal(afterManual.messages.length, 2);

  const nothing = await fetch(`${base}/${id}/compact`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(nothing.status, 400);

  const second = await send('second');
  assert.equal(second.some((event) => event.type === 'compaction' || event.type === 'status'), false);
  assert.match(agentRequests[1]![0]!, /Earlier conversation \(compacted\)[\s\S]*Summary 1\./);
  assert.deepEqual(agentRequests[1]!.slice(1), ['second']);

  const third = await send('third');
  const compactionEvent = third.find((event) => event.type === 'compaction') as { compaction: { trigger: string; throughMessageId: string } } | undefined;
  assert.equal(compactionEvent?.compaction.trigger, 'auto');
  assert.ok(third.findIndex((event) => event.type === 'compaction') < third.findIndex((event) => event.type === 'assistant_text'));
  assert.match(agentRequests[2]![0]!, /Summary 2\./);
  assert.deepEqual(agentRequests[2]!.slice(1), ['third']);
  const usageEvents = third.filter((event) => event.type === 'usage') as unknown as Array<{ usage: { requests: number } }>;
  assert.equal(usageEvents.at(-1)?.usage.requests, 2);

  const persisted = await (await fetch(`${base}/${id}`)).json() as ChatSession;
  assert.equal(persisted.compactions?.length, 2);
  assert.equal(persisted.messages.length, 6);
  const lastRun = persisted.runs.at(-1)!;
  assert.equal(lastRun.usage?.requests, 2);
  assert.equal(lastRun.usage?.cachedInputTokens, 512);
  assert.equal(lastRun.usage?.promptTokens, 700);
});
