import { randomUUID } from 'node:crypto';
import type { AgentResponse, ChatMessage, GroundingSnippet, ToolEvent } from '../types.js';
import { AgentConfigStore } from './agentConfigStore.js';
import { AzureOpenAiChatClient } from './azureOpenAiChatClient.js';
import { ChangeManager } from './changeManager.js';
import { GroundingService } from './groundingService.js';
import { LocalWorkspaceStorage } from './localWorkspaceStorage.js';
import { WorkspaceIndexer } from './workspaceIndexer.js';

export class SimpleJuniorAgent {
  private readonly messages: ChatMessage[] = [];

  constructor(
    private readonly storage: LocalWorkspaceStorage,
    private readonly changeManager: ChangeManager,
    private readonly workspaceIndexer: WorkspaceIndexer,
    private readonly agentConfigStore: AgentConfigStore,
    private readonly groundingService: GroundingService,
    private readonly chatClient: AzureOpenAiChatClient
  ) {}

  async sendMessage(content: string, agentId?: string): Promise<AgentResponse> {
    const activeAgent = this.agentConfigStore.getAgent(agentId);
    const connection = this.agentConfigStore.getConnection(activeAgent.modelConnectionId);
    const modelConnection = this.agentConfigStore.getConnectionStatus(activeAgent.modelConnectionId);
    const userMessage = this.createMessage('user', content);
    this.messages.push(userMessage);

    const toolEvents: ToolEvent[] = [];
    const index = await this.workspaceIndexer.refresh();
    const grounding = await this.groundingService.ground(activeAgent, content);
    toolEvents.push(this.createToolEvent(
      'search',
      `Grounded ${activeAgent.name}`,
      `${index.indexedFileCount}/${index.fileCount} workspace files indexed; ${grounding.length} grounding snippet${grounding.length === 1 ? '' : 's'} resolved.`
    ));
    toolEvents.push(this.createToolEvent(
      'read',
      modelConnection.configured ? 'Azure OpenAI connection ready' : 'Azure OpenAI connection needs configuration',
      modelConnection.configured ? `${modelConnection.name} using deployment ${modelConnection.deployment}` : `Missing ${modelConnection.missing.join(', ')}`
    ));
    const packageFiles = await this.storage.readMarkdownPackageFiles();
    toolEvents.push(this.createToolEvent('read', 'Read package documents', `${packageFiles.length} markdown files loaded from the workspace.`));

    const lowerContent = content.toLowerCase();
    const staged = [];

    if (lowerContent.includes('publish')) {
      const assistant = this.createMessage('assistant', 'I can publish once the pending changes are approved. Review the change list, approve what should ship, then use Publish Package.');
      this.messages.push(assistant);
      return {
        message: assistant,
        toolEvents: [...toolEvents, this.createToolEvent('publish', 'Checked publish readiness', 'Publish is blocked while staged changes are pending.')],
        pendingChanges: this.changeManager.list(),
        activeAgent,
        modelConnection,
        grounding
      };
    }

    if (lowerContent.includes('question') || lowerContent.includes('ask')) {
      const assistant = this.createMessage('assistant', 'To complete the approval package, I need the business owner, target Azure subscription, data classification, internet exposure, and required approver group.');
      this.messages.push(assistant);
      return {
        message: assistant,
        toolEvents: [...toolEvents, this.createToolEvent('ask', 'Identified open questions')],
        pendingChanges: this.changeManager.list(),
        activeAgent,
        modelConnection,
        grounding
      };
    }

    const modelDraft = await this.generateDraft(content, activeAgent.instructions, grounding, connection);
    if (modelDraft.usedModel) {
      toolEvents.push(this.createToolEvent('read', 'Generated draft with Azure OpenAI', modelConnection.name));
    } else if (modelDraft.error) {
      toolEvents.push(this.createToolEvent('read', 'Azure OpenAI draft fell back', modelDraft.error));
    }

    const overview = packageFiles.find((file) => file.path.endsWith('system-overview.md'));
    if (overview) {
      staged.push(await this.changeManager.stageFileChange(
        overview.path,
        this.withSection(overview.content, 'Junior Workbench Draft Notes', [
          `Requested update: ${content}`,
          `Agent: ${activeAgent.name}`,
          `Model connection: ${modelConnection.configured ? modelConnection.name : `not configured (${modelConnection.missing.join(', ')})`}`,
          ...this.contextLines(grounding),
          'Azure OpenAI draft:',
          modelDraft.content,
          'The package should capture Azure resources, identities, data flows, threat model status, monitoring, and approval owners.',
          'This draft was staged by the server-side Junior agent service and requires human approval before it is written to the workspace.'
        ]),
        'Add agent-drafted package notes to the system overview.'
      ));
      toolEvents.push(this.createToolEvent('edit', 'Staged system overview update', overview.path, overview.path));
    }

    const checklist = packageFiles.find((file) => file.path.endsWith('approval-checklist.md'));
    if (checklist) {
      staged.push(await this.changeManager.stageFileChange(
        checklist.path,
        this.withSection(checklist.content, 'Agent Follow-up Checklist', [
          '- [ ] Confirm package owner and approver group',
          '- [ ] Attach architecture evidence and data-flow notes',
          '- [ ] Confirm managed identity and RBAC plan',
          '- [ ] Confirm logging, alerting, and incident routing',
          '- [ ] Review final static preview before publishing'
        ]),
        'Add follow-up checklist for security approval readiness.'
      ));
      toolEvents.push(this.createToolEvent('edit', 'Staged approval checklist update', checklist.path, checklist.path));
    }

    const assistant = this.createMessage(
      'assistant',
      staged.length > 0
        ? `I reviewed the workspace and staged ${staged.length} file change${staged.length === 1 ? '' : 's'}. Open the pending changes panel to inspect, approve, or undo them before publishing.`
        : 'I reviewed the package workspace but did not find a markdown document to update yet.'
    );
    this.messages.push(assistant);

    return {
      message: assistant,
      toolEvents,
      pendingChanges: this.changeManager.list(),
      activeAgent,
      modelConnection,
      grounding
    };
  }

  getMessages(): ChatMessage[] {
    return [...this.messages];
  }

  private withSection(content: string, heading: string, lines: string[]): string {
    const marker = `## ${heading}`;
    const section = `${marker}\n\n${lines.join('\n')}\n`;

    if (content.includes(marker)) {
      return content.replace(new RegExp(`${this.escapeRegExp(marker)}[\\s\\S]*?(?=\\n## |$)`), section.trimEnd());
    }

    return `${content.trimEnd()}\n\n${section}`;
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private async generateDraft(content: string, instructions: string, grounding: GroundingSnippet[], connection: Parameters<AzureOpenAiChatClient['complete']>[0]): Promise<{ content: string; usedModel: boolean; error?: string }> {
    const groundingText = grounding.length > 0
      ? grounding.map((snippet) => `- ${snippet.title}: ${snippet.content}`).join('\n')
      : 'No grounding snippets were found. Use the package structure and ask for missing facts.';

    let modelContent: string | null;
    try {
      modelContent = await this.chatClient.complete(connection, [
        { role: 'system', content: instructions },
        { role: 'user', content: `User request:\n${content}\n\nGrounding snippets:\n${groundingText}\n\nDraft concise approval-package notes. Do not claim changes were applied; they will be staged for human approval.` }
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[agent] Azure OpenAI draft failed: ${message}`);
      return {
        content: `Azure OpenAI draft failed, so Junior used a deterministic local draft. Diagnostic: ${message}`,
        usedModel: false,
        error: message
      };
    }

    if (modelContent) {
      return { content: modelContent, usedModel: true };
    }

    return {
      content: 'Azure OpenAI is not configured yet, so Junior used a deterministic local draft. Configure the agent connection environment variables to enable model-authored drafts.',
      usedModel: false
    };
  }

  private contextLines(grounding: GroundingSnippet[]): string[] {
    if (grounding.length === 0) {
      return ['Grounding context: no direct matches were found, so Junior used the package structure as context.'];
    }

    return [
      'Grounding context considered:',
      ...grounding.slice(0, 5).map((snippet) => `- ${snippet.sourceLabel} / ${snippet.title}: ${snippet.content}`)
    ];
  }

  private createMessage(role: ChatMessage['role'], content: string): ChatMessage {
    return {
      id: randomUUID(),
      role,
      content,
      createdAt: new Date().toISOString()
    };
  }

  private createToolEvent(type: ToolEvent['type'], label: string, detail?: string, filePath?: string): ToolEvent {
    return {
      id: randomUUID(),
      type,
      label,
      detail,
      filePath,
      createdAt: new Date().toISOString()
    };
  }
}
