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
  assert.equal(requestBody.max_tokens, 16000);
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
  assert.equal(requestBody.max_completion_tokens, 16000);
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

test('azure client sends tools and assembles streamed responses API tool calls', async () => {
  let requestBody: Record<string, unknown> = {};
  const client = new AzureOpenAiChatClient(async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return sseResponse([
      '{"type":"response.output_item.added","item":{"type":"function_call","id":"item-1","call_id":"call-1","name":"write_file"}}',
      '{"type":"response.function_call_arguments.delta","item_id":"item-1","delta":"{\\"path\\":\\"test.md\\","}',
      '{"type":"response.function_call_arguments.delta","item_id":"item-1","delta":"\\"content\\":\\"# Test\\"}"}',
      '{"type":"response.completed"}'
    ]);
  });
  const tools = [{
    type: 'function' as const,
    function: {
      name: 'write_file',
      description: 'Write a file.',
      parameters: {
        type: 'object' as const,
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content']
      }
    }
  }];
  const events = [];
  for await (const event of client.stream(
    connection('https://example.services.ai.azure.com/api/projects/aaa/openai/v1/responses'),
    [{ role: 'user', content: 'create a file' }],
    undefined,
    tools
  )) {
    events.push(event);
  }

  assert.deepEqual(requestBody.tools, [{
    type: 'function',
    name: 'write_file',
    description: 'Write a file.',
    parameters: tools[0].function.parameters
  }]);
  assert.deepEqual(events, [
    {
      type: 'tool_calls',
      calls: [{
        id: 'call-1',
        type: 'function',
        function: {
          name: 'write_file',
          arguments: '{"path":"test.md","content":"# Test"}'
        }
      }]
    },
    { type: 'completed' }
  ]);
});

test('azure client reports an actionable error when output hits the token limit', async () => {
  const client = new AzureOpenAiChatClient(async () => sseResponse([
    '{"choices":[{"delta":{"content":"Partial"}}]}',
    '{"choices":[{"delta":{},"finish_reason":"length"}]}',
    '[DONE]'
  ]));
  await assert.rejects(
    () => consume(client, connection('https://example.openai.azure.com/openai/v1')),
    /16000-token output limit/
  );
});