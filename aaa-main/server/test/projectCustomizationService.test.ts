import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { ProjectCustomizationService } from '../projectCustomizationService.js';
import { builtInToolCatalog } from '../builtInTools.js';

const testRoot = path.join(process.cwd(), '.test-data', 'project-customizations');

test('customizations discover project agents, skills, instructions, MCP servers, and tools', async (t) => {
  await rm(testRoot, { recursive: true, force: true });
  t.after(() => rm(testRoot, { recursive: true, force: true }));

  await mkdir(path.join(testRoot, '.github', 'agents'), { recursive: true });
  await mkdir(path.join(testRoot, '.github', 'skills', 'collect-evidence'), { recursive: true });
  await mkdir(path.join(testRoot, '.github', 'prompts'), { recursive: true });
  await mkdir(path.join(testRoot, '.vscode'), { recursive: true });
  await writeFile(
    path.join(testRoot, '.github', 'agents', 'package.agent.md'),
    '---\nname: Package Builder\ndescription: Builds a package\ntools: read, edit\n---\n',
    'utf8'
  );
  await writeFile(
    path.join(testRoot, '.github', 'skills', 'collect-evidence', 'SKILL.md'),
    '---\nname: Collect Evidence\ndescription: Retrieves cloud evidence\n---\n',
    'utf8'
  );
  await writeFile(
    path.join(testRoot, '.github', 'prompts', 'review.prompt.md'),
    '---\nname: Review Package\ndescription: Reviews package completeness\n---\n',
    'utf8'
  );
  await writeFile(path.join(testRoot, '.vscode', 'mcp.json'), JSON.stringify({
    servers: {
      evidence: {
        type: 'http',
        url: 'https://demo-user:secret@example.test:8443/api?token=secret'
      }
    }
  }), 'utf8');

  const result = await new ProjectCustomizationService('demo', testRoot).list();
  assert.equal(result.projectId, 'demo');
  assert.equal(result.items.filter((item) => item.kind === 'agent').length, 1);
  assert.equal(result.items.filter((item) => item.kind === 'skill').length, 1);
  assert.equal(result.items.filter((item) => item.kind === 'instruction').length, 1);
  const prompt = result.items.find((item) => item.kind === 'instruction');
  assert.equal(prompt?.status, 'ready');
  assert.equal(prompt?.enabled, true);
  assert.equal(prompt?.detail, 'Prompt file · run as /review');
  assert.equal(result.items.filter((item) => item.kind === 'tool').length, builtInToolCatalog.length);
  const mcp = result.items.find((item) => item.kind === 'mcp-server');
  assert.equal(mcp?.description, 'Connects to example.test:8443');
  assert.doesNotMatch(mcp?.description ?? '', /secret|demo-user|token/);
});

test('missing customization folders return only built-in tools', async (t) => {
  const emptyRoot = path.join(testRoot, 'empty');
  await mkdir(emptyRoot, { recursive: true });
  t.after(() => rm(emptyRoot, { recursive: true, force: true }));

  const result = await new ProjectCustomizationService('empty', emptyRoot).list();
  assert.equal(result.items.length, builtInToolCatalog.length);
  assert.ok(result.items.every((item) => item.kind === 'tool'));
});

test('capability editors create and update project files and persist availability', async (t) => {
  const editorRoot = path.join(testRoot, 'editors');
  await mkdir(path.join(editorRoot, '.github', 'agents'), { recursive: true });
  await mkdir(path.join(editorRoot, '.vscode'), { recursive: true });
  await writeFile(
    path.join(editorRoot, '.github', 'agents', 'builder.agent.md'),
    '---\nname: "Builder"\ndescription: "Original"\ntools: [read]\nuser-invocable: true\n---\n\n# Original instructions\n',
    'utf8'
  );
  await writeFile(path.join(editorRoot, '.vscode', 'mcp.json'), JSON.stringify({
    servers: {
      publisher: { type: 'http', url: 'http://127.0.0.1:3000/mcp' }
    },
    inputs: [{ id: 'tenant' }]
  }), 'utf8');
  t.after(() => rm(editorRoot, { recursive: true, force: true }));

  const service = new ProjectCustomizationService('editors', editorRoot);
  const agent = await service.getEditor('agent:builder.agent.md');
  assert.equal(agent.instructions, '# Original instructions');
  assert.equal(agent.tools, 'read');

  const updatedAgent = await service.update('agent:builder.agent.md', {
    kind: 'agent',
    name: 'Authorization Builder',
    description: 'Builds reviewable authorization content.',
    argumentHint: 'Name a control to assess',
    tools: 'read, edit',
    instructions: '# Updated instructions\n\nStay grounded.',
    enabled: false
  });
  assert.equal(updatedAgent.enabled, false);
  assert.equal(updatedAgent.name, 'Authorization Builder');
  const agentSource = await readFile(
    path.join(editorRoot, '.github', 'agents', 'builder.agent.md'),
    'utf8'
  );
  assert.match(agentSource, /user-invocable: true/);
  assert.match(agentSource, /tools: \["read", "edit"\]/);
  assert.match(agentSource, /# Updated instructions/);

  const createdSkill = await service.create({
    kind: 'skill',
    name: 'Collect Evidence',
    description: 'Collects approved evidence.',
    argumentHint: 'Name the evidence source',
    instructions: '# Collect Evidence\n\nCollect only approved sources.',
    enabled: true
  });
  assert.equal(createdSkill.id, 'skill:collect-evidence');
  assert.equal(createdSkill.sourcePath, '.github/skills/collect-evidence/SKILL.md');

  const createdMcp = await service.create({
    kind: 'mcp-server',
    name: 'Local Scanner',
    description: 'Runs the local evidence scanner.',
    transport: 'stdio',
    command: 'node',
    args: 'scanner.js\n--local',
    enabled: true
  });
  assert.equal(createdMcp.id, 'mcp-server:local-scanner');
  assert.equal(createdMcp.command, 'node');
  assert.equal(createdMcp.args, 'scanner.js\n--local');
  assert.equal(createdMcp.description, 'Runs the local evidence scanner.');
  const mcpConfig = JSON.parse(await readFile(
    path.join(editorRoot, '.vscode', 'mcp.json'),
    'utf8'
  )) as { inputs: unknown[]; servers: Record<string, { args: string[] }> };
  assert.deepEqual(mcpConfig.inputs, [{ id: 'tenant' }]);
  assert.deepEqual(mcpConfig.servers['local-scanner'].args, ['scanner.js', '--local']);

  const disabledTool = await service.setEnabled('tool:write-file', false);
  assert.equal(disabledTool.enabled, false);
  const restored = await new ProjectCustomizationService('editors', editorRoot).list();
  assert.equal(restored.items.find((item) => item.id === 'agent:builder.agent.md')?.enabled, false);
  assert.equal(restored.items.find((item) => item.id === 'tool:write-file')?.enabled, false);
});
