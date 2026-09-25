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
    parameters: tools[0].function.parameters,
    strict: false
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
type FetchCall = { url: string; body: Record<string, unknown> };

function withDefinition(
  value: ResolvedModelConnection,
  overrides: Partial<ResolvedModelConnection['definition']>
): ResolvedModelConnection {
  return { ...value, definition: { ...value.definition, ...overrides } };
}

function scriptedFetch(responses: Array<(call: FetchCall) => Response>) {
  const calls: FetchCall[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> };
    calls.push(call);
    const next = responses[Math.min(calls.length - 1, responses.length - 1)]!;
    return next(call);
  };
  return { calls, fetchImpl: fetchImpl as typeof globalThis.fetch };
}

const errorResponse = (status: number, error: Record<string, unknown>) =>
  () => new Response(JSON.stringify({ error }), { status, headers: { 'Content-Type': 'application/json' } });

const toolHistory = [
  { role: 'user' as const, content: '/initialize-security-package' },
  {
    role: 'assistant' as const,
    content: '',
    toolCalls: [{ id: 'call-1', type: 'function' as const, function: { name: 'load_skill', arguments: '{"name":"x"}' } }]
  },
  { role: 'tool' as const, content: 'skill text', toolCallId: 'call-1' }
];

async function collect(
  client: AzureOpenAiChatClient,
  value: ResolvedModelConnection,
  messages: Parameters<AzureOpenAiChatClient['stream']>[1] = [{ role: 'user', content: 'hello' }]
) {
  const events = [];
  for await (const event of client.stream(value, messages)) events.push(event);
  return events;
}

const quiet = () => {};

test('azure client surfaces content-filter failures without retrying or leaking the key', async (t) => {
  t.mock.method(console, 'error', quiet);
  const { calls, fetchImpl } = scriptedFetch([errorResponse(400, {
    code: 'content_filter',
    message: 'The prompt was filtered. Key test-key must not leak.',
    innererror: {
      code: 'ResponsibleAIPolicyViolation',
      content_filter_result: { jailbreak: { filtered: true, detected: true }, hate: { filtered: false } }
    }
  })]);
  const client = new AzureOpenAiChatClient(fetchImpl, undefined, quiet);
  await assert.rejects(
    () => collect(client, connection('https://example.openai.azure.com/openai/v1'), toolHistory),
    (error: Error) => {
      assert.equal(error.name, 'AgentRunError');
      assert.match(error.message, /status 400 \(content_filter\)/);
      assert.match(error.message, /Filtered categories: jailbreak\./);
      assert.doesNotMatch(error.message, /test-key/);
      return true;
    }
  );
  assert.equal(calls.length, 1);
});

test('azure client switches to Responses when a tool-result replay is rejected and remembers it', async (t) => {
  t.mock.method(console, 'error', quiet);
  const notes: string[] = [];
  const { calls, fetchImpl } = scriptedFetch([
    errorResponse(400, { code: 'invalid_request_error', message: 'Invalid value for messages[2].' }),
    () => sseResponse(['{"type":"response.output_text.delta","delta":"Loaded"}', '{"type":"response.completed"}']),
    () => sseResponse(['{"type":"response.output_text.delta","delta":"Again"}', '{"type":"response.completed"}'])
  ]);
  const client = new AzureOpenAiChatClient(fetchImpl, undefined, (message) => notes.push(message));
  const value = connection('https://example.openai.azure.com/openai/v1');

  const events = await collect(client, value, toolHistory);
  assert.deepEqual(events, [{ type: 'assistant_text', text: 'Loaded' }, { type: 'completed' }]);
  assert.equal(calls[0]!.url, 'https://example.openai.azure.com/openai/v1/chat/completions');
  assert.equal(calls[1]!.url, 'https://example.openai.azure.com/openai/v1/responses');
  assert.equal(calls[1]!.body.max_output_tokens, 16000);
  const input = calls[1]!.body.input as Array<Record<string, unknown>>;
  assert.deepEqual(input.map((item) => item.type), ['message', 'function_call', 'function_call_output']);
  assert.equal(client.learnedShape(value)?.api, 'responses');
  assert.ok(notes.some((note) => /Retrying with api responses/.test(note)));

  await collect(client, value);
  assert.equal(calls.length, 3);
  assert.equal(calls[2]!.url, 'https://example.openai.azure.com/openai/v1/responses');
});

test('azure client never overrides an explicitly configured api', async (t) => {
  t.mock.method(console, 'error', quiet);
  const { calls, fetchImpl } = scriptedFetch([errorResponse(400, { message: 'Invalid value for messages[2].' })]);
  const client = new AzureOpenAiChatClient(fetchImpl, undefined, quiet);
  await assert.rejects(
    () => collect(client, withDefinition(connection('https://example.openai.azure.com/openai/v1'), { api: 'chat-completions' }), toolHistory),
    /status 400.*model:probe/
  );
  assert.equal(calls.length, 1);
});

test('azure client adapts the token parameter and temperature on recognized parameter errors', async (t) => {
  t.mock.method(console, 'error', quiet);
  const { calls, fetchImpl } = scriptedFetch([
    errorResponse(400, {
      code: 'unsupported_parameter',
      param: 'max_tokens',
      message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."
    }),
    errorResponse(400, {
      code: 'unsupported_value',
      message: "Unsupported value: 'temperature' does not support 0.2 with this model. Only the default (1) value is supported."
    }),
    () => sseResponse(['{"choices":[{"delta":{"content":"ok"}}]}', '[DONE]'])
  ]);
  const client = new AzureOpenAiChatClient(fetchImpl, undefined, quiet);
  const value = connection('https://example.openai.azure.com');
  await collect(client, value);

  assert.equal(calls.length, 3);
  assert.equal(calls[0]!.body.max_tokens, 16000);
  assert.equal(calls[1]!.body.max_completion_tokens, 16000);
  assert.equal(Object.hasOwn(calls[1]!.body, 'max_tokens'), false);
  assert.equal(Object.hasOwn(calls[2]!.body, 'temperature'), false);
  assert.match(calls[2]!.url, /\/openai\/deployments\/gpt-test\/chat\/completions\?api-version=/);
  assert.deepEqual(client.learnedShape(value), {
    api: 'chat-completions',
    tokenParameter: 'max_completion_tokens',
    temperature: false,
    toolChoice: true,
    reasoning: false,
    includeUsage: true
  });
});

test('azure client falls back to Chat Completions when a Responses route is missing', async (t) => {
  t.mock.method(console, 'error', quiet);
  const { calls, fetchImpl } = scriptedFetch([
    errorResponse(404, { code: '404', message: 'Resource not found' }),
    () => sseResponse(['{"choices":[{"delta":{"content":"ok"}}]}', '[DONE]'])
  ]);
  const client = new AzureOpenAiChatClient(fetchImpl, undefined, quiet);
  await collect(client, connection('https://example.services.ai.azure.com/api/projects/aaa/openai/v1/responses'));
  assert.equal(calls[1]!.url, 'https://example.services.ai.azure.com/api/projects/aaa/openai/v1/chat/completions');
  assert.equal(calls[1]!.body.max_completion_tokens, 16000);
});

test('azure client honors adaptive false and omitted temperature', async (t) => {
  t.mock.method(console, 'error', quiet);
  const { calls, fetchImpl } = scriptedFetch([errorResponse(404, { message: 'Resource not found' })]);
  const client = new AzureOpenAiChatClient(fetchImpl, undefined, quiet);
  await assert.rejects(() => collect(client, withDefinition(
    connection('https://example.openai.azure.com/openai/v1'),
    { adaptive: false, temperature: null, tokenParameter: 'omit', reasoningEffort: 'low' }
  )), /status 404/);
  assert.equal(calls.length, 1);
  assert.equal(Object.hasOwn(calls[0]!.body, 'temperature'), false);
  assert.equal(Object.hasOwn(calls[0]!.body, 'max_completion_tokens'), false);
  assert.equal(calls[0]!.body.reasoning_effort, 'low');
});

test('azure client sends null content for tool-call-only chat turns', async () => {
  const { calls, fetchImpl } = scriptedFetch([() => sseResponse(['{"choices":[{"delta":{"content":"ok"}}]}', '[DONE]'])]);
  await collect(new AzureOpenAiChatClient(fetchImpl, undefined, quiet), connection('https://example.openai.azure.com/openai/v1'), toolHistory);
  const messages = calls[0]!.body.messages as Array<Record<string, unknown>>;
  assert.equal(messages[1]!.content, null);
  assert.equal((messages[1]!.tool_calls as unknown[]).length, 1);
  assert.equal(messages[2]!.tool_call_id, 'call-1');
});

test('azure client accepts complete JSON responses and finish_reason without [DONE]', async () => {
  const json = new Response(JSON.stringify({
    choices: [{
      finish_reason: 'tool_calls',
      message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.md"}' } }] }
    }]
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const { fetchImpl: jsonFetch } = scriptedFetch([() => json]);
  assert.deepEqual(await collect(new AzureOpenAiChatClient(jsonFetch, undefined, quiet), connection('https://example.openai.azure.com/openai/v1')), [
    { type: 'tool_calls', calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.md"}' } }] },
    { type: 'completed' }
  ]);

  const { fetchImpl: noDone } = scriptedFetch([() => sseResponse([
    '{"choices":[{"delta":{"content":"Hi"}}]}',
    '{"choices":[{"delta":{},"finish_reason":"stop"}]}'
  ])]);
  assert.deepEqual(await collect(new AzureOpenAiChatClient(noDone, undefined, quiet), connection('https://example.openai.azure.com/openai/v1')), [
    { type: 'assistant_text', text: 'Hi' },
    { type: 'completed' }
  ]);
});

test('azure client assembles Responses function calls reported only on output_item.done', async () => {
  const { fetchImpl } = scriptedFetch([() => sseResponse([
    '{"type":"response.output_item.done","item":{"type":"function_call","id":"fc-1","call_id":"call-9","name":"list_files","arguments":"{}"}}',
    '{"type":"response.completed"}'
  ])]);
  const events = await collect(
    new AzureOpenAiChatClient(fetchImpl, undefined, quiet),
    withDefinition(connection('https://example.openai.azure.com/openai/v1'), { api: 'responses' })
  );
  assert.deepEqual(events[0], {
    type: 'tool_calls',
    calls: [{ id: 'call-9', type: 'function', function: { name: 'list_files', arguments: '{}' } }]
  });
});

test('azure client requests and reports Chat Completions usage including cached and reasoning tokens', async () => {
  const { calls, fetchImpl } = scriptedFetch([() => sseResponse([
    '{"choices":[{"delta":{"content":"Done"}}]}',
    '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
    '{"choices":[],"usage":{"prompt_tokens":1200,"completion_tokens":80,"total_tokens":1280,"prompt_tokens_details":{"cached_tokens":1024},"completion_tokens_details":{"reasoning_tokens":40}}}',
    '[DONE]'
  ])]);
  const events = await collect(new AzureOpenAiChatClient(fetchImpl, undefined, quiet), connection('https://example.openai.azure.com/openai/v1'));
  assert.deepEqual(calls[0]!.body.stream_options, { include_usage: true });
  assert.deepEqual(events, [
    { type: 'assistant_text', text: 'Done' },
    { type: 'usage', usage: { inputTokens: 1200, cachedInputTokens: 1024, outputTokens: 80, reasoningTokens: 40, totalTokens: 1280 } },
    { type: 'completed' }
  ]);
});

test('azure client reports Responses usage from response.completed', async () => {
  const { calls, fetchImpl } = scriptedFetch([() => sseResponse([
    '{"type":"response.output_text.delta","delta":"Hi"}',
    '{"type":"response.completed","response":{"usage":{"input_tokens":500,"input_tokens_details":{"cached_tokens":0},"output_tokens":20,"output_tokens_details":{"reasoning_tokens":8},"total_tokens":520}}}'
  ])]);
  const events = await collect(
    new AzureOpenAiChatClient(fetchImpl, undefined, quiet),
    withDefinition(connection('https://example.openai.azure.com/openai/v1'), { api: 'responses' })
  );
  assert.equal(Object.hasOwn(calls[0]!.body, 'stream_options'), false);
  assert.deepEqual(events[1], {
    type: 'usage',
    usage: { inputTokens: 500, cachedInputTokens: 0, outputTokens: 20, reasoningTokens: 8, totalTokens: 520 }
  });
});

test('azure client drops stream_options when a deployment rejects it', async (t) => {
  t.mock.method(console, 'error', quiet);
  const { calls, fetchImpl } = scriptedFetch([
    errorResponse(400, { message: 'Unrecognized request argument supplied: stream_options' }),
    () => sseResponse(['{"choices":[{"delta":{"content":"ok"}}]}', '[DONE]'])
  ]);
  const client = new AzureOpenAiChatClient(fetchImpl, undefined, quiet);
  const value = connection('https://example.openai.azure.com');
  await collect(client, value);
  assert.equal(Object.hasOwn(calls[1]!.body, 'stream_options'), false);
  assert.equal(client.learnedShape(value)?.includeUsage, false);
});

test('azure client retries throttling and transient failures using Retry-After', async (t) => {
  t.mock.method(console, 'error', quiet);
  const notes: string[] = [];
  const { calls, fetchImpl } = scriptedFetch([
    () => new Response('{}', { status: 429, headers: { 'retry-after-ms': '1' } }),
    () => new Response('{}', { status: 503, headers: { 'retry-after': '0' } }),
    () => sseResponse(['{"choices":[{"delta":{"content":"ok"}}]}', '[DONE]'])
  ]);
  const events = await collect(
    new AzureOpenAiChatClient(fetchImpl, undefined, (message) => notes.push(message)),
    connection('https://example.openai.azure.com/openai/v1')
  );
  assert.equal(calls.length, 3);
  assert.equal(events[0]?.type, 'assistant_text');
  assert.ok(notes.some((note) => /returned 429; retry 1 of 3/.test(note)));

  const { calls: limited, fetchImpl: alwaysBusy } = scriptedFetch([
    () => new Response(JSON.stringify({ error: { code: '429', message: 'Rate limit exceeded.' } }), {
      status: 429,
      headers: { 'retry-after-ms': '1' }
    })
  ]);
  await assert.rejects(
    () => collect(
      new AzureOpenAiChatClient(alwaysBusy, undefined, quiet),
      withDefinition(connection('https://example.openai.azure.com/openai/v1'), { maxRetries: 1 })
    ),
    /status 429.*Rate limit exceeded/
  );
  assert.equal(limited.length, 2);
});

test('azure client stops waiting to retry when the run is aborted', async () => {
  const { fetchImpl } = scriptedFetch([() => new Response('{}', { status: 429, headers: { 'retry-after': '30' } })]);
  const controller = new AbortController();
  const client = new AzureOpenAiChatClient(fetchImpl, undefined, quiet);
  const pending = (async () => {
    for await (const _event of client.stream(connection('https://example.openai.azure.com/openai/v1'), [{ role: 'user', content: 'x' }], controller.signal)) {
      void _event;
    }
  })();
  setTimeout(() => controller.abort(new DOMException('Stopped', 'AbortError')), 10);
  await assert.rejects(pending, /Stopped/);
});

test('azure client backs off exponentially when no retry header is present', async () => {
  const started = Date.now();
  const { calls, fetchImpl } = scriptedFetch([
    () => new Response('{}', { status: 503 }),
    () => sseResponse(['{"choices":[{"delta":{"content":"ok"}}]}', '[DONE]'])
  ]);
  await collect(new AzureOpenAiChatClient(fetchImpl, undefined, quiet), connection('https://example.openai.azure.com/openai/v1'));
  assert.equal(calls.length, 2);
  assert.ok(Date.now() - started >= 900, 'first retry should wait about one second');
});
