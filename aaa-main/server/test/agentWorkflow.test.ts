import assert from 'node:assert/strict';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { AaaAgentLoop, repairEscapedNewlines } from '../aaaAgentLoop.js';
import type { ModelChatClient, ModelStreamChunk, ResolvedModelConnection } from '../modelTypes.js';
import { ProjectCustomizationService } from '../projectCustomizationService.js';
import { ProjectFileService } from '../projectFileService.js';
import { ProjectWorkflowService } from '../projectWorkflowService.js';
import { builtInToolCatalog, builtInToolItemId, builtInToolNameFromItemId } from '../builtInTools.js';

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
  assert.deepEqual([...tools.builtIns].sort(), builtInToolCatalog.map((tool) => tool.name).sort());
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

test('new enabled MCP servers are exposed without editing existing agent tools', async (t) => {
  await freshProject();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, '.vscode', 'mcp.json'), JSON.stringify({
    servers: {
      'mcp-publisher': { type: 'http', url: 'http://localhost:3000/mcp' },
      'dynamic-evidence': { type: 'http', url: 'http://localhost:3001/mcp' }
    }
  }), 'utf8');

  const workflow = await new ProjectWorkflowService('demo', root).load();
  const tools = ProjectWorkflowService.selectTools(workflow, ProjectWorkflowService.resolveAgent(workflow));

  assert.deepEqual(tools.mcpServers.map((server) => server.name), ['mcp-publisher', 'dynamic-evidence']);
  assert.equal(tools.allowMcpTool('dynamic-evidence', 'collect_evidence'), true);
});

test('capability tests report built-in availability and list MCP tools without exposing configuration', async (t) => {
  await freshProject();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, '.vscode', 'mcp.json'), JSON.stringify({
    servers: {
      evidence: {
        type: 'http',
        url: 'https://example.test/mcp',
        headers: { Authorization: 'Bearer ${env:MCP_TEST_TOKEN}' }
      }
    }
  }), 'utf8');

  const requests: string[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { id?: number; method: string };
    requests.push(body.method);
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (body.method === 'initialize') {
      return Response.json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18' } });
    }
    return Response.json({
      jsonrpc: '2.0',
      id: body.id,
      result: {
        tools: [{
          name: 'collect_evidence',
          description: 'Collect approved evidence.',
          inputSchema: { type: 'object', properties: { control: { type: 'string', description: 'Control id.' } }, required: ['control'] }
        }]
      }
    });
  };
  const service = new ProjectWorkflowService('demo', root, { MCP_TEST_TOKEN: 'secret' });

  const builtIn = await service.testCapability('tool:read-file', fetchImpl);
  assert.equal(builtIn.ok, true);
  assert.match(builtIn.summary, /registered and available/);

  const mcp = await service.testCapability('mcp-server:evidence', fetchImpl);
  assert.equal(mcp.ok, true);
  assert.deepEqual(mcp.tools, [{
    name: 'collect_evidence',
    description: 'Collect approved evidence.',
    parameters: [{ name: 'control', type: 'string', required: true, description: 'Control id.' }]
  }]);
  assert.deepEqual(requests, ['initialize', 'notifications/initialized', 'tools/list']);
  assert.doesNotMatch(JSON.stringify(mcp), /secret|example\.test/);

  const unavailable = await service.testCapability(
    'mcp-server:evidence',
    async () => { throw new Error('connection refused with secret'); }
  );
  assert.equal(unavailable.ok, false);
  assert.match(unavailable.summary, /connection test failed: MCP server evidence could not be reached at example\.test\./);
  assert.doesNotMatch(unavailable.summary, /secret/);

  const rejected = await service.testCapability('mcp-server:evidence', async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { id?: number; method: string };
    if (body.method === 'initialize') {
      return Response.json({
        jsonrpc: '2.0',
        id: body.id,
        error: { code: -32000, message: 'Rejected Bearer secret-token' }
      });
    }
    return new Response(null, { status: 202 });
  });
  assert.equal(rejected.ok, false);
  assert.doesNotMatch(rejected.summary, /secret-token|Bearer/);
});

test('new enabled agents and skills are exposed without editing existing customizations', async (t) => {
  await freshProject();
  t.after(() => rm(root, { recursive: true, force: true }));
  const customizations = new ProjectCustomizationService('demo', root);
  await customizations.create({
    kind: 'agent',
    name: 'Dynamic Reviewer',
    description: 'Reviews dynamically added evidence.',
    argumentHint: 'Name an artifact',
    tools: 'read',
    instructions: '# Dynamic Reviewer\n\nReview only grounded project evidence.',
    enabled: true
  });
  await customizations.create({
    kind: 'skill',
    name: 'Dynamic Evidence Review',
    description: 'Reviews evidence added after project creation.',
    argumentHint: 'Name an evidence file',
    instructions: '# Dynamic Evidence Review\n\nRead and review the requested evidence.',
    enabled: true
  });

  const workflowService = new ProjectWorkflowService('demo', root);
  const workflow = await workflowService.load();
  const summary = await workflowService.summary();
  const agent = ProjectWorkflowService.resolveAgent(workflow, 'dynamic-reviewer');
  const tools = ProjectWorkflowService.selectTools(workflow, agent);
  const system = ProjectWorkflowService.systemPrompt({
    projectName: 'Demo',
    agent,
    skills: workflow.skills,
    tools
  });

  assert.equal(agent?.name, 'Dynamic Reviewer');
  assert.ok(summary.agents.some((candidate) => candidate.id === 'dynamic-reviewer'));
  assert.ok(workflow.skills.some((skill) => skill.id === 'dynamic-evidence-review'));
  assert.ok(summary.commands.some((command) =>
    command.kind === 'skill' && command.name === 'dynamic-evidence-review'));
  assert.equal(tools.builtIns.has('load_skill'), true);
  assert.match(system, /- dynamic-evidence-review: Reviews evidence added after project creation\./);
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

test('agent frontmatter tools never narrow the enabled tool surface', async (t) => {
  await freshProject();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, '.github', 'agents', 'narrow.agent.md'),
    '---\nname: "Narrow"\ndescription: "Declares only read"\ntools: [read, mcp-publisher/only_one]\n---\n\n# Narrow\n', 'utf8');
  const workflow = await new ProjectWorkflowService('demo', root).load();
  const agent = ProjectWorkflowService.resolveAgent(workflow, 'narrow');
  assert.equal(agent?.name, 'Narrow');
  const tools = ProjectWorkflowService.selectTools(workflow, agent);
  assert.deepEqual([...tools.builtIns].sort(), builtInToolCatalog.map((tool) => tool.name).sort());
  assert.deepEqual(tools.mcpServers.map((server) => server.name), ['mcp-publisher']);
  assert.equal(tools.allowMcpTool('mcp-publisher', 'any_other_tool'), true);
});

test('every registered built-in tool is listed, enabled by default, and exposed by the loop', async (t) => {
  await freshProject();
  t.after(() => rm(root, { recursive: true, force: true }));
  const items = (await new ProjectCustomizationService('demo', root).list()).items.filter((item) => item.kind === 'tool');
  assert.deepEqual(items.map((item) => item.id).sort(), builtInToolCatalog.map((tool) => builtInToolItemId(tool.name)).sort());
  assert.ok(items.every((item) => item.enabled));

  const workflow = await new ProjectWorkflowService('demo', root).load();
  assert.equal(workflow.enabledTools.size, builtInToolCatalog.length);

  const seen: string[][] = [];
  const client: ModelChatClient = {
    async *stream(_connection, _messages, _signal, tools) {
      seen.push((tools ?? []).map((tool) => tool.function.name));
      yield { type: 'assistant_text', text: 'ok' };
      yield { type: 'completed' };
    }
  };
  await new AaaAgentLoop(client, new ProjectFileService(root), {
    tools: workflow.enabledTools,
    skills: workflow.skills
  }).run(connection, [{ role: 'user', content: 'hi' }], new AbortController().signal);
  assert.deepEqual(seen[0]!.sort(), builtInToolCatalog.map((tool) => tool.name).sort());
});

test('tool item ids map every underscore so multi-word tools keep their enabled state', () => {
  assert.equal(builtInToolItemId('fetch_url_as_json'), 'tool:fetch-url-as-json');
  assert.equal(builtInToolNameFromItemId('tool:fetch-url-as-json'), 'fetch_url_as_json');
  for (const tool of builtInToolCatalog) {
    assert.equal(builtInToolNameFromItemId(builtInToolItemId(tool.name)), tool.name);
  }
});

test('only an explicit disable removes a tool, and unusable MCP servers are reported instead of dropped', async (t) => {
  await freshProject();
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.aaa'), { recursive: true });
  await writeFile(path.join(root, '.aaa', 'customizations.json'), JSON.stringify({
    enabled: { 'tool:browser-capture': false },
    metadata: {}
  }), 'utf8');
  await writeFile(path.join(root, '.vscode', 'mcp.json'), JSON.stringify({
    servers: {
      'mcp-publisher': { type: 'http', url: 'http://localhost:3000/mcp' },
      local: { type: 'stdio', command: 'node', args: ['server.js'] }
    }
  }), 'utf8');
  const workflow = await new ProjectWorkflowService('demo', root).load();
  const tools = ProjectWorkflowService.selectTools(workflow, ProjectWorkflowService.resolveAgent(workflow));
  assert.equal(tools.builtIns.has('browser_capture'), false);
  assert.equal(tools.builtIns.size, builtInToolCatalog.length - 1);
  assert.deepEqual(tools.mcpServers.map((server) => server.name), ['mcp-publisher']);
  assert.deepEqual(tools.unavailableMcpServers.map((server) => server.name), ['local']);
  assert.match(tools.unavailableMcpServers[0]!.reason ?? '', /Streamable HTTP/);
});
