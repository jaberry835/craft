import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentConfigStore } from './services/agentConfigStore.js';
import { AzureOpenAiChatClient } from './services/azureOpenAiChatClient.js';
import { ChangeManager } from './services/changeManager.js';
import { GroundingService } from './services/groundingService.js';
import { LocalWorkspaceStorage } from './services/localWorkspaceStorage.js';
import { Publisher } from './services/publisher.js';
import { SimpleJuniorAgent } from './services/simpleJuniorAgent.js';
import { WorkspaceIndexer } from './services/workspaceIndexer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const dataRoot = path.join(repoRoot, 'data');
const configRoot = path.join(repoRoot, 'config');
const workspaceRoot = path.join(dataRoot, 'workspaces', 'default');
const publishedRoot = path.join(dataRoot, 'published', 'default');

const agentConfigStore = new AgentConfigStore(configRoot);
await agentConfigStore.load();
const storage = new LocalWorkspaceStorage(workspaceRoot);
await storage.ensureSeedWorkspace();
const workspaceIndexer = new WorkspaceIndexer(storage);
await workspaceIndexer.refresh();
const groundingService = new GroundingService(
  workspaceIndexer,
  (connectionId) => agentConfigStore.getSearchConnection(connectionId),
  (connection) => agentConfigStore.resolveApiKey(connection)
);
const changeManager = new ChangeManager(storage);
const chatClient = new AzureOpenAiChatClient((connection) => agentConfigStore.resolveApiKey(connection));
const agent = new SimpleJuniorAgent(storage, changeManager, workspaceIndexer, agentConfigStore, groundingService, chatClient);
const publisher = new Publisher(storage, publishedRoot);

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use('/published/default', express.static(publishedRoot));

app.get('/api/health', (_request, response) => {
  response.json({ ok: true, workspaceRoot });
});

app.get('/api/agents', (_request, response) => {
  response.json(agentConfigStore.listAgents());
});

app.post('/api/agents', async (request, response, next) => {
  try {
    response.json(await agentConfigStore.createAgent(request.body));
  } catch (error) {
    next(error);
  }
});

app.put('/api/agents/:id', async (request, response, next) => {
  try {
    response.json(await agentConfigStore.updateAgent(request.params.id, request.body));
  } catch (error) {
    next(error);
  }
});

app.get('/api/agent-connections', (_request, response) => {
  response.json(agentConfigStore.listConnections());
});

app.post('/api/agent-connections', async (request, response, next) => {
  try {
    response.json(await agentConfigStore.saveConnection(request.body));
  } catch (error) {
    next(error);
  }
});

app.get('/api/workspaces/current/tree', async (_request, response, next) => {
  try {
    response.json(await storage.listTree());
  } catch (error) {
    next(error);
  }
});

app.get('/api/workspaces/current/index', (_request, response) => {
  response.json(workspaceIndexer.getIndex());
});

app.post('/api/workspaces/current/index/refresh', async (_request, response, next) => {
  try {
    response.json(await workspaceIndexer.refresh());
  } catch (error) {
    next(error);
  }
});

app.get('/api/workspaces/current/search', (request, response) => {
  response.json(workspaceIndexer.search(String(request.query.q ?? '')));
});

app.get('/api/workspaces/current/files', async (request, response, next) => {
  try {
    const filePath = String(request.query.path ?? 'package/index.md');
    response.json(await storage.readTextFile(filePath));
  } catch (error) {
    next(error);
  }
});

app.put('/api/workspaces/current/files', async (request, response, next) => {
  try {
    const { path: filePath, content } = request.body as { path?: string; content?: string };

    if (!filePath || typeof content !== 'string') {
      response.status(400).json({ error: 'path and content are required.' });
      return;
    }

    const file = await storage.writeTextFile(filePath, content);
    await workspaceIndexer.refresh();
    response.json(file);
  } catch (error) {
    next(error);
  }
});

app.post('/api/agent/messages', async (request, response, next) => {
  try {
    const { content, agentId } = request.body as { content?: string; agentId?: string };

    if (!content?.trim()) {
      response.status(400).json({ error: 'content is required.' });
      return;
    }

    response.json(await agent.sendMessage(content.trim(), agentId));
  } catch (error) {
    next(error);
  }
});

app.get('/api/agent/messages', (_request, response) => {
  response.json(agent.getMessages());
});

app.get('/api/changes', (_request, response) => {
  response.json(changeManager.list());
});

app.post('/api/changes/:id/approve', async (request, response, next) => {
  try {
    const change = await changeManager.approve(request.params.id);
    await workspaceIndexer.refresh();
    response.json(change);
  } catch (error) {
    next(error);
  }
});

app.post('/api/changes/:id/undo', (request, response, next) => {
  try {
    response.json(changeManager.undo(request.params.id));
  } catch (error) {
    next(error);
  }
});

app.post('/api/changes/approve-all', async (_request, response, next) => {
  try {
    const changes = await changeManager.approveAll();
    await workspaceIndexer.refresh();
    response.json(changes);
  } catch (error) {
    next(error);
  }
});

app.post('/api/changes/undo-all', (_request, response) => {
  response.json(changeManager.undoAll());
});

app.post('/api/publish', async (_request, response, next) => {
  try {
    if (changeManager.list().length > 0) {
      response.status(409).json({ error: 'Approve or undo pending changes before publishing.' });
      return;
    }

    response.json(await publisher.publish());
  } catch (error) {
    next(error);
  }
});

app.use((error: unknown, _request: express.Request, response: express.Response, next: express.NextFunction) => {
  void next;
  const message = error instanceof Error ? error.message : 'Unknown server error.';
  console.error(`[api] ${message}`);
  response.status(500).json({ error: message });
});

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => {
  console.log(`Junior Workbench API listening on http://localhost:${port}`);
});
