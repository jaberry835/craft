import type { ChatMessage, ChatMessageDisplayPart, ChatSession, ToolEvent } from '../types.js';
import type { WorkspaceStorage } from './workspaceStorage.js';

export const conversationHistoryFolder = 'conversation-history';
const readmePath = `${conversationHistoryFolder}/README.md`;

const readmeContent = `# Conversation History

This folder holds an archived, human-readable record of agent conversations in
this workspace. It is maintained automatically by Junior Workbench when the
per-workspace conversation history setting is enabled.

## What is captured

- Every user prompt and assistant reply in a chat session.
- The agent reasoning output for each assistant turn (when reasoning archiving is enabled).
- The workspace tool actions the agent took for each turn.

## How it is organized

- One markdown file per chat session, named with the session start time as
  \`YYYY-MM-DD_HHmmss-<short-id>.md\`.
- Each file is rewritten on every turn so it always reflects the full session.

## Notes

- These files are generated artifacts. Editing them by hand will be overwritten
  on the next archived turn.
- Disable the setting per workspace to stop new turns from being recorded. Existing
  files are left in place.
`;

/**
 * Writes an append-only, human-readable transcript of each chat session into a
 * dedicated workspace folder. The transcript optionally includes the agent
 * reasoning output captured on assistant turns.
 */
export class ConversationHistoryArchiver {
  constructor(private readonly storage: WorkspaceStorage) {}

  async archiveSession(session: ChatSession, options: { includeReasoning: boolean }): Promise<void> {
    await this.storage.writeTextFile(readmePath, readmeContent);
    await this.storage.writeTextFile(this.sessionPath(session), this.renderSession(session, options));
  }

  sessionPath(session: ChatSession): string {
    return `${conversationHistoryFolder}/${this.sessionFileName(session)}.md`;
  }

  sessionFileName(session: ChatSession): string {
    return `${this.shortDateTime(session.createdAt)}-${this.shortId(session.id)}`;
  }

  private shortDateTime(value: string): string {
    const date = new Date(value);
    const timestamp = Number.isNaN(date.getTime()) ? new Date() : date;
    const pad = (input: number) => String(input).padStart(2, '0');
    const year = timestamp.getFullYear();
    const month = pad(timestamp.getMonth() + 1);
    const day = pad(timestamp.getDate());
    const hours = pad(timestamp.getHours());
    const minutes = pad(timestamp.getMinutes());
    const seconds = pad(timestamp.getSeconds());
    return `${year}-${month}-${day}_${hours}${minutes}${seconds}`;
  }

  private shortId(sessionId: string): string {
    const cleaned = sessionId.replace(/[^a-zA-Z0-9]/g, '');
    return cleaned.slice(0, 6) || 'session';
  }

  private renderSession(session: ChatSession, options: { includeReasoning: boolean }): string {
    const lines: string[] = [];
    lines.push(`# Conversation history: ${session.title}`);
    lines.push('');
    lines.push(`- Session id: \`${session.id}\``);
    if (session.agentId) {
      lines.push(`- Agent: \`${session.agentId}\``);
    }
    lines.push(`- Created: ${session.createdAt}`);
    lines.push(`- Last updated: ${session.updatedAt}`);
    lines.push(`- Messages: ${session.messages.length}`);
    lines.push('');

    for (const message of session.messages) {
      lines.push('---');
      lines.push('');
      lines.push(...this.renderMessage(message, options));
      lines.push('');
    }

    return `${lines.join('\n').trimEnd()}\n`;
  }

  private renderMessage(message: ChatMessage, options: { includeReasoning: boolean }): string[] {
    const lines: string[] = [];
    lines.push(`## ${this.roleLabel(message.role)} — ${message.createdAt}`);
    lines.push('');
    lines.push(message.content.trim().length > 0 ? message.content.trim() : '_(no message content)_');

    if (message.display) {
      const reasoning = options.includeReasoning ? this.reasoningText(message.display) : undefined;
      if (reasoning) {
        lines.push('');
        lines.push('### Reasoning');
        lines.push('');
        lines.push(reasoning);
      }

      const events = this.toolEvents(message.display);
      if (events.length > 0) {
        lines.push('');
        lines.push('### Workspace actions');
        lines.push('');
        for (const event of events) {
          lines.push(`- ${this.renderToolEvent(event)}`);
        }
      }
    }

    return lines;
  }

  private renderToolEvent(event: ToolEvent): string {
    const target = event.filePath ? ` (\`${event.filePath}\`)` : '';
    const detail = event.detail ? ` — ${event.detail}` : '';
    return `**${event.type}**: ${event.label}${target}${detail}`;
  }

  private reasoningText(display: ChatMessageDisplayPart[]): string | undefined {
    const text = display
      .filter((part): part is Extract<ChatMessageDisplayPart, { kind: 'reasoning' }> => part.kind === 'reasoning')
      .map((part) => part.text.trim())
      .filter((value) => value.length > 0)
      .join('\n\n')
      .trim();

    return text.length > 0 ? text : undefined;
  }

  private toolEvents(display: ChatMessageDisplayPart[]): ToolEvent[] {
    return display
      .filter((part): part is Extract<ChatMessageDisplayPart, { kind: 'working' }> => part.kind === 'working')
      .flatMap((part) => part.events);
  }

  private roleLabel(role: ChatMessage['role']): string {
    switch (role) {
      case 'user':
        return 'User';
      case 'assistant':
        return 'Assistant';
      default:
        return 'Tool';
    }
  }
}
