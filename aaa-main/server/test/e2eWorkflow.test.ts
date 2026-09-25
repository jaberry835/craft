import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { chromium, type Browser } from 'playwright-core';
import { createAaaApp } from '../app.js';
import type { ModelChatClient, ModelChatMessage, ModelStreamChunk } from '../modelTypes.js';
import { ProjectRegistry } from '../projectRegistry.js';
import { ModelConnectionConfig } from '../services/modelConnectionConfig.js';

const clientDist = path.join(process.cwd(), 'dist', 'client');
const templateRoot = path.join(process.cwd(), 'templates', 'default-project');
const root = path.join(process.cwd(), '.test-data', 'e2e-workflow');
const responsePath = 'security-package/control-responses/AU-2.md';

function toolCall(id: string, name: string, args: Record<string, unknown>): ModelStreamChunk {
  return { type: 'tool_calls', calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
}

/**
 * A deterministic stand-in for the model that makes the same tool calls a real model is
 * expected to make for each step, so the test exercises the real harness, skills, template,
 * file tools, and MCP publishing path end to end.
 */
function scriptedModel(): ModelChatClient {
  return {
    async *stream(_connection, messages: ModelChatMessage[]) {
      const lastUser = [...messages].reverse().find((message) => message.role === 'user')?.content ?? '';
      const sinceUser = messages.slice(messages.map((message) => message.role).lastIndexOf('user') + 1);
      const toolResults = sinceUser.filter((message) => message.role === 'tool').map((message) => message.content);
      if (lastUser.includes('/initialize-security-package')) {
        if (toolResults.length === 0) yield toolCall('i1', 'load_skill', { name: 'initialize-security-package' });
        else if (toolResults.length === 1) {
          assert.match(toolResults[0]!, /copy_path/);
          yield toolCall('i2', 'copy_path', {
            source: '.github/skills/initialize-security-package/assets/security-package-template',
            destination: 'security-package'
          });
        } else yield { type: 'assistant_text', text: 'Initialized security-package from the bundled template.' };
      } else if (lastUser.includes('/build-security-package')) {
        assert.match(lastUser, /User input: AU-2/);
        if (toolResults.length === 0) {
          yield toolCall('b1', 'write_file', {
            path: responsePath,
            content: '# AU-2 Event Logging\n\n**Status:** Partially implemented\n\nFalcon logs authentication events to the central SIEM.\n'
          });
        } else yield { type: 'assistant_text', text: `Built AU-2 and wrote ${responsePath} for human review.` };
      } else if (/publish/i.test(lastUser)) {
        if (toolResults.length === 0) {
          yield toolCall('p1', 'mcp_mcp-publisher_upsert_site_files', {
            siteId: 'falcon',
            files: [{ path: 'AU-2.md', content: `aaa-file:${responsePath}` }]
          });
        } else if (toolResults.length === 1) yield toolCall('p2', 'mcp_mcp-publisher_publish_site_draft', { siteId: 'falcon' });
        else yield { type: 'assistant_text', text: 'Published the Falcon package site.' };
      } else {
        yield { type: 'assistant_text', text: 'Ready.' };
      }
      yield { type: 'completed' };
    }
  };
}

/** Fake Streamable HTTP MCP publisher reached through the app's injectable MCP fetch. */
function fakePublisher() {
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id?: number; method: string; params?: { name: string; arguments: Record<string, unknown> } };
    if (body.id === undefined) return new Response(null, { status: 202 });
    const reply = (result: unknown) => Response.json({ jsonrpc: '2.0', id: body.id, result });
    if (body.method === 'initialize') return reply({ protocolVersion: '2025-06-18' });
    if (body.method === 'tools/list') {
      return reply({
        tools: [
          { name: 'upsert_site_files', inputSchema: { type: 'object', properties: { siteId: { type: 'string' }, files: { type: 'array' } } } },
          { name: 'publish_site_draft', inputSchema: { type: 'object', properties: { siteId: { type: 'string' } } } }
        ]
      });
    }
    calls.push(body.params!);
    return reply({ content: [{ type: 'text', text: body.params!.name === 'publish_site_draft' ? 'Published https://sites.local/falcon' : 'Draft updated.' }] });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

test('create project, initialize, build, and publish a package through the browser', async (t) => {
  if (!existsSync(path.join(clientDist, 'index.html'))) {
    t.skip('Run npm run build to enable browser tests.');
    return;
  }
  let browser: Browser;
  try {
    browser = await chromium.launch({
      headless: true,
      ...(process.env.AAA_EDGE_EXECUTABLE_PATH
        ? { executablePath: process.env.AAA_EDGE_EXECUTABLE_PATH }
        : { channel: process.env.AAA_EDGE_CHANNEL || 'msedge' })
    });
  } catch {
    t.skip('Microsoft Edge is not available for browser tests.');
    return;
  }

  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'projects.json'), JSON.stringify({ projects: [] }));
  await writeFile(path.join(root, 'agent-connections.json'), JSON.stringify([{
    id: 'model', name: 'Test model', type: 'azure-openai', authMode: 'api-key',
    endpointEnv: 'E', apiKeyEnv: 'K', deploymentEnv: 'D', defaultApiVersion: '2025-01-01-preview'
  }]));
  const dataRoot = path.join(root, 'data');
  const publisher = fakePublisher();
  const server = createServer(createAaaApp({
    registry: await ProjectRegistry.load(path.join(root, 'projects.json'), {
      statePath: path.join(dataRoot, 'projects.json'),
      managedRoot: path.join(dataRoot, 'workspaces'),
      templateRoot
    }),
    dataRoot,
    clientDistPath: clientDist,
    modelConfig: await ModelConnectionConfig.load(path.join(root, 'agent-connections.json'), { E: 'https://x.openai.azure.com', K: 'k', D: 'd' }),
    modelClient: scriptedModel(),
    mcpFetch: publisher.fetchImpl
  }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await browser.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;

  const page = await browser.newPage();
  await page.goto(base);
  await page.getByText('Test model ready').first().waitFor({ timeout: 15_000 });

  // 1. Create a project from the bundled template.
  await page.locator('.project-switcher').click();
  await page.getByRole('button', { name: 'Create project' }).first().click();
  await page.locator('form input[required]').first().fill('Falcon Authorization');
  await page.locator('form button[type="submit"]', { hasText: 'Create project' }).click();
  await page.locator('.project-switcher', { hasText: 'Falcon Authorization' }).waitFor({ timeout: 10_000 });
  const projects = await (await fetch(`${base}/api/projects`)).json() as { activeProjectId: string; projects: Array<{ id: string; name: string; rootPath: string }> };
  const project = projects.projects.find((candidate) => candidate.id === projects.activeProjectId)!;
  assert.equal(project.name, 'Falcon Authorization');
  assert.ok(existsSync(path.join(project.rootPath, '.github', 'skills', 'initialize-security-package', 'SKILL.md')));

  const composer = page.locator('textarea');
  const send = async (text: string, reply: RegExp) => {
    await composer.fill(text);
    await composer.press('Enter');
    await page.locator('.message.assistant', { hasText: reply }).last().waitFor({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Send message' }).waitFor({ timeout: 20_000 });
  };

  // 2. Initialize the package with the skill (load_skill + copy_path, no scripts).
  await send('/initialize-security-package', /Initialized security-package from the bundled template/);
  for (const folder of ['background-docs', 'cloud-scan', 'control-responses', 'security-standards', 'standard-docs']) {
    assert.ok(existsSync(path.join(project.rootPath, 'security-package', folder)), `missing security-package/${folder}`);
  }
  await page.locator('.file-row', { hasText: 'security-package' }).first().waitFor({ timeout: 10_000 });

  // 3. Build a control with the prompt file.
  await send('/build-security-package AU-2', /Built AU-2/);
  assert.match(await readFile(path.join(project.rootPath, ...responsePath.split('/')), 'utf8'), /Falcon logs authentication events/);

  // 4. Publish through the MCP publisher; the file reference is expanded to the real content.
  await send('Publish the package site.', /Published the Falcon package site/);
  assert.deepEqual(publisher.calls.map((call) => call.name), ['upsert_site_files', 'publish_site_draft']);
  const files = publisher.calls[0]!.arguments.files as Array<{ path: string; content: string }>;
  assert.equal(files[0]!.path, 'AU-2.md');
  assert.match(files[0]!.content, /^# AU-2 Event Logging/);

  // The whole conversation and its runs persisted.
  const sessions = await (await fetch(`${base}/api/projects/${project.id}/sessions`)).json() as Array<{ id: string; messageCount: number }>;
  assert.equal(sessions[0]!.messageCount, 6);
  const session = await (await fetch(`${base}/api/projects/${project.id}/sessions/${sessions[0]!.id}`)).json() as {
    runs: Array<{ status: string; changedFiles: string[] }>;
  };
  assert.deepEqual(session.runs.map((run) => run.status), ['completed', 'completed', 'completed']);
  assert.ok(session.runs[1]!.changedFiles.includes(responsePath));
  assert.ok((await readdir(path.join(project.rootPath, 'security-package'))).length >= 5);
});
