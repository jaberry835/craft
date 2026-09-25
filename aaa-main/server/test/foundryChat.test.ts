import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { createAaaApp } from '../app.js';
import { ProjectRegistry } from '../projectRegistry.js';

const root = path.join(process.cwd(), '.test-data', 'foundry-chat');

test('a selected Foundry project agent runs without the local model connection', async (t) => {
  await rm(root, { recursive: true, force: true });
  const projectRoot = path.join(root, 'project');
  const clientRoot = path.join(root, 'client');
  await mkdir(path.join(projectRoot, '.github', 'agents'), { recursive: true });
  await mkdir(clientRoot, { recursive: true });
  await writeFile(path.join(clientRoot, 'index.html'), '<title>test</title>');
  await writeFile(path.join(projectRoot, '.github', 'agents', 'remote.agent.md'), `---
name: "Remote Assessor"
description: "High-side Foundry assessor"
foundry-endpoint-env: "AAA_TEST_FOUNDRY_ENDPOINT"
foundry-auth: "api-key"
foundry-api-key-env: "AAA_TEST_FOUNDRY_KEY"
---

Use the remote assessor.
`);
  const projectsPath = path.join(root, 'projects.json');
  await writeFile(projectsPath, JSON.stringify({
    activeProjectId: 'project',
    projects: [{ id: 'project', name: 'Project', rootPath: projectRoot }]
  }));
  const previousEndpoint = process.env.AAA_TEST_FOUNDRY_ENDPOINT;
  const previousKey = process.env.AAA_TEST_FOUNDRY_KEY;
  process.env.AAA_TEST_FOUNDRY_ENDPOINT = 'https://agents.example.test/responses';
  process.env.AAA_TEST_FOUNDRY_KEY = 'secret';
  t.after(() => {
    if (previousEndpoint === undefined) delete process.env.AAA_TEST_FOUNDRY_ENDPOINT;
    else process.env.AAA_TEST_FOUNDRY_ENDPOINT = previousEndpoint;
    if (previousKey === undefined) delete process.env.AAA_TEST_FOUNDRY_KEY;
    else process.env.AAA_TEST_FOUNDRY_KEY = previousKey;
  });
  const registry = await ProjectRegistry.load(projectsPath);
  const server = createServer(createAaaApp({
    registry,
    dataRoot: path.join(root, 'data'),
    clientDistPath: clientRoot,
    foundryFetch: async () => Response.json({
      output_text: 'Remote control assessment complete.',
      usage: { input_tokens: 12, output_tokens: 5 }
    })
  }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/projects/project`;
  const session = await (await fetch(`${base}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  })).json() as { id: string };
  const response = await fetch(`${base}/sessions/${session.id}/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'Assess AU-2', agentId: 'remote' })
  });
  assert.equal(response.status, 200);
  const events = (await response.text()).trim().split('\n').map((line) => JSON.parse(line) as {
    type: string;
    response?: { message: { content: string } };
  });
  assert.deepEqual(events.map((event) => event.type), ['tool_event', 'assistant_text', 'usage', 'completed']);
  assert.equal(events.at(-1)?.response?.message.content, 'Remote control assessment complete.');
});
