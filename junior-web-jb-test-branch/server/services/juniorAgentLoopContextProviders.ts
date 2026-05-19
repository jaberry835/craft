import type { AgentContextProvider } from './agentLoopFramework.js';
import type { AgentResponse } from '../types.js';
import type { LoopContext } from './juniorAgentLoop.js';
import { GroundingService } from './groundingService.js';
import { WorkspaceIndexer } from './workspaceIndexer.js';
import type { WorkspaceStorage } from './workspaceStorage.js';

export class GroundingContextProvider implements AgentContextProvider<LoopContext, AgentResponse> {
  readonly name = 'grounding-context';

  constructor(
    private readonly workspaceIndexer: WorkspaceIndexer,
    private readonly groundingService: GroundingService
  ) {}

  async beforeRun(context: LoopContext): Promise<void> {
    const index = await this.workspaceIndexer.refresh();
    const grounding = await this.groundingService.ground(context.activeAgent, context.groundingQuery);
    context.index = index;
    context.grounding = grounding;
    context.toolEvents.push({
      id: crypto.randomUUID(),
      type: 'search',
      label: `Grounded ${context.activeAgent.name}`,
      detail: `${index.indexedFileCount}/${index.fileCount} workspace files indexed; ${grounding.length} grounding snippet${grounding.length === 1 ? '' : 's'} resolved.`,
      createdAt: new Date().toISOString()
    });
    context.toolEvents.push({
      id: crypto.randomUUID(),
      type: 'read',
      label: context.modelConnection.configured ? 'Azure OpenAI connection ready' : 'Azure OpenAI connection needs configuration',
      detail: context.modelConnection.configured
        ? `${context.modelConnection.name} using deployment ${context.modelConnection.deployment}`
        : `Missing ${context.modelConnection.missing.join(', ')}`,
      createdAt: new Date().toISOString()
    });
  }
}

export class PackageDocumentsContextProvider implements AgentContextProvider<LoopContext, AgentResponse> {
  readonly name = 'package-documents-context';

  constructor(private readonly storage: WorkspaceStorage) {}

  async beforeRun(context: LoopContext): Promise<void> {
    context.packageFiles = await this.storage.readMarkdownPackageFiles();
    context.toolEvents.push({
      id: crypto.randomUUID(),
      type: 'read',
      label: 'Read package documents',
      detail: `${context.packageFiles.length} markdown files loaded from the workspace.`,
      createdAt: new Date().toISOString()
    });
  }
}