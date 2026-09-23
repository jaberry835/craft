import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { createAaaApp } from '../app.js';
import type { ModelChatClient } from '../modelTypes.js';
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
    async *stream(_connection, messages) {
      seenPrompts.push(messages.map((message) => message.content));
      const latest = messages.at(-1)?.content;
      yield { type: 'reasoning', text: 'Reviewing' };
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
    'completed'
  ]);
  const completed = events.at(-1);
  assert.equal(completed.response.message.content, 'Assessment complete.');
  assert.match(seenPrompts[0]?.[0] ?? '', /security package/i);
  assert.deepEqual(seenPrompts[0]?.slice(-1), ['assess this package']);

  const persisted = await (await fetch(
    `${root}/api/projects/project/sessions/${created.id}`
  )).json() as { messages: Array<{ role: string; content: string }> };
  assert.deepEqual(persisted.messages.map((message) => message.role), ['user', 'assistant']);

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
  )).json() as { messages: Array<{ role: string }> };
  assert.deepEqual(afterFailure.messages.map((message) => message.role), [
    'user',
    'assistant',
    'user'
  ]);
});
