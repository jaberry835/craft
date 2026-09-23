import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { createAaaApp } from '../app.js';
import { ProjectRegistry } from '../projectRegistry.js';

const testRoot = path.join(process.cwd(), '.test-data', 'api');

test('project API exposes configured metadata, sessions, messages, files, and traversal errors', async (t) => {
  await rm(testRoot, { recursive: true, force: true });
  const projectRoot = path.join(testRoot, 'assessed-project');
  const dataRoot = path.join(testRoot, 'data');
  const clientDistPath = path.join(testRoot, 'client');
  const configPath = path.join(testRoot, 'projects.json');
  const statePath = path.join(dataRoot, 'projects.json');
  const managedRoot = path.join(dataRoot, 'workspaces');
  const templatePath = path.join(
    projectRoot,
    '.github',
    'skills',
    'initialize-security-package',
    'assets',
    'security-package-template'
  );
  await mkdir(projectRoot, { recursive: true });
  await mkdir(templatePath, { recursive: true });
  await mkdir(path.join(projectRoot, '.github', 'agents'), { recursive: true });
  await mkdir(path.join(projectRoot, '.vscode'), { recursive: true });
  await mkdir(clientDistPath, { recursive: true });
  await writeFile(path.join(projectRoot, 'README.md'), '# Assessed project\n', 'utf8');
  await writeFile(path.join(templatePath, 'package-config.json'), '{"packageName":"Template"}\n', 'utf8');
  await writeFile(
    path.join(projectRoot, '.github', 'agents', 'builder.agent.md'),
    '---\nname: Package Builder\ndescription: Builds packages\n---\n',
    'utf8'
  );
  await writeFile(path.join(projectRoot, '.vscode', 'mcp.json'), '{"servers":{}}\n', 'utf8');
  await writeFile(path.join(clientDistPath, 'index.html'), '<!doctype html><title>AAA test client</title>', 'utf8');
  await writeFile(configPath, JSON.stringify({
    activeProjectId: 'assessed-project',
    projects: [{ id: 'assessed-project', name: 'Assessed Project', rootPath: projectRoot }]
  }), 'utf8');

  const registry = await ProjectRegistry.load(configPath, { statePath, managedRoot });
  const server = createServer(createAaaApp({ registry, dataRoot, clientDistPath }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(testRoot, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}/api/projects/assessed-project`;

  const projects = await fetch('http://127.0.0.1:' + address.port + '/api/projects');
  assert.equal(projects.status, 200);
  assert.equal((await projects.json() as { activeProjectId: string }).activeProjectId, 'assessed-project');

  const customizations = await fetch(`${baseUrl}/customizations`);
  assert.equal(customizations.status, 200);
  const customizationBody = await customizations.json() as {
    items: Array<{ kind: string; name: string }>;
  };
  assert.ok(customizationBody.items.some((item) =>
    item.kind === 'agent' && item.name === 'Package Builder'));
  const editorResponse = await fetch(
    `${baseUrl}/customizations/${encodeURIComponent('agent:builder.agent.md')}`
  );
  assert.equal(editorResponse.status, 200);
  assert.equal((await editorResponse.json() as { kind: string }).kind, 'agent');
  const disableToolResponse = await fetch(
    `${baseUrl}/customizations/${encodeURIComponent('tool:write-file')}/enabled`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false })
    }
  );
  assert.equal(disableToolResponse.status, 200);
  assert.equal((await disableToolResponse.json() as { enabled: boolean }).enabled, false);

  const createProject = await fetch(`http://127.0.0.1:${address.port}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'New Package', systemName: 'New System' })
  });
  assert.equal(createProject.status, 201);
  const createdProject = await createProject.json() as { id: string; active: boolean };
  assert.deepEqual(createdProject, {
    id: 'new-package',
    name: 'New Package',
    description: 'Managed AAA authorization project.',
    rootPath: path.resolve(managedRoot, 'new-package'),
    active: true
  });
  const selectProject = await fetch(`http://127.0.0.1:${address.port}/api/projects/active`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: 'assessed-project' })
  });
  assert.equal(selectProject.status, 200);
  assert.equal((await selectProject.json() as { active: boolean }).active, true);

  const storageStatus = await fetch('http://127.0.0.1:' + address.port + '/api/storage/status');
  assert.equal(storageStatus.status, 200);
  assert.deepEqual(await storageStatus.json(), {
    sessions: {
      backend: 'local',
      configured: true,
      ready: true,
      active: true,
      missing: [],
      invalid: []
    },
    workspaceFiles: {
      backend: 'local',
      configured: true,
      ready: true,
      active: true,
      missing: [],
      invalid: []
    }
  });

  const client = await fetch('http://127.0.0.1:' + address.port + '/');
  assert.equal(client.status, 200);
  assert.match(await client.text(), /AAA test client/);

  const createResponse = await fetch(`${baseUrl}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  });
  assert.equal(createResponse.status, 201);
  const session = await createResponse.json() as { id: string };
  const messageResponse = await fetch(`${baseUrl}/sessions/${session.id}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'user', content: 'Review this package' })
  });
  assert.equal(messageResponse.status, 201);
  assert.equal((await messageResponse.json() as { messageCount: number }).messageCount, 1);

  const fileResponse = await fetch(`${baseUrl}/files?path=${encodeURIComponent('README.md')}`);
  assert.equal(fileResponse.status, 200);
  assert.equal((await fileResponse.json() as { content: string }).content, '# Assessed project\n');

  const traversalResponse = await fetch(`${baseUrl}/files?path=${encodeURIComponent('../outside.txt')}`);
  assert.equal(traversalResponse.status, 400);
  assert.equal((await traversalResponse.json() as { code: string }).code, 'path_outside_project');

  const file = await (await fetch(`${baseUrl}/files?path=README.md`)).json() as { updatedAt: string };
  const saveResponse = await fetch(`${baseUrl}/files`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'README.md', content: '# Saved\n', updatedAt: file.updatedAt })
  });
  assert.equal(saveResponse.status, 200);
  const staleResponse = await fetch(`${baseUrl}/files`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'README.md', content: '# Stale\n', updatedAt: file.updatedAt })
  });
  assert.equal(staleResponse.status, 409);
  assert.equal((await staleResponse.json() as { code: string }).code, 'file_update_conflict');

  const createFileResponse = await fetch(`${baseUrl}/files`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'published.md', content: '# Published\n\n<script>unsafe()</script>\n' })
  });
  assert.equal(createFileResponse.status, 201);
  const previewResponse = await fetch(`${baseUrl}/published?path=published.md`);
  assert.equal(previewResponse.status, 200);
  assert.match(previewResponse.headers.get('content-type') ?? '', /^text\/html/);
  const preview = await previewResponse.text();
  assert.match(preview, /<h1>Published<\/h1>/);
  assert.match(preview, /&lt;script&gt;unsafe\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(preview, /<script>/);

  const invalidPreview = await fetch(`${baseUrl}/published?path=README.txt`);
  assert.equal(invalidPreview.status, 415);
  assert.equal((await invalidPreview.json() as { code: string }).code, 'markdown_required');

  const renameResponse = await fetch(`${baseUrl}/paths`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'published.md', newPath: 'final.md' })
  });
  assert.equal(renameResponse.status, 200);
  assert.deepEqual(await renameResponse.json(), { path: 'final.md', type: 'file' });
  const deleteResponse = await fetch(`${baseUrl}/paths?path=final.md`, { method: 'DELETE' });
  assert.equal(deleteResponse.status, 200);
  assert.deepEqual(await deleteResponse.json(), { path: 'final.md', type: 'file' });
});
