import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import test from 'node:test';
import { chromium, type Browser } from 'playwright-core';
import { createAaaApp } from '../app.js';
import { loadAppAuthConfig } from '../appAuth.js';
import type { ModelChatClient } from '../modelTypes.js';
import { ProjectRegistry } from '../projectRegistry.js';
import { ModelConnectionConfig } from '../services/modelConnectionConfig.js';

const clientDist = path.join(process.cwd(), 'dist', 'client');
const root = path.join(process.cwd(), '.test-data', 'e2e-chat');

/**
 * Browser regression test for the first prompt of a session: the prompt and the live
 * response area must appear immediately, not after the model finishes. Requires a
 * built client (`npm run build`) and Microsoft Edge; skipped otherwise.
 */
test('first prompt renders immediately and the reply replaces the live view without duplicates', async (t) => {
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
  const projectRoot = path.join(root, 'project');
  await mkdir(projectRoot, { recursive: true });
  await writeFile(path.join(root, 'projects.json'), JSON.stringify({
    activeProjectId: 'project',
    projects: [{ id: 'project', name: 'Browser Test Package', rootPath: projectRoot }]
  }));
  await writeFile(path.join(root, 'agent-connections.json'), JSON.stringify([{
    id: 'model',
    name: 'Test model',
    type: 'azure-openai',
    authMode: 'api-key',
    endpointEnv: 'MODEL_ENDPOINT',
    apiKeyEnv: 'MODEL_KEY',
    deploymentEnv: 'MODEL_DEPLOYMENT',
    defaultApiVersion: '2025-01-01-preview'
  }]));

  // A slow provider, like a high-latency air-gapped endpoint.
  const modelClient: ModelChatClient = {
    async *stream() {
      yield { type: 'reasoning', text: 'Thinking about the request.' };
      await wait(2_000);
      yield { type: 'assistant_text', text: 'Slow reply finished.' };
      yield { type: 'completed' };
    }
  };
  const registry = await ProjectRegistry.load(path.join(root, 'projects.json'));
  const modelConfig = await ModelConnectionConfig.load(path.join(root, 'agent-connections.json'), {
    MODEL_ENDPOINT: 'https://example.openai.azure.com',
    MODEL_KEY: 'key',
    MODEL_DEPLOYMENT: 'chat'
  });
  const server = createServer(createAaaApp({
    registry,
    dataRoot: path.join(root, 'data'),
    clientDistPath: clientDist,
    modelConfig,
    modelClient
  }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await browser.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/`);
  const composer = page.locator('textarea');
  await composer.waitFor();
  await page.getByText('Test model ready').first().waitFor();
  assert.equal(await page.locator('.welcome').count(), 1);

  await composer.fill('Assess the boundary for AC-2.');
  await composer.press('Enter');

  // Well before the 2 s reply, the prompt and live response view must be on screen.
  await page.locator('.message.user', { hasText: 'Assess the boundary for AC-2.' }).waitFor({ timeout: 1_000 });
  assert.equal(await page.locator('.welcome').count(), 0);
  await page.locator('.message.assistant .reasoning-detail').first().waitFor({ timeout: 1_000 });
  assert.equal(await page.getByText('Slow reply finished.').count(), 0);

  await page.getByText('Slow reply finished.').first().waitFor({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Send message' }).waitFor({ timeout: 10_000 });
  assert.equal(await page.locator('.message.user').count(), 1);
  assert.equal(await page.locator('.message.assistant').count(), 1);
});

test('folders can be deleted from the Files tree after confirming their contents', async (t) => {
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
  const treeRoot = path.join(process.cwd(), '.test-data', 'e2e-tree');
  await rm(treeRoot, { recursive: true, force: true });
  const projectRoot = path.join(treeRoot, 'project');
  await mkdir(path.join(projectRoot, 'drafts'), { recursive: true });
  await writeFile(path.join(projectRoot, 'drafts', 'one.md'), '# One\n');
  await writeFile(path.join(projectRoot, 'drafts', 'two.md'), '# Two\n');
  await writeFile(path.join(projectRoot, 'keep.md'), '# Keep\n');
  await writeFile(path.join(treeRoot, 'projects.json'), JSON.stringify({
    activeProjectId: 'project',
    projects: [{ id: 'project', name: 'Tree Test Package', rootPath: projectRoot }]
  }));
  const server = createServer(createAaaApp({
    registry: await ProjectRegistry.load(path.join(treeRoot, 'projects.json')),
    dataRoot: path.join(treeRoot, 'data'),
    clientDistPath: clientDist
  }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await browser.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(treeRoot, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/`);
  const folderRow = page.locator('.file-row-wrap', { has: page.locator('.file-row', { hasText: 'drafts' }) });
  await folderRow.waitFor();
  await folderRow.hover();
  await page.getByRole('button', { name: 'Delete folder drafts' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete folder' });
  await dialog.waitFor();
  assert.match(await dialog.textContent() ?? '', /Delete drafts and everything in it \(2 files\)\? This cannot be undone\./);
  await dialog.getByRole('button', { name: 'Delete' }).click();
  await folderRow.waitFor({ state: 'detached' });
  assert.equal(existsSync(path.join(projectRoot, 'drafts')), false);
  assert.equal(existsSync(path.join(projectRoot, 'keep.md')), true);
});

test('with Microsoft Entra sign-in on, the app shows a sign-in screen instead of the workbench', async (t) => {
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
  const gateRoot = path.join(process.cwd(), '.test-data', 'e2e-auth');
  await rm(gateRoot, { recursive: true, force: true });
  await mkdir(path.join(gateRoot, 'project'), { recursive: true });
  await writeFile(path.join(gateRoot, 'projects.json'), JSON.stringify({
    activeProjectId: 'project',
    projects: [{ id: 'project', name: 'Protected Package', rootPath: path.join(gateRoot, 'project') }]
  }));
  const server = createServer(createAaaApp({
    registry: await ProjectRegistry.load(path.join(gateRoot, 'projects.json')),
    dataRoot: path.join(gateRoot, 'data'),
    clientDistPath: clientDist,
    auth: {
      config: loadAppAuthConfig({
        AAA_AUTH_MODE: 'entra',
        AAA_ENTRA_TENANT_ID: '11111111-2222-3333-4444-555555555555',
        AAA_ENTRA_CLIENT_ID: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
      }),
      verifier: async () => { throw new Error('No tokens are issued in this test.'); }
    }
  }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await browser.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(gateRoot, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  const page = await browser.newPage();
  const apiStatuses: number[] = [];
  page.on('response', (response) => {
    if (response.url().includes('/api/projects')) apiStatuses.push(response.status());
  });
  await page.goto(`http://127.0.0.1:${address.port}/`);
  await page.getByRole('button', { name: 'Sign in with Microsoft' }).waitFor({ timeout: 10_000 });
  assert.equal(await page.locator('textarea').count(), 0);
  assert.equal(await page.getByText('Protected Package').count(), 0);
  assert.deepEqual(apiStatuses, [], 'the workbench must not call project APIs before sign-in');
});
