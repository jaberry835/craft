import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { ModelConnectionConfig } from '../services/modelConnectionConfig.js';

const testRoot = path.join(process.cwd(), '.test-data', 'model-config');
const configPath = path.join(testRoot, 'agent-connections.json');

async function writeConfig(authMode: 'entra' | 'api-key' = 'entra'): Promise<void> {
  await mkdir(testRoot, { recursive: true });
  await writeFile(configPath, JSON.stringify([{
    id: 'model',
    name: 'Test model',
    type: 'azure-openai',
    authMode,
    endpointEnv: 'TEST_MODEL_ENDPOINT',
    apiKeyEnv: 'TEST_MODEL_KEY',
    deploymentEnv: 'TEST_MODEL_DEPLOYMENT',
    apiVersionEnv: 'TEST_MODEL_API_VERSION',
    defaultApiVersion: '2025-01-01-preview'
  }]), 'utf8');
}

test('model config reports missing variable names and never exposes credentials', async (t) => {
  t.after(() => rm(testRoot, { recursive: true, force: true }));
  await writeConfig('api-key');
  const secret = 'not-for-status-output';
  const config = await ModelConnectionConfig.load(configPath, {
    TEST_MODEL_ENDPOINT: 'https://example.openai.azure.com',
    TEST_MODEL_KEY: secret
  });

  const status = config.status();
  assert.equal(status.ready, false);
  assert.deepEqual(status.missing, ['TEST_MODEL_DEPLOYMENT']);
  assert.equal(status.endpointHost, 'example.openai.azure.com');
  assert.doesNotMatch(JSON.stringify(status), new RegExp(secret));
  assert.equal(Object.hasOwn(status, 'apiKey'), false);
});

test('model config requires an API key only for API-key auth', async (t) => {
  t.after(() => rm(testRoot, { recursive: true, force: true }));
  await writeConfig('api-key');
  const baseEnvironment = {
    TEST_MODEL_ENDPOINT: 'https://example.openai.azure.com',
    TEST_MODEL_DEPLOYMENT: 'chat'
  };
  const apiKeyConfig = await ModelConnectionConfig.load(configPath, baseEnvironment);
  assert.deepEqual(apiKeyConfig.status().missing, ['TEST_MODEL_KEY']);

  await writeConfig('entra');
  const entraConfig = await ModelConnectionConfig.load(configPath, baseEnvironment);
  assert.equal(entraConfig.status().ready, true);
});

test('model config rejects literal or malformed environment references', async (t) => {
  t.after(() => rm(testRoot, { recursive: true, force: true }));
  await mkdir(testRoot, { recursive: true });
  await writeFile(configPath, JSON.stringify([{
    id: 'model',
    name: 'Test model',
    type: 'azure-openai',
    endpointEnv: 'https://literal.example',
    deploymentEnv: 'TEST_MODEL_DEPLOYMENT'
  }]), 'utf8');

  await assert.rejects(
    () => ModelConnectionConfig.load(configPath, {}),
    /Invalid environment variable reference/
  );
});

test('model config validates compatibility settings and reports them in status', async (t) => {
  t.after(() => rm(testRoot, { recursive: true, force: true }));
  await mkdir(testRoot, { recursive: true });
  const base = {
    id: 'model',
    name: 'Test model',
    type: 'azure-openai',
    endpointEnv: 'TEST_MODEL_ENDPOINT',
    deploymentEnv: 'TEST_MODEL_DEPLOYMENT',
    defaultApiVersion: '2025-01-01-preview'
  };
  await writeFile(configPath, JSON.stringify([{ ...base, api: 'responses', adaptive: false, temperature: null }]), 'utf8');
  const status = (await ModelConnectionConfig.load(configPath, {})).status();
  assert.equal(status.api, 'responses');
  assert.equal(status.adaptive, false);
  assert.equal(status.autoCompact, false);

  await writeFile(configPath, JSON.stringify([{ ...base, contextWindow: 200000, compaction: { threshold: 0.7 } }]), 'utf8');
  const withWindow = (await ModelConnectionConfig.load(configPath, {})).status();
  assert.equal(withWindow.contextWindow, 200000);
  assert.equal(withWindow.autoCompact, true);
  assert.equal(withWindow.compactThreshold, 0.7);

  for (const [override, pattern] of [
    [{ api: 'completions' }, /api must be one of/],
    [{ tokenParameter: 'max' }, /tokenParameter must be one of/],
    [{ temperature: 'warm' }, /temperature must be a number/],
    [{ adaptive: 'yes' }, /adaptive must be true or false/],
    [{ maxTokens: 0 }, /maxTokens must be a positive integer/],
    [{ contextWindow: 100 }, /contextWindow must be an integer of at least 1024/],
    [{ compaction: { threshold: 0.99 } }, /compaction.threshold must be a number from 0.3 to 0.95/],
    [{ compaction: { auto: 'on' } }, /compaction.auto must be true or false/],
    [{ maxRetries: 50 }, /maxRetries must be an integer from 0 to 10/]
  ] as const) {
    await writeFile(configPath, JSON.stringify([{ ...base, ...override }]), 'utf8');
    await assert.rejects(() => ModelConnectionConfig.load(configPath, {}), pattern);
  }
});
