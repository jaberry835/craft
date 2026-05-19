import { randomUUID } from 'node:crypto';
import type { GroundingSnippet, ToolEvent } from '../../types.js';
import type { AgentConfigStore } from '../agentConfigStore.js';
import type { ChangeManager } from '../changeManager.js';
import type { JuniorChatRuntime } from '../juniorChatRuntime.js';
import type { LoopToolEntry } from './types.js';

interface PackageToolDependencies {
  changeManager: ChangeManager;
  chatRuntime: JuniorChatRuntime;
}

export function createPackageTools(dependencies: PackageToolDependencies): LoopToolEntry[] {
  return [
    {
      definition: {
        name: 'identify-open-questions',
        description: 'Identify missing approval-package facts that require user input.',
        isReadOnly: true,
        allowRepeatedCalls: false,
        requiresConfirmation: false,
        confirmationCategory: 'workspace-read',
        category: 'package',
        parameters: { type: 'object', properties: {} }
      },
      execute: async (context) => {
        context.assistantContent = 'To complete the approval package, I need the business owner, target Azure subscription, data classification, internet exposure, and required approver group.';
        context.toolEvents.push(createToolEvent('ask', 'Identified open questions'));
        context.stop = true;
        return { success: true, result: context.assistantContent };
      }
    },
    {
      definition: {
        name: 'draft-package-updates',
        description: 'Draft updates to the package files based on grounded workspace context.',
        isReadOnly: false,
        allowRepeatedCalls: false,
        requiresConfirmation: true,
        confirmationCategory: 'file-edit',
        category: 'package',
        parameters: { type: 'object', properties: {} }
      },
      execute: async (context) => {
        const modelDraft = await generateDraft(
          dependencies.chatRuntime,
          context.content,
          context.activeAgent.instructions,
          context.grounding,
          context.connection
        );

        if (modelDraft.usedModel) {
          context.toolEvents.push(createToolEvent('read', 'Generated draft with Azure OpenAI', context.modelConnection.name));
        } else if (modelDraft.error) {
          context.toolEvents.push(createToolEvent('read', 'Azure OpenAI draft fell back', modelDraft.error));
        }

        const overview = context.packageFiles.find((file) => file.path.endsWith('system-overview.md'));
        if (overview) {
          context.staged.push(await dependencies.changeManager.stageFileChange(
            overview.path,
            withSection(overview.content, 'Junior Workbench Draft Notes', [
              `Requested update: ${context.content}`,
              `Agent: ${context.activeAgent.name}`,
              `Model connection: ${context.modelConnection.configured ? context.modelConnection.name : `not configured (${context.modelConnection.missing.join(', ')})`}`,
              ...contextLines(context.grounding),
              'Azure OpenAI draft:',
              modelDraft.content,
              'The package should capture Azure resources, identities, data flows, threat model status, monitoring, and approval owners.',
              'This draft was produced by the server-side Junior agent loop.'
            ]),
            'Add agent-drafted package notes to the system overview.'
          ));
          context.toolEvents.push(createToolEvent('edit', 'Prepared system overview update', overview.path, overview.path));
        }

        const checklist = context.packageFiles.find((file) => file.path.endsWith('approval-checklist.md'));
        if (checklist) {
          context.staged.push(await dependencies.changeManager.stageFileChange(
            checklist.path,
            withSection(checklist.content, 'Agent Follow-up Checklist', [
              '- [ ] Confirm package owner and approver group',
              '- [ ] Attach architecture evidence and data-flow notes',
              '- [ ] Confirm managed identity and RBAC plan',
              '- [ ] Confirm logging, alerting, and incident routing',
              '- [ ] Review the resulting workspace files with the domain owner'
            ]),
            'Add follow-up checklist for security approval readiness.'
          ));
          context.toolEvents.push(createToolEvent('edit', 'Prepared approval checklist update', checklist.path, checklist.path));
        }

        return {
          success: true,
          result: context.staged.length > 0
            ? `Prepared ${context.staged.length} staged package update${context.staged.length === 1 ? '' : 's'}.`
            : 'No package files were updated.'
        };
      }
    }
  ];
}

function withSection(content: string, heading: string, lines: string[]): string {
  const marker = `## ${heading}`;
  const section = `${marker}\n\n${lines.join('\n')}\n`;

  if (content.includes(marker)) {
    return content.replace(new RegExp(`${escapeRegExp(marker)}[\\s\\S]*?(?=\\n## |$)`), section.trimEnd());
  }

  return `${content.trimEnd()}\n\n${section}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function generateDraft(
  chatRuntime: JuniorChatRuntime,
  content: string,
  instructions: string,
  grounding: GroundingSnippet[],
  connection: ReturnType<AgentConfigStore['getConnection']>
): Promise<{ content: string; usedModel: boolean; error?: string }> {
  const groundingText = grounding.length > 0
    ? grounding.map((snippet) => `- ${snippet.title}: ${snippet.content}`).join('\n')
    : 'No grounding snippets were found. Use the package structure and ask for missing facts.';

  let modelContent: string | null;
  try {
    modelContent = await chatRuntime.complete({
      connection,
      messages: [
        { role: 'system', content: instructions },
        { role: 'user', content: `User request:\n${content}\n\nGrounding snippets:\n${groundingText}\n\nDraft concise approval-package notes. Do not claim changes were applied; they will be staged or auto-applied by the server loop.` }
      ]
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[agent-loop] Azure OpenAI draft failed: ${message}`);
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

function contextLines(grounding: GroundingSnippet[]): string[] {
  if (grounding.length === 0) {
    return ['Grounding context: no direct matches were found, so Junior used the package structure as context.'];
  }

  return [
    'Grounding context considered:',
    ...grounding.slice(0, 5).map((snippet) => `- ${snippet.sourceLabel} / ${snippet.title}: ${snippet.content}`)
  ];
}

function createToolEvent(type: ToolEvent['type'], label: string, detail?: string, filePath?: string): ToolEvent {
  return {
    id: randomUUID(),
    type,
    label,
    detail,
    filePath,
    createdAt: new Date().toISOString()
  };
}