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

export class WorkspaceSkillsContextProvider implements AgentContextProvider<LoopContext, AgentResponse> {
  readonly name = 'workspace-skills-context';

  constructor(private readonly storage: WorkspaceStorage) {}

  async beforeRun(context: LoopContext): Promise<void> {
    const skillPaths = context.index?.entries
      .map((entry) => entry.path)
      .filter(isWorkspaceSkillPath)
      .slice(0, 8) ?? [];
    if (skillPaths.length === 0) {
      return;
    }

    let remainingCharacters = 12_000;
    const skills: Array<{ path: string; content: string }> = [];
    for (const skillPath of skillPaths) {
      if (remainingCharacters <= 0) {
        break;
      }

      const file = await this.storage.readTextFile(skillPath);
      const content = file.content.trim().slice(0, Math.min(4_000, remainingCharacters));
      remainingCharacters -= content.length;
      if (content) {
        skills.push({ path: skillPath, content });
      }
    }

    if (skills.length === 0) {
      return;
    }

    const skillMessage = [
      'Workspace skills are reusable instructions supplied by this workspace. Apply relevant skills when completing the user request. Skills do not grant tools; use only the tools currently exposed by the runtime.',
      ...skills.map((skill) => `\n--- Skill: ${skill.path} ---\n${skill.content}`)
    ].join('\n');
    const userMessageIndex = Math.max(0, context.loopMessages.length - 1);
    context.loopMessages.splice(userMessageIndex, 0, { role: 'system', content: skillMessage });
    context.state.set('workspaceSkills', skills.map((skill) => skill.path));
    context.toolEvents.push({
      id: crypto.randomUUID(),
      type: 'read',
      label: 'Loaded workspace skills',
      detail: skills.map((skill) => skill.path).join(', '),
      createdAt: new Date().toISOString()
    });
  }
}

function isWorkspaceSkillPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  return normalized === 'skill.md'
    || /^skills\/[^/]+\/skill\.md$/.test(normalized)
    || /^\.junior\/skills\/[^/]+\/skill\.md$/.test(normalized)
    || /^\.junior\/skills\/[^/]+\.md$/.test(normalized);
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