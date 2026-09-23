import assert from 'node:assert/strict';
import test from 'node:test';
import { AzureOpenAiChatClient } from '../services/azureOpenAiChatClient.js';
import type { ResolvedModelConnection } from '../modelTypes.js';

function connection(endpoint: string): ResolvedModelConnection {
  return {
    definition: {
      id: 'model',
      name: 'Test',
      type: 'azure-openai',
      authMode: 'api-key',
      endpointEnv: 'ENDPOINT',
      apiKeyEnv: 'KEY',
      deploymentEnv: 'DEPLOYMENT',
      defaultApiVersion: '2025-01-01-preview'
    },
    endpoint,
    deployment: 'gpt-test',
    apiVersion: '2025-01-01-preview',
    apiKey: 'test-key'
  };
}

async function consume(client: AzureOpenAiChatClient, value: ResolvedModelConnection) {
  const events = [];
  for await (const event of client.stream(value, [{ role: 'user', content: 'hello' }])) {
    events.push(event);
  }
  return events;
}

const sseResponse = (lines: string[]) => new Response(new ReadableStream({
  start(controller) {
    const encoder = new TextEncoder();
    for (const line of lines) {
      controller.enqueue(encoder.encode(`data: ${line}\n\n`));
    }
    controller.close();
  }
}), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });

test('azure client uses legacy deployment request shape and streams chat deltas', async () => {
  let requestUrl = '';
  let requestBody: Record<string, unknown> = {};
  const client = new AzureOpenAiChatClient(async (input, init) => {
    requestUrl = String(input);
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return sseResponse([
      '{"choices":[{"delta":{"content":"Hello"}}]}',
      '[DONE]'
    ]);
  });

  const events = await consume(client, connection('https://example.openai.azure.com'));
  assert.equal(
    requestUrl,
    'https://example.openai.azure.com/openai/deployments/gpt-test/chat/completions?api-version=2025-01-01-preview'
  );
  assert.equal(requestBody.model, undefined);
  assert.equal(requestBody.max_tokens, 1200);
  assert.equal(requestBody.stream, true);
  assert.deepEqual(events, [
    { type: 'assistant_text', text: 'Hello' },
    { type: 'completed' }
  ]);
});

test('azure client uses v1 request shape without api-version', async () => {
  let requestUrl = '';
  let requestBody: Record<string, unknown> = {};
  const client = new AzureOpenAiChatClient(async (input, init) => {
    requestUrl = String(input);
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return sseResponse(['[DONE]']);
  });

  await consume(client, connection('https://example.openai.azure.com/openai/v1'));
  assert.equal(requestUrl, 'https://example.openai.azure.com/openai/v1/chat/completions');
  assert.equal(requestBody.model, 'gpt-test');
  assert.equal(requestBody.max_completion_tokens, 1200);
  assert.equal(Object.hasOwn(requestBody, 'max_tokens'), false);
});

test('azure client maps responses API text and reasoning to provider-neutral chunks', async () => {
  const client = new AzureOpenAiChatClient(async () => sseResponse([
    '{"type":"response.reasoning_summary_text.delta","delta":"Checking"}',
    '{"type":"response.output_text.delta","delta":"Done"}',
    '{"type":"response.completed"}'
  ]));

  const events = await consume(
    client,
    connection('https://example.services.ai.azure.com/api/projects/aaa/openai/v1/responses')
  );
  assert.deepEqual(events, [
    { type: 'reasoning', text: 'Checking' },
    { type: 'assistant_text', text: 'Done' },
    { type: 'completed' }
  ]);
});
