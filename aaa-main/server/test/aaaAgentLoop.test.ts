import assert from 'node:assert/strict';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { AaaAgentLoop } from '../aaaAgentLoop.js';
import type { ModelChatClient, ResolvedModelConnection } from '../modelTypes.js';
import { ProjectFileService } from '../projectFileService.js';

const root = path.join(process.cwd(), '.test-data', 'aaa-agent-loop');

const connection: ResolvedModelConnection = {
  definition: {
    id: 'test',
    name: 'Test',
    type: 'azure-openai',
    endpointEnv: 'ENDPOINT',
    deploymentEnv: 'DEPLOYMENT'
  },
  endpoint: 'https://example.test',
  deployment: 'test',
  apiVersion: '2025-01-01-preview'
};

test('agent loop executes model-requested file tools and reports reasoning and steps', async () => {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  let round = 0;
  const client: ModelChatClient = {
    async *stream(_connection, messages, _signal, tools) {
      round += 1;
      assert.ok(tools?.some((tool) => tool.function.name === 'write_file'));
      if (round === 1) {
        yield { type: 'reasoning', text: 'Create the requested smoke-test file.' };
        yield {
          type: 'tool_calls',
          calls: [{
            id: 'call-1',
            type: 'function',
            function: {
              name: 'write_file',
              arguments: JSON.stringify({ path: 'test.md', content: '# Agent smoke test\n' })
            }
          }]
        };
        yield { type: 'completed' };
        return;
      }

      const toolResult = messages.at(-1);
      assert.equal(toolResult?.role, 'tool');
      assert.match(toolResult?.content ?? '', /Created test\.md/);
      yield { type: 'assistant_text', text: 'Created test.md.' };
      yield { type: 'completed' };
    }
  };

  const reasoning: string[] = [];
  const events: string[] = [];
  try {
    const result = await new AaaAgentLoop(client, new ProjectFileService(root)).run(
      connection,
      [{ role: 'user', content: 'Create test.md.' }],
      new AbortController().signal,
      {
        onReasoning: (text) => { reasoning.push(text); },
        onToolEvent: (event) => { events.push(event.label); }
      }
    );

    assert.equal(await readFile(path.join(root, 'test.md'), 'utf8'), '# Agent smoke test\n');
    assert.equal(result.content, 'Created test.md.');
    assert.equal(result.reasoning, 'Create the requested smoke-test file.');
    assert.deepEqual(result.changedFiles, ['test.md']);
    assert.deepEqual(reasoning, ['Create the requested smoke-test file.']);
    assert.deepEqual(events, ['Created project file']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('agent loop aggregates reported usage across rounds and estimates unreported requests', async () => {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  let round = 0;
  const client: ModelChatClient = {
    async *stream() {
      round += 1;
      if (round === 1) {
        yield { type: 'tool_calls', calls: [{ id: 'c1', type: 'function', function: { name: 'list_files', arguments: '{}' } }] };
        yield { type: 'usage', usage: { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 30, reasoningTokens: 10, totalTokens: 1030 } };
        yield { type: 'completed' };
        return;
      }
      yield { type: 'assistant_text', text: 'Listed.' };
      yield { type: 'usage', usage: { inputTokens: 1100, cachedInputTokens: 1024, outputTokens: 5, reasoningTokens: 0, totalTokens: 1105 } };
      yield { type: 'completed' };
    }
  };
  const snapshots: number[] = [];
  try {
    const result = await new AaaAgentLoop(client, new ProjectFileService(root)).run(
      connection,
      [{ role: 'user', content: 'List files.' }],
      new AbortController().signal,
      { onUsage: (usage) => { snapshots.push(usage.requests); } }
    );
    assert.deepEqual(result.usage, {
      inputTokens: 2100,
      cachedInputTokens: 1024,
      outputTokens: 35,
      reasoningTokens: 10,
      totalTokens: 2135,
      requests: 2,
      promptTokens: 1000,
      peakInputTokens: 1100,
      estimated: false
    });
    assert.deepEqual(snapshots, [1, 2]);

    const unreported: ModelChatClient = {
      async *stream() {
        yield { type: 'assistant_text', text: 'No usage here.' };
        yield { type: 'completed' };
      }
    };
    const estimated = await new AaaAgentLoop(unreported, new ProjectFileService(root)).run(
      connection,
      [{ role: 'user', content: 'Hello' }],
      new AbortController().signal
    );
    assert.equal(estimated.usage.estimated, true);
    assert.ok(estimated.usage.inputTokens > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('agent loop trims the oldest seen tool outputs when a run nears the context window', async () => {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const big = 'x'.repeat(20_000);
  const seen: string[][] = [];
  let round = 0;
  const client: ModelChatClient = {
    async *stream(_connection, messages) {
      round += 1;
      seen.push(messages.filter((message) => message.role === 'tool').map((message) => message.content.slice(0, 40)));
      if (round <= 3) {
        yield { type: 'tool_calls', calls: [{ id: `c${round}`, type: 'function', function: { name: 'read_file', arguments: '{"path":"big.txt"}' } }] };
        yield { type: 'completed' };
        return;
      }
      yield { type: 'assistant_text', text: 'Done.' };
      yield { type: 'completed' };
    }
  };
  const labels: string[] = [];
  try {
    const files = new ProjectFileService(root);
    await files.createTextFile('big.txt', big);
    const result = await new AaaAgentLoop(client, files).run(
      { ...connection, definition: { ...connection.definition, contextWindow: 12_000, compaction: { threshold: 0.8 } } },
      [{ role: 'user', content: 'Read big.txt three times.' }],
      new AbortController().signal,
      { onToolEvent: (event) => { labels.push(event.label); } }
    );
    assert.equal(result.content, 'Done.');
    assert.ok(labels.includes('Trimmed earlier tool output'));
    const final = seen.at(-1)!;
    assert.equal(final.length, 3);
    assert.match(final[0]!, /^\[AAA removed this earlier tool output/);
    assert.doesNotMatch(final.at(-1)!, /^\[AAA removed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('agent loop asks for context relief before the first request and counts it as auxiliary usage', async () => {
  let firstRequest: string[] = [];
  const client: ModelChatClient = {
    async *stream(_connection, messages) {
      firstRequest = messages.map((message) => message.content);
      yield { type: 'assistant_text', text: 'Continuing.' };
      yield { type: 'usage', usage: { inputTokens: 300, cachedInputTokens: 0, outputTokens: 5, reasoningTokens: 0, totalTokens: 305 } };
      yield { type: 'completed' };
    }
  };
  let pressure: { estimate: number; budget: number } | undefined;
  const result = await new AaaAgentLoop(client, new ProjectFileService(process.cwd()), {
    tools: [],
    onContextPressure: async (estimate, budget) => {
      pressure = { estimate, budget };
      return {
        messages: [{ role: 'system', content: 'summary' }, { role: 'user', content: 'latest' }],
        usage: { inputTokens: 5000, cachedInputTokens: 0, outputTokens: 400, reasoningTokens: 0, totalTokens: 5400 }
      };
    }
  }).run(
    { ...connection, definition: { ...connection.definition, contextWindow: 2_000 } },
    [{ role: 'user', content: 'y'.repeat(10_000) }, { role: 'user', content: 'latest' }],
    new AbortController().signal
  );
  assert.ok(pressure && pressure.estimate > pressure.budget);
  assert.deepEqual(firstRequest, ['summary', 'latest']);
  assert.equal(result.usage.requests, 2);
  assert.equal(result.usage.inputTokens, 5300);
  assert.equal(result.usage.promptTokens, 300);
  assert.equal(result.usage.peakInputTokens, 300);
});
