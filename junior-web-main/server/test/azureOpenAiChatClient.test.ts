import assert from 'node:assert/strict';
import test from 'node:test';
import { AzureOpenAiChatClient } from '../services/azureOpenAiChatClient.js';
import type { AgentModelConnection } from '../types.js';

function createConnection(endpoint: string): AgentModelConnection {
  return {
    id: 'default-azure-openai',
    name: 'Default Azure OpenAI',
    type: 'azure-openai',
    authMode: 'api-key',
    endpoint,
    deployment: 'gpt-4.1',
    defaultApiVersion: '2025-01-01-preview'
  };
}

test('azure chat client uses legacy Azure deployment path for non-v1 endpoints', async () => {
  const client = new AzureOpenAiChatClient(() => 'test-key');
  const originalFetch = globalThis.fetch;
  let requestUrl = '';
  let requestBody = '';

  globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    requestBody = String(init?.body ?? '');
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    await client.complete(createConnection('https://example.openai.azure.com'), [{ role: 'user', content: 'hello' }]);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requestUrl, 'https://example.openai.azure.com/openai/deployments/gpt-4.1/chat/completions?api-version=2025-01-01-preview');
  assert.equal(JSON.parse(requestBody).model, undefined);
});

test('azure chat client uses v1 chat completions path without api-version for v1 endpoints', async () => {
  const client = new AzureOpenAiChatClient(() => 'test-key');
  const originalFetch = globalThis.fetch;
  let requestUrl = '';
  let requestBody = '';

  globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    requestBody = String(init?.body ?? '');
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    await client.complete(createConnection('https://example.openai.azure.com/openai/v1'), [{ role: 'user', content: 'hello' }]);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requestUrl, 'https://example.openai.azure.com/openai/v1/chat/completions');
  assert.equal(JSON.parse(requestBody).model, 'gpt-4.1');
});

test('azure chat client uses exact responses endpoint and responses request body for v1 responses URIs', async () => {
  const client = new AzureOpenAiChatClient(() => 'test-key');
  const originalFetch = globalThis.fetch;
  let requestUrl = '';
  let requestBody = '';

  globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    requestBody = String(init?.body ?? '');
    return new Response(JSON.stringify({
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'ok' }]
        }
      ]
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    await client.complete(createConnection('https://jb-foundry.services.ai.azure.com/api/projects/proj1/openai/v1/responses'), [{ role: 'user', content: 'hello' }]);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requestUrl, 'https://jb-foundry.services.ai.azure.com/api/projects/proj1/openai/v1/responses');
  const parsed = JSON.parse(requestBody);
  assert.equal(parsed.model, 'gpt-4.1');
  assert.equal(parsed.stream, false);
  assert.equal(Array.isArray(parsed.input), true);
  assert.equal(parsed.max_output_tokens, 1200);
});

test('azure chat client requests reasoning effort for responses endpoints when configured', async () => {
  const client = new AzureOpenAiChatClient(() => 'test-key');
  const originalFetch = globalThis.fetch;
  let requestBody = '';

  globalThis.fetch = async (_input, init) => {
    requestBody = String(init?.body ?? '');
    return new Response(JSON.stringify({
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'ok' }]
        }
      ]
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    await client.complete(
      createConnection('https://jb-foundry.services.ai.azure.com/api/projects/proj1/openai/v1/responses'),
      [{ role: 'user', content: 'hello' }],
      { reasoningEffort: 'medium' }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  const parsed = JSON.parse(requestBody);
  assert.deepEqual(parsed.reasoning, { effort: 'medium', summary: 'auto' });
  assert.equal(Object.hasOwn(parsed, 'temperature'), false);
});

test('azure chat client uses responses API for v1 endpoints when reasoning is enabled', async () => {
  const client = new AzureOpenAiChatClient(() => 'test-key');
  const originalFetch = globalThis.fetch;
  let requestUrl = '';
  let requestBody = '';

  globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    requestBody = String(init?.body ?? '');
    return new Response(JSON.stringify({
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'ok' }]
        },
        {
          type: 'reasoning_summary',
          content: [{ type: 'summary_text', text: 'Reasoning summary here.' }]
        }
      ]
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    await client.complete(
      createConnection('https://example.openai.azure.com/openai/v1'),
      [{ role: 'user', content: 'hello' }],
      { reasoningEffort: 'medium' }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requestUrl, 'https://example.openai.azure.com/openai/v1/responses');
  const parsed = JSON.parse(requestBody);
  assert.equal(parsed.model, 'gpt-4.1');
  assert.equal(Array.isArray(parsed.input), true);
  assert.equal(parsed.max_output_tokens, 1200);
  assert.deepEqual(parsed.reasoning, { effort: 'medium', summary: 'auto' });
  assert.equal(Object.hasOwn(parsed, 'messages'), false);
});

test('azure chat client prefers explicit temperature and max token overrides', async () => {
  const client = new AzureOpenAiChatClient(() => 'test-key');
  const originalFetch = globalThis.fetch;
  let requestBody = '';

  globalThis.fetch = async (_input, init) => {
    requestBody = String(init?.body ?? '');
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    await client.complete(
      {
        ...createConnection('https://example.openai.azure.com/openai/v1'),
        temperature: 0.4,
        maxTokens: 600
      },
      [{ role: 'user', content: 'hello' }],
      { temperature: 1.1, maxTokens: 321 }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  const parsed = JSON.parse(requestBody);
  assert.equal(parsed.temperature, 1.1);
  assert.equal(parsed.max_completion_tokens, 321);
  assert.equal(Object.hasOwn(parsed, 'max_tokens'), false);
});

test('azure chat client keeps legacy max_tokens for non-v1 endpoints', async () => {
  const client = new AzureOpenAiChatClient(() => 'test-key');
  const originalFetch = globalThis.fetch;
  let requestBody = '';

  globalThis.fetch = async (_input, init) => {
    requestBody = String(init?.body ?? '');
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    await client.complete(
      {
        ...createConnection('https://example.openai.azure.com'),
        maxTokens: 600
      },
      [{ role: 'user', content: 'hello' }],
      { maxTokens: 321 }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  const parsed = JSON.parse(requestBody);
  assert.equal(parsed.max_tokens, 321);
  assert.equal(Object.hasOwn(parsed, 'max_completion_tokens'), false);
});

test('azure chat client concatenates assistant text fragments from responses payloads', async () => {
  const client = new AzureOpenAiChatClient(() => 'test-key');
  const originalFetch = globalThis.fetch;
  let result: string | undefined;

  globalThis.fetch = async () => new Response(JSON.stringify({
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'output_text', text: 'First chunk. ' },
          { type: 'output_text', text: 'Second chunk.' }
        ]
      }
    ]
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });

  try {
    result = await client.complete(createConnection('https://jb-foundry.services.ai.azure.com/api/projects/proj1/openai/v1/responses'), [{ role: 'user', content: 'hello' }]) ?? undefined;
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(result, 'First chunk. Second chunk.');
});

test('azure chat client keeps text-bearing assistant content beyond output_text', async () => {
  const client = new AzureOpenAiChatClient(() => 'test-key');
  const originalFetch = globalThis.fetch;
  let result: string | undefined;

  globalThis.fetch = async () => new Response(JSON.stringify({
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'summary_text', text: 'Summary intro. ' },
          { type: 'text', text: 'Fallback body.' }
        ]
      }
    ]
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });

  try {
    result = await client.complete(createConnection('https://jb-foundry.services.ai.azure.com/api/projects/proj1/openai/v1/responses'), [{ role: 'user', content: 'hello' }]) ?? undefined;
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(result, 'Summary intro. Fallback body.');
});

test('azure chat client extracts reasoning summary text from responses payloads', async () => {
  const client = new AzureOpenAiChatClient(() => 'test-key');
  const originalFetch = globalThis.fetch;
  let result;

  globalThis.fetch = async () => new Response(JSON.stringify({
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Final answer.' }]
      },
      {
        type: 'reasoning_summary',
        content: [{ type: 'summary_text', text: 'Reasoning summary here.' }]
      }
    ]
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });

  try {
    result = await client.completeWithTools(
      createConnection('https://jb-foundry.services.ai.azure.com/api/projects/proj1/openai/v1/responses'),
      [{ role: 'user', content: 'hello' }]
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(result.content, 'Final answer.');
  assert.equal(result.reasoning, 'Reasoning summary here.');
});

test('azure chat client streams assistant text and reasoning deltas from responses SSE', async () => {
  const client = new AzureOpenAiChatClient(() => 'test-key');
  const originalFetch = globalThis.fetch;
  const seenText: string[] = [];
  const seenReasoning: string[] = [];

  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode('data: {"type":"response.output_text.delta","delta":"Hel"}\n\n'));
      controller.enqueue(encoder.encode('data: {"type":"response.output_text.delta","delta":"lo"}\n\n'));
      controller.enqueue(encoder.encode('data: {"type":"response.reasoning_summary_text.delta","delta":"Think"}\n\n'));
      controller.enqueue(encoder.encode('data: {"type":"response.reasoning_summary_text.delta","delta":"ing"}\n\n'));
      controller.enqueue(encoder.encode('data: {"type":"response.completed"}\n\n'));
      controller.close();
    }
  }), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' }
  });

  try {
    for await (const chunk of client.completeWithToolsStream(
      createConnection('https://jb-foundry.services.ai.azure.com/api/projects/proj1/openai/v1/responses'),
      [{ role: 'user', content: 'hello' }]
    )) {
      if (chunk.type === 'text') {
        seenText.push(chunk.text);
      } else if (chunk.type === 'reasoning') {
        seenReasoning.push(chunk.text);
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(seenText, ['Hel', 'lo']);
  assert.deepEqual(seenReasoning, ['Think', 'ing']);
});

test('azure chat client falls back to non-stream request when responses stream reports model invalid content', async () => {
  const client = new AzureOpenAiChatClient(() => 'test-key');
  const originalFetch = globalThis.fetch;
  const seenText: string[] = [];
  let callCount = 0;

  globalThis.fetch = async (_input, init) => {
    callCount += 1;

    if (callCount === 1) {
      return new Response(new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode('data: {"type":"response.failed","response":{"error":{"message":"The model produced invalid content. See https://aka.ms/model-error"}}}\n\n'));
          controller.close();
        }
      }), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' }
      });
    }

    const parsedBody = JSON.parse(String(init?.body ?? '{}')) as { stream?: boolean; input?: unknown[] };
    assert.equal(parsedBody.stream, false);
    assert.equal(Array.isArray(parsedBody.input), true);

    return new Response(JSON.stringify({
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Recovered answer.' }]
        }
      ]
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    for await (const chunk of client.completeWithToolsStream(
      createConnection('https://jb-foundry.services.ai.azure.com/api/projects/proj1/openai/v1/responses'),
      [{ role: 'user', content: 'hello' }]
    )) {
      if (chunk.type === 'text') {
        seenText.push(chunk.text);
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(callCount, 2);
  assert.deepEqual(seenText, ['Recovered answer.']);
});