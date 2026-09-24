import assert from 'node:assert/strict';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { AaaAgentLoop, repairEscapedNewlines } from '../aaaAgentLoop.js';
import type { ModelChatClient, ModelStreamChunk, ResolvedModelConnection } from '../modelTypes.js';
import { ProjectFileService } from '../projectFileService.js';
import { ProjectWorkflowService } from '../projectWorkflowService.js';

const root = path.join(process.cwd(), '.test-data', 'agent-workflow');
const templateRoot = path.join(process.cwd(), 'templates', 'default-project');

const connection: ResolvedModelConnection = {
  definition: { id: 'test', name: 'Test', type: 'azure-openai', endpointEnv: 'E', deploymentEnv: 'D' },
  endpoint: 'https://example.test',
  deployment: 'test',
  apiVersion: 'v'
};

function scriptedClient(rounds: ModelStreamChunk[][], seen: Array<{ tools: string[]; system: string }> = []): ModelChatClient {
  let round = 0;
  return {
    async *stream(_connection, messages, _signal, tools) {
      seen.push({
        tools: (tools ?? []).map((tool) => tool.function.name),
        system: messages.find((message) => message.role === 'system')?.content ?? ''
      });
      const chunks = rounds[round] ?? [{ type: 'assistant_text', text: 'Done.' }, { type: 'completed' }];
      round += 1;
      for (const chunk of chunks) yield chunk;
    }
  };
}

const call = (id: string, name: string, args: unknown): ModelStreamChunk => ({
  type: 'tool_calls',
  calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }]
});

async function freshProject(): Promise<string> {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  await cp(templateRoot, root, { recursive: true });
  return root;
}

test('escaped newline repair only applies to prose formats without real line breaks', () => {
  assert.equal(repairEscapedNewlines('a.md', '# Title\\n\\n- item \\"quoted\\"'), '# Title\n\n- item "quoted"');
  assert.equal(repairEscapedNewlines('a.md', '# Title\n\nAlready fine \\n'), '# Title\n\nAlready fine \\n');
  assert.equal(repairEscapedNewlines('a.json', '{"a":"x\\ny"}'), '{"a":"x\\ny"}');
  assert.equal(repairEscapedNewlines('a.md', 'Path C:\\dev\\new folder'), 'Path C:\\dev\\new folder');
});

test('agent loop repairs double-escaped Markdown and separates text between rounds', async (t) => {
  await freshProject();
  t.after(() => rm(root, { recursive: true, force: true }));
  const client = scriptedClient([
    [
      { type: 'assistant_text', text: 'Creating the file.' },
      call('1', 'write_file', { path: 'notes.md', content: '# AU-2\\n\\n## Requirement\\n\\n- one\\n- two\\n' }),
      { type: 'completed' }
    ],
    [{ type: 'assistant_text', text: 'Created notes.md.' }, { type: 'completed' }]
  ]);
  const result = await new AaaAgentLoop(client, new ProjectFileService(root)).run(
    connection,
    [{ role: 'user', content: 'Write notes.' }],
    new AbortController().signal
  );
  assert.equal(await readFile(path.join(root, 'notes.md'), 'utf8'), '# AU-2\n\n## Requirement\n\n- one\n- two\n');
  assert.equal(result.content, 'Creating the file.\n\nCreated notes.md.');
});

test('workflow exposes agent instructions, skills, prompts, and agent-scoped tools', async (t) => {
  await freshProject();
  t.after(() => rm(root, { recursive: true, force: true }));
  const workflow = await new ProjectWorkflowService('demo', root).load();
  assert.deepEqual(workflow.agents.map((agent) => agent.id), ['security-package-builder']);
  assert.ok(workflow.skills.some((skill) => skill.id === 'initialize-security-package'));
  assert.deepEqual(workflow.prompts.map((prompt) => prompt.id), ['build-security-package']);
  assert.deepEqual(workflow.mcpServers.map((server) => server.name), ['mcp-publisher']);

  const agent = ProjectWorkflowService.resolveAgent(workflow);
  assert.equal(agent?.name, 'Security Package Builder');
  const tools = ProjectWorkflowService.selectTools(workflow, agent);
  assert.deepEqual([...tools.builtIns].sort(), [
    'browser_capture', 'copy_path', 'edit_file', 'list_files', 'load_skill', 'read_file', 'search_files', 'write_file'
  ]);
  assert.deepEqual(tools.mcpServers.map((server) => server.name), ['mcp-publisher']);

  const system = ProjectWorkflowService.systemPrompt({ projectName: 'Demo', agent, skills: workflow.skills, tools });
  assert.match(system, /Active agent: Security Package Builder/);
  assert.match(system, /- analyze-security-control:/);
  assert.match(system, /aaa-file:/);

  const prompt = ProjectWorkflowService.expandCommand(workflow, '/build-security-package AU-2 SC-7');
  assert.equal(prompt.command?.kind, 'prompt');
  assert.equal(prompt.agentId, 'Security Package Builder');
  assert.match(prompt.content, /User input: AU-2 SC-7/);
  const skill = ProjectWorkflowService.expandCommand(workflow, '/initialize-security-package AU SC');
  assert.equal(skill.command?.kind, 'skill');
  assert.match(skill.content, /load_skill/);
  assert.equal(ProjectWorkflowService.expandCommand(workflow, 'no command').content, 'no command');
});

test('disabled customizations are removed from the tool surface', async (t) => {
  await freshProject();
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.aaa'), { recursive: true });
  await writeFile(path.join(root, '.aaa', 'customizations.json'), JSON.stringify({
    enabled: { 'tool:write-file': false, 'mcp-server:mcp-publisher': false, 'skill:collect-artifact-links': false },
    metadata: {}
  }), 'utf8');
  const workflow = await new ProjectWorkflowService('demo', root).load();
  const tools = ProjectWorkflowService.selectTools(workflow, ProjectWorkflowService.resolveAgent(workflow));
  assert.equal(tools.builtIns.has('write_file'), false);
  assert.equal(tools.mcpServers.length, 0);
  assert.equal(workflow.skills.some((skill) => skill.id === 'collect-artifact-links'), false);
});

test('initialize skill runs through load_skill and copy_path without scripts', async (t) => {
  await freshProject();
  t.after(() => rm(root, { recursive: true, force: true }));
  const workflow = await new ProjectWorkflowService('demo', root).load();
  const seen: Array<{ tools: string[]; system: string }> = [];
  const templatePath = '.github/skills/initialize-security-package/assets/security-package-template';
  const client = scriptedClient([
    [call('1', 'load_skill', { name: 'initialize-security-package' }), { type: 'completed' }],
    [call('2', 'copy_path', { source: templatePath, destination: 'packages/demo' }), { type: 'completed' }],
    [call('3', 'copy_path', { source: templatePath, destination: 'packages/demo' }), { type: 'completed' }],
    [call('4', 'search_files', { query: 'evidence register', path: 'packages/demo' }), { type: 'completed' }]
  ], seen);
  const events: string[] = [];
  const outputs: string[] = [];
  const loop = new AaaAgentLoop(client, new ProjectFileService(root), { skills: workflow.skills });
  const result = await loop.run(connection, [{ role: 'user', content: 'init' }], new AbortController().signal, {
    onToolEvent: (event) => { events.push(`${event.type}:${event.label}`); }
  });
  void outputs;
  assert.ok(seen[0]!.tools.includes('load_skill'));
  assert.deepEqual(events, [
    'skill:Loaded skill',
    'create:Copied project files',
    'create:Copied project files',
    'search:Searched project files'
  ]);
  const config = JSON.parse(await readFile(path.join(root, 'packages', 'demo', 'package-config.json'), 'utf8')) as {
    controlFamilies: string[];
  };
  assert.deepEqual(config.controlFamilies, []);
  assert.ok(result.changedFiles.includes('packages/demo/standard-docs/evidence-register.md'));
});

test('stop is honored before queued tool calls run', async (t) => {
  await freshProject();
  t.after(() => rm(root, { recursive: true, force: true }));
  const controller = new AbortController();
  const client: ModelChatClient = {
    async *stream() {
      yield {
        type: 'tool_calls',
        calls: [
          { id: '1', type: 'function', function: { name: 'read_file', arguments: '{"path":"security-package/README.md"}' } },
          { id: '2', type: 'function', function: { name: 'write_file', arguments: '{"path":"after-stop.md","content":"x"}' } }
        ]
      };
      yield { type: 'completed' };
    }
  };
  const loop = new AaaAgentLoop(client, new ProjectFileService(root));
  await assert.rejects(() => loop.run(connection, [{ role: 'user', content: 'go' }], controller.signal, {
    onToolEvent: () => { controller.abort(new DOMException('Stopped', 'AbortError')); }
  }), /Stopped/);
  await assert.rejects(() => readFile(path.join(root, 'after-stop.md'), 'utf8'), { code: 'ENOENT' });
});

test('agent run time limit produces an actionable error', async (t) => {
  await freshProject();
  t.after(() => rm(root, { recursive: true, force: true }));
  const client: ModelChatClient = {
    async *stream(_connection, _messages, signal) {
      await new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }));
      yield { type: 'completed' };
    }
  };
  await assert.rejects(
    () => new AaaAgentLoop(client, new ProjectFileService(root), { timeoutMs: 50 })
      .run(connection, [{ role: 'user', content: 'go' }], new AbortController().signal),
    /time limit/
  );
});
