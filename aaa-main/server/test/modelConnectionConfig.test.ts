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
