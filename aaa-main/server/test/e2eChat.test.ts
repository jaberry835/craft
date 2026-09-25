import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import test from 'node:test';
import { chromium, type Browser } from 'playwright-core';
import { createAaaApp } from '../app.js';
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
