import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkbenchApp } from './app.js';
import { AgentConfigStore } from './services/agentConfigStore.js';
import { AzureOpenAiChatClient } from './services/azureOpenAiChatClient.js';
import { ChangeManager } from './services/changeManager.js';
import { GroundingService } from './services/groundingService.js';
import { LocalWorkspaceManager } from './services/localWorkspaceManager.js';
import { createChatSessionStore, createPendingChangeStore, createWorkspaceMetadataStore, createWorkspaceSecretStore, createWorkspaceStateStore } from './services/persistenceFactories.js';
import { SimpleJuniorAgent } from './services/simpleJuniorAgent.js';
import { WorkspaceConfigStore } from './services/workspaceConfigStore.js';
import { createWorkspaceStorageFactory } from './services/workspaceStorageFactory.js';
import { WorkspaceIndexer } from './services/workspaceIndexer.js';
import type { WorkspaceSummary } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const dataRoot = path.join(repoRoot, 'data');
const configRoot = path.join(repoRoot, 'config');

const agentConfigStore = new AgentConfigStore(configRoot);
await agentConfigStore.load();
const chatClient = new AzureOpenAiChatClient((connection) => agentConfigStore.resolveApiKey(connection));
const workspacesRoot = path.join(dataRoot, 'workspaces');
const createWorkspaceStorage = createWorkspaceStorageFactory();
const workspaceMetadataStore = createWorkspaceMetadataStore(workspacesRoot);
const workspaceManager = new LocalWorkspaceManager(workspacesRoot, async (workspace: WorkspaceSummary) => {
  const storage = createWorkspaceStorage(workspace);
  await storage.ensureSeedWorkspace();
  const workspaceStateStore = createWorkspaceStateStore(workspace, storage);
  const workspaceSecretStore = createWorkspaceSecretStore(workspace);
  const configStore = new WorkspaceConfigStore(workspaceStateStore, workspaceSecretStore, agentConfigStore);
  await configStore.load();
  const workspaceIndexer = new WorkspaceIndexer(storage);
  await workspaceIndexer.refresh();
  const groundingService = new GroundingService(
    workspaceIndexer,
    (connectionId) => configStore.getSearchConnection(connectionId),
    (connection) => configStore.resolveApiKey(connection)
  );
  const pendingChangeStore = createPendingChangeStore(workspace);
  const changeManager = new ChangeManager(storage, pendingChangeStore);
  const sessionStore = createChatSessionStore(workspace);
  const agent = new SimpleJuniorAgent(storage, changeManager, workspaceIndexer, configStore, groundingService, chatClient, sessionStore);

  const runtime = {
    ...workspace,
    storage,
    configStore,
    workspaceIndexer,
    changeManager,
    agent
  };
  return runtime;
}, workspaceMetadataStore);
await workspaceManager.load();

const app = createWorkbenchApp({
  agentConfigStore,
  workspaceManager
}, {
  clientDistPath: path.join(repoRoot, 'client')
});

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => {
  console.log(`Junior Workbench API listening on http://localhost:${port}`);
});
