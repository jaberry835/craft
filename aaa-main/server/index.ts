import 'dotenv/config';
import path from 'node:path';
import { createAaaApp } from './app.js';
import { ProjectRegistry } from './projectRegistry.js';
import { AzureOpenAiChatClient } from './services/azureOpenAiChatClient.js';
import { ModelConnectionConfig } from './services/modelConnectionConfig.js';
import { createSessionPersistence } from './sessionStoreFactory.js';

const repositoryRoot = process.env.AAA_ROOT
  ? path.resolve(process.env.AAA_ROOT)
  : process.cwd();
const dataRoot = path.join(repositoryRoot, 'data');
const templateRoot = process.env.AAA_PROJECT_TEMPLATE
  ? path.resolve(process.env.AAA_PROJECT_TEMPLATE)
  : path.join(repositoryRoot, 'templates', 'default-project');
const registry = await ProjectRegistry.load(path.join(repositoryRoot, 'config', 'projects.json'), {
  statePath: path.join(dataRoot, 'projects.json'),
  managedRoot: path.join(dataRoot, 'workspaces'),
  templateRoot
});
const modelConfig = await ModelConnectionConfig.load(
  path.join(repositoryRoot, 'config', 'agent-connections.json')
);
const sessionPersistence = createSessionPersistence(dataRoot);
const app = createAaaApp({
  registry,
  dataRoot,
  clientDistPath: path.join(repositoryRoot, 'dist', 'client'),
  modelConfig,
  modelClient: new AzureOpenAiChatClient(),
  ...sessionPersistence
});
const port = Number(process.env.PORT ?? 8787);

app.listen(port, '127.0.0.1', () => {
  console.log(`AAA local API listening on http://127.0.0.1:${port}`);
});
