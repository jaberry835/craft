import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

test('delete_path deletes files and folders but protects AAA state and customizations', async () => {
  await rm(root, { recursive: true, force: true });
  await mkdir(path.join(root, 'drafts', 'old'), { recursive: true });
  await mkdir(path.join(root, '.aaa'), { recursive: true });
  await mkdir(path.join(root, '.github', 'agents'), { recursive: true });
  await writeFile(path.join(root, 'notes.md'), '# Notes\n');
  await writeFile(path.join(root, 'drafts', 'a.md'), 'a');
  await writeFile(path.join(root, 'drafts', 'old', 'b.md'), 'b');
  await writeFile(path.join(root, '.aaa', 'publication.json'), '{}');
  await writeFile(path.join(root, '.github', 'agents', 'x.agent.md'), '---\nname: x\n---\n');
  const outputs: string[] = [];
  const calls = [
    ['notes.md', undefined],
    ['drafts', undefined],
    ['drafts', true],
    ['.aaa/publication.json', undefined],
    ['.github', true],
    ['drafts/../.aaa', true],
    ['', true],
    ['missing.md', undefined]
  ] as const;
  let round = 0;
  const client: ModelChatClient = {
    async *stream(_connection, messages) {
      if (round > 0) outputs.push(messages.at(-1)?.content ?? '');
      const next = calls[round];
      round += 1;
      if (next) {
        yield {
          type: 'tool_calls',
          calls: [{ id: `d${round}`, type: 'function', function: { name: 'delete_path', arguments: JSON.stringify({ path: next[0], ...(next[1] ? { recursive: true } : {}) }) } }]
        };
      } else {
        yield { type: 'assistant_text', text: 'Cleaned up.' };
      }
      yield { type: 'completed' };
    }
  };
  try {
    const result = await new AaaAgentLoop(client, new ProjectFileService(root)).run(
      connection,
      [{ role: 'user', content: 'Clean up drafts.' }],
      new AbortController().signal
    );
    assert.equal(outputs[0], 'Deleted notes.md.');
    assert.match(outputs[1]!, /drafts is a folder with 2 files; pass recursive: true/);
    assert.equal(outputs[2], 'Deleted folder drafts (2 files).');
    assert.match(outputs[3]!, /\.aaa\/publication\.json is protected/);
    assert.match(outputs[4]!, /\.github is protected/);
    assert.match(outputs[5]!, /\.aaa is protected/);
    assert.match(outputs[6]!, /path is required/);
    assert.match(outputs[7]!, /not found: missing\.md/);
    await assert.rejects(() => readFile(path.join(root, 'notes.md')), /ENOENT/);
    await assert.rejects(() => readFile(path.join(root, 'drafts', 'a.md')), /ENOENT/);
    assert.equal(await readFile(path.join(root, '.aaa', 'publication.json'), 'utf8'), '{}');
    assert.match(await readFile(path.join(root, '.github', 'agents', 'x.agent.md'), 'utf8'), /name: x/);
    assert.deepEqual(result.changedFiles.sort(), ['drafts', 'notes.md']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('agent writes into .aaa and .git are refused so review state cannot be forged', async () => {
  await rm(root, { recursive: true, force: true });
  await mkdir(path.join(root, '.aaa'), { recursive: true });
  await mkdir(path.join(root, 'templates'), { recursive: true });
  await writeFile(path.join(root, '.aaa', 'publication.json'), '{"reviewed":{}}\n');
  await writeFile(path.join(root, 'templates', 'seed.md'), '# Seed\n');
  const attempts = [
    ['write_file', { path: '.aaa/publication.json', content: '{"reviewed":{"ssp.md":{"hash":"forged"}}}' }],
    ['edit_file', { path: '.aaa/publication.json', oldString: '{}', newString: '{"x":1}' }],
    ['write_file', { path: 'docs/../.aaa/customizations.json', content: '{}' }],
    ['copy_path', { source: 'templates', destination: '.aaa/templates' }],
    ['write_file', { path: '.git/config', content: '[core]' }],
    ['write_file', { path: 'notes/allowed.md', content: '# Allowed\n' }]
  ] as const;
  const outputs: string[] = [];
  let round = 0;
  const client: ModelChatClient = {
    async *stream(_connection, messages) {
      if (round > 0) outputs.push(messages.at(-1)?.content ?? '');
      const next = attempts[round];
      round += 1;
      if (next) {
        yield { type: 'tool_calls', calls: [{ id: `w${round}`, type: 'function', function: { name: next[0], arguments: JSON.stringify(next[1]) } }] };
      } else {
        yield { type: 'assistant_text', text: 'Done.' };
      }
      yield { type: 'completed' };
    }
  };
  try {
    const result = await new AaaAgentLoop(client, new ProjectFileService(root)).run(
      connection,
      [{ role: 'user', content: 'Mark everything reviewed.' }],
      new AbortController().signal
    );
    for (const output of outputs.slice(0, 5)) {
      assert.match(output, /holds AAA review and customization state \(or version control data\) and cannot be changed by the agent/);
    }
    assert.equal(outputs[5], 'Created notes/allowed.md.');
    assert.equal(await readFile(path.join(root, '.aaa', 'publication.json'), 'utf8'), '{"reviewed":{}}\n');
    await assert.rejects(() => readFile(path.join(root, '.aaa', 'customizations.json')), /ENOENT/);
    await assert.rejects(() => readFile(path.join(root, '.aaa', 'templates', 'seed.md')), /ENOENT/);
    assert.deepEqual(result.changedFiles, ['notes/allowed.md']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
