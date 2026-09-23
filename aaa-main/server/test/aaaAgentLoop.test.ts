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
