import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import type {
  AgentConnection,
  AgentDefinition,
  AgentRunOptions,
  ChatMessage,
  GroundingSnippet,
  PendingChange,
  ToolEvent,
  WorkspaceFile,
  WorkspaceIndex
} from '../types.js';
import { AgentConfigStore } from '../services/agentConfigStore.js';
import { AzureOpenAiChatClient } from '../services/azureOpenAiChatClient.js';
import { LocalWorkspaceStorage } from '../services/localWorkspaceStorage.js';
import { createWorkspaceTools } from '../services/tools/workspaceTools.js';
import type { LoopToolContext } from '../services/tools/types.js';
import type { ChatCompletionResult, ChatMessageInput, ChatToolDefinition } from '../services/azureOpenAiChatClient.js';
import { cleanupHarness, createHarness, createToolCall, FakeAzureOpenAiChatClient } from './testHarness.js';

async function readWorkspaceFile(storage: LocalWorkspaceStorage, filePath: string): Promise<string> {
  return (await storage.readTextFile(filePath)).content;
}

async function expectMissingWorkspaceFile(storage: LocalWorkspaceStorage, filePath: string): Promise<void> {
  await assert.rejects(() => storage.readTextFile(filePath));
}

function createToolContext(agent: AgentDefinition, connection: AgentConnection, index: WorkspaceIndex): LoopToolContext {
  const modelConnection = {
    id: connection.id,
    name: connection.name,
    type: connection.type,
    configured: true,
    missing: [],
    authMode: connection.authMode ?? 'entra',
    cloud: connection.cloud ?? 'public',
    endpoint: connection.endpoint,
    endpointEnv: connection.endpointEnv,
    hasApiKey: false,
    apiKeyEnv: connection.apiKeyEnv,
    credentialScope: connection.credentialScope,
    audience: undefined,
    deployment: connection.type === 'azure-openai' ? connection.deployment : undefined,
    deploymentEnv: connection.type === 'azure-openai' ? connection.deploymentEnv : undefined,
    apiVersion: connection.type === 'azure-openai' ? connection.apiVersion ?? connection.defaultApiVersion : undefined,
    defaultApiVersion: connection.type === 'azure-openai' ? connection.defaultApiVersion : undefined,
    temperature: connection.type === 'azure-openai' ? connection.temperature : undefined,
    maxTokens: connection.type === 'azure-openai' ? connection.maxTokens : undefined,
    indexNames: connection.type === 'azure-ai-search' ? connection.indexNames : undefined,
    semanticConfigurations: connection.type === 'azure-ai-search' ? connection.semanticConfigurations : undefined,
    queryType: connection.type === 'azure-ai-search' ? connection.queryType : undefined,
    top: connection.type === 'azure-ai-search' ? connection.top : undefined
  };

  return {
    content: 'Create a file for smoke testing.',
    options: {} as AgentRunOptions,
    chatHistory: [],
    groundingQuery: 'Create a file for smoke testing.',
    activeAgent: agent,
    connection: connection as ReturnType<AgentConfigStore['getConnection']>,
    modelConnection,
    toolEvents: [] as ToolEvent[],
    index,
    grounding: [] as GroundingSnippet[],
    packageFiles: [] as WorkspaceFile[],
    staged: [] as PendingChange[],
    stop: false,
    appliedChangeCount: 0,
    iteration: 0,
    loopMessages: [] as ChatMessage[],
    availableTools: [],
    state: new Map<string, unknown>()
  };
}

class FailingAzureOpenAiChatClient extends AzureOpenAiChatClient {
  override async completeWithTools(): Promise<never> {
    throw new Error('Azure OpenAI request could not reach example.test deployment gpt-test: connect ECONNREFUSED');
  }
}

class HistoryAwareAzureOpenAiChatClient extends AzureOpenAiChatClient {
  private plannerCallCount = 0;
  private readonly joke = 'Why did the developer go broke? Because he used up all his cache.';

  override async completeWithTools(
    _connection: AgentConnection,
    messages: ChatMessageInput[],
    tools?: ChatToolDefinition[]
  ): Promise<ChatCompletionResult> {
    if (!tools || tools.length === 0) {
      return { content: null, toolCalls: [] };
    }

    this.plannerCallCount += 1;

    if (this.plannerCallCount === 1) {
      return {
        content: this.joke,
        toolCalls: []
      };
    }

    if (this.plannerCallCount === 2) {
      const hasPriorJoke = messages.some((message) => message.role === 'assistant' && message.content?.includes(this.joke));
      assert.equal(hasPriorJoke, true, 'expected prior assistant reply to be included in the next planner call');

      return {
        content: 'I will add the joke to jokes.md.',
        toolCalls: [createToolCall('write_file', {
          path: 'uploads/jokes.md',
          content: `# Jokes\n\n- ${this.joke}\n`,
          summary: 'Create a jokes file from the prior assistant reply.'
        })]
      };
    }

    if (this.plannerCallCount === 3) {
      return {
        content: 'The joke is staged in uploads/jokes.md.',
        toolCalls: []
      };
    }

    return { content: null, toolCalls: [] };
  }
}

class PresentationAwareAzureOpenAiChatClient extends AzureOpenAiChatClient {
  override async completeWithTools(
    _connection: AgentConnection,
    messages: ChatMessageInput[],
    tools?: ChatToolDefinition[]
  ): Promise<ChatCompletionResult> {
    if (!tools || tools.length === 0) {
      return { content: null, toolCalls: [] };
    }

    const hasSystemGuidance = messages.some((message) =>
      message.role === 'system'
      && message.content?.includes('write plain text for an in-app chat surface')
      && message.content?.includes('Avoid markdown headings')
    );
    assert.equal(hasSystemGuidance, true, 'expected the loop to include shared direct-answer presentation guidance');

    const plannerPrompt = messages.at(-1);
    assert.equal(plannerPrompt?.role, 'user');
    assert.match(plannerPrompt?.content ?? '', /write plain text for an in-app chat surface/i);
    assert.match(plannerPrompt?.content ?? '', /avoid markdown headings/i);

    return {
      content: 'This workspace stores drafts, configs, and staged file changes for the Junior web workbench.',
      reasoning: 'Use a plain-text chat answer because no tool is needed.',
      toolCalls: []
    };
  }
}

class ReasoningEffortAwareAzureOpenAiChatClient extends AzureOpenAiChatClient {
  override async completeWithTools(
    _connection: AgentConnection,
    _messages: ChatMessageInput[],
    tools?: ChatToolDefinition[],
    options?: import('../services/azureOpenAiChatClient.js').ChatCompletionOptions
  ): Promise<ChatCompletionResult> {
    if (!tools || tools.length === 0) {
      return { content: null, toolCalls: [] };
    }

    assert.equal(options?.reasoningEffort, 'high');

    return {
      content: 'Reasoning effort reached the planner call.',
      toolCalls: []
    };
  }
}

class AgentAiSettingsAwareAzureOpenAiChatClient extends AzureOpenAiChatClient {
  override async completeWithTools(
    _connection: AgentConnection,
    _messages: ChatMessageInput[],
    tools?: ChatToolDefinition[],
    options?: import('../services/azureOpenAiChatClient.js').ChatCompletionOptions
  ): Promise<ChatCompletionResult> {
    if (!tools || tools.length === 0) {
      return { content: null, toolCalls: [] };
    }

    assert.equal(options?.reasoningEffort, 'high');
    assert.equal(options?.temperature, 0.9);
    assert.equal(options?.maxTokens, 2048);

    return {
      content: 'Agent AI settings reached the planner call.',
      toolCalls: []
    };
  }
}

class SequentialMultiFileAzureOpenAiChatClient extends AzureOpenAiChatClient {
  private plannerCallCount = 0;

  override async completeWithTools(
    _connection: AgentConnection,
    _messages: ChatMessageInput[],
    tools?: ChatToolDefinition[]
  ): Promise<ChatCompletionResult> {
    if (!tools || tools.length === 0) {
      return { content: null, toolCalls: [] };
    }

    this.plannerCallCount += 1;

    if (this.plannerCallCount === 1) {
      return {
        content: 'I will create the joke file first.',
        toolCalls: [createToolCall('write_file', {
          path: 'joker.md',
          content: '# Jokes\n\n1. Why did the scarecrow win an award? Because he was outstanding in his field.\n',
          summary: 'Create the numbered joke file.'
        })]
      };
    }

    if (this.plannerCallCount === 2) {
      return {
        content: 'Now I will create the punchline file.',
        toolCalls: [createToolCall('write_file', {
          path: 'punchline.md',
          content: '# Punchlines\n\n1. Because he was outstanding in his field.\n',
          summary: 'Create the numbered punchline file.'
        })]
      };
    }

    if (this.plannerCallCount === 3) {
      return {
        content: 'Both derivative files are staged.',
        toolCalls: []
      };
    }

    return { content: null, toolCalls: [] };
  }
}

class BatchedMultiFileAzureOpenAiChatClient extends AzureOpenAiChatClient {
  override async completeWithTools(
    _connection: AgentConnection,
    _messages: ChatMessageInput[],
    tools?: ChatToolDefinition[]
  ): Promise<ChatCompletionResult> {
    if (!tools || tools.length === 0) {
      return { content: null, toolCalls: [] };
    }

    return {
      content: 'I will create both derivative files now.',
      toolCalls: [
        createToolCall('write_file', {
          path: 'joker.md',
          content: '# Jokes\n\n1. Why did the scarecrow win an award?\n',
          summary: 'Create the numbered joke file.'
        }),
        createToolCall('write_file', {
          path: 'punchline.md',
          content: '# Punchlines\n\n1. Because he was outstanding in his field.\n',
          summary: 'Create the numbered punchline file.'
        })
      ]
    };
  }
}

class ReadThenRewriteAzureOpenAiChatClient extends AzureOpenAiChatClient {
  private plannerCallCount = 0;

  override async completeWithTools(
    _connection: AgentConnection,
    messages: ChatMessageInput[],
    tools?: ChatToolDefinition[]
  ): Promise<ChatCompletionResult> {
    if (!tools || tools.length === 0) {
      return { content: null, toolCalls: [] };
    }

    this.plannerCallCount += 1;

    if (this.plannerCallCount === 1) {
      return {
        content: 'I will read jokes.md first.',
        toolCalls: [createToolCall('read_file', {
          path: 'jokes.md'
        })]
      };
    }

    if (this.plannerCallCount === 2) {
      const sawFileBody = messages.some((message) => message.role === 'tool' && message.content?.includes('Why did the scarecrow win an award? Because he was outstanding in his field.'));
      assert.equal(sawFileBody, true, 'expected read_file output to include actual file contents in the next planner call');

      return {
        content: 'I can now split the joke setup and punchline into two files.',
        toolCalls: [
          createToolCall('write_file', {
            path: 'joker.md',
            content: '# Jokes\n\n1. Why did the scarecrow win an award?\n',
            summary: 'Create the numbered joke setup file.'
          }),
          createToolCall('write_file', {
            path: 'punchline.md',
            content: '# Punchlines\n\n1. Because he was outstanding in his field.\n',
            summary: 'Create the numbered punchline file.'
          })
        ]
      };
    }

    return {
      content: 'Both rewrite files are staged.',
      toolCalls: []
    };
  }
}

test('agent stages a new workspace file when auto-apply is off', async (t) => {
  const harness = await createHarness(new FakeAzureOpenAiChatClient({
    plannerResponses: [
      {
        content: 'I will create an agent notes file.',
        toolCalls: [createToolCall('write_file', {
          path: 'package/agent-notes.md',
          content: '# Agent Notes\n\nCreated by the smoke test.\n',
          summary: 'Create agent notes file.'
        })]
      },
      {
        content: 'The file is staged for review.',
        toolCalls: []
      }
    ]
  }));
  t.after(async () => cleanupHarness(harness));

  const response = await harness.agent.sendMessage('Create an agent notes file for review.', undefined, { autoApproveChanges: false });

  assert.equal(response.changeHandling, 'review');
  assert.equal(response.appliedChangeCount, 0);
  assert.equal(response.pendingChanges.length, 1);
  assert.equal(response.pendingChanges[0]?.action, 'create');
  assert.equal(response.pendingChanges[0]?.path, 'package/agent-notes.md');
  assert.equal((await harness.changeManager.list()).length, 1);
  await expectMissingWorkspaceFile(harness.storage, 'package/agent-notes.md');
});

test('agent auto-applies a new workspace file when enabled', async (t) => {
  const harness = await createHarness(new FakeAzureOpenAiChatClient({
    plannerResponses: [
      {
        content: 'I will create an agent notes file.',
        toolCalls: [createToolCall('write_file', {
          path: 'package/agent-notes.md',
          content: '# Agent Notes\n\nCreated by the smoke test.\n',
          summary: 'Create agent notes file.'
        })]
      },
      {
        content: 'The file was created.',
        toolCalls: []
      }
    ]
  }));
  t.after(async () => cleanupHarness(harness));

  const response = await harness.agent.sendMessage('Create and apply an agent notes file.', undefined, { autoApproveChanges: true });

  assert.equal(response.changeHandling, 'auto-apply');
  assert.equal(response.appliedChangeCount, 1);
  assert.equal(response.pendingChanges.length, 0);
  assert.equal((await harness.changeManager.list()).length, 0);
  assert.match(await readWorkspaceFile(harness.storage, 'package/agent-notes.md'), /Created by the smoke test\./);
  assert.equal((await harness.workspaceIndexer.refresh()).fileCount >= 2, true);
});

test('agent falls back to deterministic package drafting when the model returns no draft text', async (t) => {
  const harness = await createHarness(new FakeAzureOpenAiChatClient({ draftResponses: [null] }));
  t.after(async () => cleanupHarness(harness));

  await harness.storage.writeTextFile('package/system-overview.md', '# System Overview\n');
  await harness.storage.writeTextFile('package/approval-checklist.md', '# Approval Checklist\n');
  await harness.workspaceIndexer.refresh();

  const response = await harness.agent.sendMessage('Draft the next security approval package updates.', undefined, { autoApproveChanges: false });

  assert.equal(response.pendingChanges.length, 2);
  const systemOverviewChange = response.pendingChanges.find((change) => change.path === 'package/system-overview.md');
  const checklistChange = response.pendingChanges.find((change) => change.path === 'package/approval-checklist.md');
  assert.ok(systemOverviewChange);
  assert.ok(checklistChange);
  assert.match(systemOverviewChange.proposedContent, /Azure OpenAI is not configured yet, so Junior used a deterministic local draft\./);
  await assert.rejects(() => readFile(path.join(harness.rootDir, 'workspace', 'package', 'agent-notes.md'), 'utf8'));
});

test('custom file-building agents do not fall back to generic package drafting', async (t) => {
  const harness = await createHarness(new FakeAzureOpenAiChatClient());
  t.after(async () => cleanupHarness(harness));

  const createdAgent = await harness.agentConfigStore.createAgent({
    name: 'File Builder',
    description: 'Creates workspace files',
    instructions: 'Create or update workspace files that the user requests.',
    modelConnectionId: 'default-azure-openai'
  });
  const response = await harness.agent.sendMessage('Create a release notes file for this workspace.', createdAgent.id, { autoApproveChanges: true });

  assert.equal(response.appliedChangeCount, 0);
  assert.equal(response.pendingChanges.length, 0);
  assert.equal(response.message.content, 'I inspected the workspace for agent "File Builder", but it did not produce a file action for that request.');
});

test('agent can return a direct plain-text reply when no file action is needed', async (t) => {
  const harness = await createHarness(new FakeAzureOpenAiChatClient({
    plannerResponses: [
      {
        content: 'Here is a direct answer without changing files.',
        toolCalls: []
      }
    ]
  }));
  t.after(async () => cleanupHarness(harness));

  const createdAgent = await harness.agentConfigStore.createAgent({
    name: 'General File Builder',
    description: 'Can chat or edit files',
    instructions: 'Answer directly when no workspace file change is needed. Create or update files only when the user explicitly asks for edits.',
    modelConnectionId: 'default-azure-openai'
  });

  const response = await harness.agent.sendMessage('What is this workspace for?', createdAgent.id, { autoApproveChanges: true });

  assert.equal(response.appliedChangeCount, 0);
  assert.equal(response.pendingChanges.length, 0);
  assert.equal(response.message.content, 'Here is a direct answer without changing files.');
});

test('agent includes plain-text presentation guidance when planning a direct reply', async (t) => {
  const harness = await createHarness(new PresentationAwareAzureOpenAiChatClient());
  t.after(async () => cleanupHarness(harness));

  const createdAgent = await harness.agentConfigStore.createAgent({
    name: 'Chatty Analyst',
    description: 'Answers questions without editing files when possible.',
    instructions: 'Answer directly when no workspace change is needed.',
    modelConnectionId: 'default-azure-openai'
  });

  const response = await harness.agent.sendMessage('What is this workspace for?', createdAgent.id, { autoApproveChanges: false });

  assert.equal(response.appliedChangeCount, 0);
  assert.equal(response.pendingChanges.length, 0);
  assert.equal(response.message.content, 'This workspace stores drafts, configs, and staged file changes for the Junior web workbench.');
  assert.equal(Array.isArray(response.message.display), true);
  assert.deepEqual(response.message.display?.find((part) => part.kind === 'reasoning'), {
    kind: 'reasoning',
    text: 'Use a plain-text chat answer because no tool is needed.'
  });
});

test('agent carries prior chat context into a follow-up file creation turn', async (t) => {
  const harness = await createHarness(new HistoryAwareAzureOpenAiChatClient());
  t.after(async () => cleanupHarness(harness));

  const createdAgent = await harness.agentConfigStore.createAgent({
    name: 'Conversation File Builder',
    description: 'Uses prior chat replies when creating files.',
    instructions: 'Answer directly when the user is chatting. When the user asks to save prior content, use the prior conversation context to create the file they requested.',
    modelConnectionId: 'default-azure-openai'
  });

  const firstResponse = await harness.agent.sendMessage('Tell me a joke.', createdAgent.id, { autoApproveChanges: false });
  assert.equal(firstResponse.message.content, 'Why did the developer go broke? Because he used up all his cache.');

  const secondResponse = await harness.agent.sendMessage(
    'Add this joke to a new file called jokes.md.',
    createdAgent.id,
    { autoApproveChanges: false },
    firstResponse.sessionId
  );

  assert.equal(secondResponse.sessionId, firstResponse.sessionId);
  assert.equal(secondResponse.pendingChanges.length, 1);
  assert.equal(secondResponse.pendingChanges[0]?.path, 'uploads/jokes.md');
  assert.match(secondResponse.pendingChanges[0]?.proposedContent ?? '', /Because he used up all his cache\./);
});

test('agent passes its reasoning effort into planner requests', async (t) => {
  const harness = await createHarness(new ReasoningEffortAwareAzureOpenAiChatClient());
  t.after(async () => cleanupHarness(harness));

  const createdAgent = await harness.agentConfigStore.createAgent({
    name: 'Reasoning Tester',
    description: 'Checks agent reasoning level configuration.',
    instructions: 'Answer directly when no workspace change is needed.',
    modelConnectionId: 'default-azure-openai',
    reasoningEffort: 'high'
  });

  const response = await harness.agent.sendMessage('What is this workspace for?', createdAgent.id, { autoApproveChanges: false });
  assert.equal(response.message.content, 'Reasoning effort reached the planner call.');
});

test('agent passes aiSettings overrides into planner requests', async (t) => {
  const harness = await createHarness(new AgentAiSettingsAwareAzureOpenAiChatClient());
  t.after(async () => cleanupHarness(harness));

  const createdAgent = await harness.agentConfigStore.createAgent({
    name: 'AI Settings Tester',
    description: 'Checks agent AI overrides.',
    instructions: 'Answer directly when no workspace change is needed.',
    modelConnectionId: 'default-azure-openai',
    reasoningEffort: 'high',
    aiSettings: {
      temperature: 0.9,
      maxTokens: 2048
    }
  });

  const response = await harness.agent.sendMessage('What is this workspace for?', createdAgent.id, { autoApproveChanges: false });
  assert.equal(response.message.content, 'Agent AI settings reached the planner call.');
});

test('agent can call write_file more than once across planner turns', async (t) => {
  const harness = await createHarness(new SequentialMultiFileAzureOpenAiChatClient());
  t.after(async () => cleanupHarness(harness));

  const response = await harness.agent.sendMessage('Take each joke in jokes.md and split it into joker.md and punchline.md.', undefined, { autoApproveChanges: false });

  assert.equal(response.pendingChanges.length, 2);
  assert.equal(response.pendingChanges[0]?.path, 'joker.md');
  assert.equal(response.pendingChanges[1]?.path, 'punchline.md');
  assert.match(response.pendingChanges[0]?.proposedContent ?? '', /^# Jokes/m);
  assert.match(response.pendingChanges[1]?.proposedContent ?? '', /^# Punchlines/m);
});

test('agent executes multiple tool calls returned in a single planner turn', async (t) => {
  const harness = await createHarness(new BatchedMultiFileAzureOpenAiChatClient());
  t.after(async () => cleanupHarness(harness));

  const response = await harness.agent.sendMessage('Take each joke in jokes.md and split it into joker.md and punchline.md.', undefined, { autoApproveChanges: false });

  assert.equal(response.pendingChanges.length, 2);
  assert.equal(response.pendingChanges[0]?.path, 'joker.md');
  assert.equal(response.pendingChanges[1]?.path, 'punchline.md');
});

test('agent keeps read_file contents in loop context for derivative rewrites', async (t) => {
  const harness = await createHarness(new ReadThenRewriteAzureOpenAiChatClient());
  t.after(async () => cleanupHarness(harness));

  await harness.storage.writeTextFile('jokes.md', '# Jokes\n\nWhy did the scarecrow win an award? Because he was outstanding in his field.\n');

  const response = await harness.agent.sendMessage(
    'Take each joke in jokes.md and rewrite it into joker.md and punchline.md with numbered entries.',
    undefined,
    { autoApproveChanges: false }
  );

  assert.equal(response.pendingChanges.length, 2);
  assert.equal(response.pendingChanges[0]?.path, 'joker.md');
  assert.equal(response.pendingChanges[1]?.path, 'punchline.md');
  assert.match(response.pendingChanges[0]?.proposedContent ?? '', /1\. Why did the scarecrow win an award\?/);
  assert.match(response.pendingChanges[1]?.proposedContent ?? '', /1\. Because he was outstanding in his field\./);
});

test('agent returns a clear message when its model connection is not configured', async (t) => {
  const harness = await createHarness(new FakeAzureOpenAiChatClient());
  t.after(async () => cleanupHarness(harness));

  await harness.agentConfigStore.saveConnection({
    id: 'default-azure-openai',
    name: 'Default Azure OpenAI',
    type: 'azure-openai',
    authMode: 'entra',
    endpoint: '',
    deployment: ''
  });

  const response = await harness.agent.sendMessage('Create a release notes file for this workspace.', undefined, { autoApproveChanges: true });

  assert.equal(response.appliedChangeCount, 0);
  assert.equal(response.pendingChanges.length, 0);
  assert.match(response.message.content, /is using model connection .* but it is not fully configured yet/i);
});

test('agent surfaces an unavailable LLM connection in the chat reply', async (t) => {
  const harness = await createHarness(new FailingAzureOpenAiChatClient());
  t.after(async () => cleanupHarness(harness));

  const response = await harness.agent.sendMessage('Say hello.', undefined, { autoApproveChanges: true });

  assert.equal(response.appliedChangeCount, 0);
  assert.equal(response.pendingChanges.length, 0);
  assert.match(response.message.content, /The connection to the LLM is not available right now/i);
  assert.match(response.message.content, /could not reach/i);
});

test('write_file stages a create change for a new workspace file', async (t) => {
  const harness = await createHarness(new FakeAzureOpenAiChatClient());
  t.after(async () => cleanupHarness(harness));

  const tools = createWorkspaceTools({
    changeManager: harness.changeManager,
    storage: harness.storage,
    workspaceIndexer: harness.workspaceIndexer
  });
  const writeFileTool = tools.find((tool) => tool.definition.name === 'write_file');
  assert.ok(writeFileTool);

  const agent = harness.agentConfigStore.getAgent();
  const connection = harness.agentConfigStore.getConnection(agent.modelConnectionId);
  const context = createToolContext(agent, connection, harness.workspaceIndexer.getIndex());

  const result = await writeFileTool.execute(context, {
    path: 'uploads/smoke-created.md',
    content: '# Smoke Test\n',
    summary: 'Create smoke test file.'
  });

  assert.equal(result.success, true);
  assert.equal(context.staged.length, 1);
  assert.equal(context.staged[0]?.action, 'create');
  assert.equal(context.staged[0]?.path, 'uploads/smoke-created.md');
  await expectMissingWorkspaceFile(harness.storage, 'uploads/smoke-created.md');
});

test('agent auto-applies create_directory by writing a folder placeholder file', async (t) => {
  const harness = await createHarness(new FakeAzureOpenAiChatClient({
    plannerResponses: [
      {
        content: 'I will create a folder for generated notes.',
        toolCalls: [createToolCall('create_directory', {
          path: 'uploads/generated-notes',
          summary: 'Create generated notes folder.'
        })]
      },
      {
        content: 'The folder was created.',
        toolCalls: []
      }
    ]
  }));
  t.after(async () => cleanupHarness(harness));

  const response = await harness.agent.sendMessage('Create a folder called uploads/generated-notes.', undefined, { autoApproveChanges: true });

  assert.equal(response.changeHandling, 'auto-apply');
  assert.equal(response.appliedChangeCount, 1);
  assert.equal(response.pendingChanges.length, 0);
  assert.equal(await readWorkspaceFile(harness.storage, 'uploads/generated-notes/.keep'), '');

  const tree = await harness.storage.listTree();
  const hasDirectory = tree.some((node) => node.path === 'uploads' && node.children?.some((child) => child.path === 'uploads/generated-notes'));
  assert.equal(hasDirectory, true);
});

test('agent can execute an attached HTTP MCP tool', async (t) => {
  const mcpServer = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }

    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id: number; method: string; params?: Record<string, unknown> };
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Mcp-Session-Id', 'smoke-session');

    if (body.method === 'initialize') {
      response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2024-11-05', capabilities: {} } }));
      return;
    }

    if (body.method === 'tools/list') {
      response.end(JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          tools: [
            {
              name: 'lookup_docs',
              description: 'Return a short documentation summary.',
              inputSchema: {
                type: 'object',
                properties: { topic: { type: 'string' } },
                required: ['topic']
              }
            }
          ]
        }
      }));
      return;
    }

    if (body.method === 'tools/call') {
      const toolArgs = (body.params?.arguments ?? {}) as { topic?: string };
      response.end(JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          content: [{ type: 'text', text: `Docs summary for ${String(toolArgs.topic ?? 'unknown')}` }]
        }
      }));
      return;
    }

    response.statusCode = 400;
    response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { message: `Unexpected method ${body.method}` } }));
  });

  await new Promise<void>((resolve) => mcpServer.listen(0, '127.0.0.1', () => resolve()));
  t.after(async () => {
    await new Promise<void>((resolve, reject) => mcpServer.close((error) => error ? reject(error) : resolve()));
  });

  const address = mcpServer.address();
  assert.ok(address && typeof address !== 'string');
  const harness = await createHarness(new FakeAzureOpenAiChatClient({
    plannerResponses: [
      {
        content: 'I will look this up with MCP.',
        toolCalls: [createToolCall('call_mcp_tool', {
          serverId: 'docs-mcp',
          toolName: 'lookup_docs',
          arguments: { topic: 'workspace config' }
        })]
      },
      {
        content: 'The MCP lookup finished.',
        toolCalls: []
      }
    ]
  }));
  t.after(async () => cleanupHarness(harness));

  await harness.agentConfigStore.saveMcpServer({
    id: 'docs-mcp',
    name: 'Docs MCP',
    transport: 'http',
    endpoint: `http://127.0.0.1:${address.port}/mcp`,
    authMode: 'none'
  });
  const agent = await harness.agentConfigStore.createAgent({
    name: 'MCP Researcher',
    description: 'Uses MCP tools',
    instructions: 'Use attached MCP tools when they are relevant.',
    modelConnectionId: 'default-azure-openai',
    mcpServerIds: ['docs-mcp']
  });

  const response = await harness.agent.sendMessage('Use MCP to look up workspace config.', agent.id, { autoApproveChanges: false });

  assert.equal(response.pendingChanges.length, 0);
  assert.equal(response.toolEvents.some((event) => event.label.includes('Called MCP tool lookup_docs')), true);
  assert.equal(response.message.content, 'The MCP lookup finished.');
});