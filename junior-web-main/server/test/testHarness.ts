import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createWorkbenchApp, type WorkbenchAppOptions } from '../app.js';
import type { AgentConnection, AgentDefinition, AgentTemplateDefinition, McpCatalogEntry, WorkspaceTemplateDefinition } from '../types.js';
import { AgentConfigStore } from '../services/agentConfigStore.js';
import {
  AzureOpenAiChatClient,
  type ChatCompletionOptions,
  type ChatCompletionResult,
  type ChatMessageInput,
  type ChatToolCall,
  type ChatToolDefinition
} from '../services/azureOpenAiChatClient.js';
import { ChangeManager } from '../services/changeManager.js';
import { GroundingService } from '../services/groundingService.js';
import { InMemoryPendingChangeStore } from '../services/inMemoryPendingChangeStore.js';
import { LocalWorkspaceStorage } from '../services/localWorkspaceStorage.js';
import { LocalWorkspaceManager } from '../services/localWorkspaceManager.js';
import { createChatSessionStore, createWorkspaceMetadataStore, createWorkspaceSecretStore, createWorkspaceStateStore } from '../services/persistenceFactories.js';
import { SimpleJuniorAgent } from '../services/simpleJuniorAgent.js';
import { WorkspaceConfigStore } from '../services/workspaceConfigStore.js';
import { WorkspaceIndexer } from '../services/workspaceIndexer.js';
import type { WorkspaceSummary } from '../types.js';

export class FakeAzureOpenAiChatClient extends AzureOpenAiChatClient {
  private readonly plannerResponses: ChatCompletionResult[];
  private readonly draftResponses: Array<string | null>;

  constructor(options: { plannerResponses?: ChatCompletionResult[]; draftResponses?: Array<string | null> } = {}) {
    super();
    this.plannerResponses = [...(options.plannerResponses ?? [])];
    this.draftResponses = [...(options.draftResponses ?? [])];
  }

  override async completeWithTools(
    _connection: AgentConnection,
    _messages: ChatMessageInput[],
    tools?: ChatToolDefinition[],
    _options?: ChatCompletionOptions
  ): Promise<ChatCompletionResult> {
    if (tools && tools.length > 0) {
      return this.plannerResponses.shift() ?? { content: null, toolCalls: [] };
    }

    return {
      content: this.draftResponses.shift() ?? null,
      toolCalls: []
    };
  }
}

export interface TestHarness {
  rootDir: string;
  configRoot: string;
  workspacesRoot: string;
  workspaceRoot: string;
  storage: LocalWorkspaceStorage;
  changeManager: ChangeManager;
  workspaceIndexer: WorkspaceIndexer;
  agentConfigStore: AgentConfigStore;
  agent: SimpleJuniorAgent;
  workspaceManager: LocalWorkspaceManager;
}

export async function createHarness(chatClient: AzureOpenAiChatClient): Promise<TestHarness> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'junior-web-smoke-'));
  const configRoot = path.join(rootDir, 'config');
  const workspacesRoot = path.join(rootDir, 'workspaces');
  const workspaceRoot = path.join(workspacesRoot, 'default');
  await mkdir(configRoot, { recursive: true });

  const agents: AgentDefinition[] = [
    {
      id: 'security-package-drafter',
      name: 'Security Package Drafter',
      description: 'Smoke test agent',
      instructions: 'Inspect the workspace before writing. Use tools when needed.',
      modelConnectionId: 'default-azure-openai',
      tools: ['read_file', 'search_files', 'grep_search', 'identify-open-questions', 'draft-package-updates', 'write_file', 'edit_file'],
      groundingSources: [
        {
          id: 'workspace',
          type: 'workspace-index',
          label: 'Workspace index',
          enabled: true,
          top: 5
        }
      ]
    }
  ];
  const connections: AgentConnection[] = [
    {
      id: 'default-azure-openai',
      name: 'Default Azure OpenAI',
      type: 'azure-openai',
      authMode: 'entra',
      endpoint: 'https://example.test',
      deployment: 'gpt-test',
      defaultApiVersion: '2025-01-01-preview'
    }
  ];
  const mcpServers: [] = [];
  const agentTemplates: AgentTemplateDefinition[] = [
    {
      id: 'research-analyst',
      name: 'Research Analyst',
      description: 'Builds structured research notes and comparison files.',
      instructions: 'You create structured research notes and comparison files directly in the workspace.',
      suggestedModelConnectionId: 'default-azure-openai'
    }
  ];
  const mcpCatalog: McpCatalogEntry[] = [
    {
      id: 'azure-docs-mcp',
      name: 'Azure Docs MCP',
      description: 'Known hosted MCP endpoint for Azure documentation lookups.',
      transport: 'http',
      endpoint: 'https://docs.example.test/mcp',
      authMode: 'entra',
      audience: 'api://docs/.default'
    }
  ];
  const workspaceTemplates: WorkspaceTemplateDefinition[] = [
    {
      id: 'research-workspace',
      name: 'Research Workspace',
      description: 'Template for research and comparison workspaces.',
      agentTemplateIds: ['research-analyst'],
      mcpCatalogIds: ['azure-docs-mcp'],
      connectorIds: ['default-azure-openai']
    }
  ];

  await Promise.all([
    writeFile(path.join(configRoot, 'agents.json'), `${JSON.stringify(agents, null, 2)}\n`, 'utf8'),
    writeFile(path.join(configRoot, 'agent-connections.json'), `${JSON.stringify(connections, null, 2)}\n`, 'utf8'),
    writeFile(path.join(configRoot, 'mcp-servers.json'), `${JSON.stringify(mcpServers, null, 2)}\n`, 'utf8'),
    writeFile(path.join(configRoot, 'agent-templates.json'), `${JSON.stringify(agentTemplates, null, 2)}\n`, 'utf8'),
    writeFile(path.join(configRoot, 'mcp-catalog.json'), `${JSON.stringify(mcpCatalog, null, 2)}\n`, 'utf8'),
    writeFile(path.join(configRoot, 'workspace-templates.json'), `${JSON.stringify(workspaceTemplates, null, 2)}\n`, 'utf8')
  ]);

  const agentConfigStore = new AgentConfigStore(configRoot);
  await agentConfigStore.load();
  const workspaceMetadataStore = createWorkspaceMetadataStore(workspacesRoot);
  let storage!: LocalWorkspaceStorage;
  let workspaceIndexer!: WorkspaceIndexer;
  let changeManager!: ChangeManager;
  let agent!: SimpleJuniorAgent;
  const workspaceManager = new LocalWorkspaceManager(workspacesRoot, async (workspace: WorkspaceSummary) => {
    const nextStorage = new LocalWorkspaceStorage(workspace.rootPath);
    await nextStorage.ensureSeedWorkspace();
    const nextWorkspaceStateStore = createWorkspaceStateStore(workspace, nextStorage);
    const nextWorkspaceSecretStore = createWorkspaceSecretStore(workspace);
    const nextConfigStore = new WorkspaceConfigStore(nextWorkspaceStateStore, nextWorkspaceSecretStore, agentConfigStore);
    await nextConfigStore.load();
    const nextIndexer = new WorkspaceIndexer(nextStorage);
    await nextIndexer.refresh();
    const groundingService = new GroundingService(
      nextIndexer,
      (connectionId) => nextConfigStore.getSearchConnection(connectionId),
      (connection) => nextConfigStore.resolveApiKey(connection)
    );
    const nextPendingChangeStore = new InMemoryPendingChangeStore();
    const nextChangeManager = new ChangeManager(nextStorage, nextPendingChangeStore);
    const nextSessionStore = createChatSessionStore(workspace);
    const nextAgent = new SimpleJuniorAgent(nextStorage, nextChangeManager, nextIndexer, nextConfigStore, groundingService, chatClient, nextSessionStore);

    const runtime = {
      ...workspace,
      storage: nextStorage,
      configStore: nextConfigStore,
      workspaceIndexer: nextIndexer,
      changeManager: nextChangeManager,
      agent: nextAgent
    };

    if (workspace.id === 'default') {
      storage = nextStorage;
      workspaceIndexer = nextIndexer;
      changeManager = nextChangeManager;
      agent = nextAgent;
    }

    return runtime;
  }, workspaceMetadataStore);
  await workspaceManager.load();

  return {
    rootDir,
    configRoot,
    workspacesRoot,
    workspaceRoot,
    storage,
    changeManager,
    workspaceIndexer,
    agentConfigStore,
    agent,
    workspaceManager
  };
}

export function createToolCall(name: string, args: Record<string, unknown>): ChatToolCall {
  return {
    id: crypto.randomUUID(),
    type: 'function',
    function: {
      name,
      arguments: JSON.stringify(args)
    }
  };
}

export async function cleanupHarness(harness: TestHarness): Promise<void> {
  await rm(harness.rootDir, { recursive: true, force: true });
}

export async function startHarnessServer(
  harness: TestHarness,
  options: { appOptions?: WorkbenchAppOptions } = {}
): Promise<{ server: Server; baseUrl: string }> {
  const app = createWorkbenchApp({
    agentConfigStore: harness.agentConfigStore,
    workspaceManager: harness.workspaceManager
  }, options.appOptions);

  const server = await new Promise<Server>((resolve) => {
    const nextServer = app.listen(0, () => resolve(nextServer));
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected an ephemeral TCP listener.');
  }

  return {
    server,
    baseUrl: `http://127.0.0.1:${(address as AddressInfo).port}`
  };
}

export async function stopHarnessServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}