import { randomUUID } from 'node:crypto';
import { NotFoundError } from './httpErrors.js';
import type {
  ModelChatClient,
  ModelChatMessage,
  ModelToolCall,
  ModelToolDefinition,
  ResolvedModelConnection
} from './modelTypes.js';
import { ProjectFileService } from './projectFileService.js';
import type { FileTreeNode, ToolEvent } from '../src/types/api.js';

const maximumRounds = 6;
const maximumToolCalls = 20;
const noReasoningMessage = 'No reasoning was emitted for this turn.';

const tools: ModelToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List the files and directories in the current A&A project.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a UTF-8 text file using a project-relative path.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or fully replace a UTF-8 text file using a project-relative path.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Replace one exact text occurrence in an existing project file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          oldString: { type: 'string' },
          newString: { type: 'string' }
        },
        required: ['path', 'oldString', 'newString']
      }
    }
  }
];

export interface AaaAgentProgressHandlers {
  onReasoning?: (text: string) => void | Promise<void>;
  onAssistantText?: (text: string) => void | Promise<void>;
  onToolEvent?: (event: ToolEvent) => void | Promise<void>;
}

export interface AaaAgentRunResult {
  content: string;
  reasoning: string;
  toolEvents: ToolEvent[];
  changedFiles: string[];
}

export class AaaAgentLoop {
  constructor(
    private readonly modelClient: ModelChatClient,
    private readonly fileService: ProjectFileService
  ) {}

  async run(
    connection: ResolvedModelConnection,
    messages: ModelChatMessage[],
    signal: AbortSignal,
    handlers: AaaAgentProgressHandlers = {}
  ): Promise<AaaAgentRunResult> {
    const loopMessages = [...messages];
    const toolEvents: ToolEvent[] = [];
    const changedFiles = new Set<string>();
    let reasoning = '';
    let content = '';
    let toolCallCount = 0;

    for (let round = 0; round < maximumRounds; round += 1) {
      let roundContent = '';
      let roundToolCalls: ModelToolCall[] = [];
      let completed = false;

      for await (const chunk of this.modelClient.stream(connection, loopMessages, signal, tools)) {
        if (signal.aborted) {
          throw signal.reason;
        }
        if (chunk.type === 'assistant_text') {
          roundContent += chunk.text;
          content += chunk.text;
          await handlers.onAssistantText?.(chunk.text);
        } else if (chunk.type === 'reasoning') {
          reasoning += chunk.text;
          await handlers.onReasoning?.(chunk.text);
        } else if (chunk.type === 'tool_calls') {
          roundToolCalls = chunk.calls;
        } else {
          completed = true;
        }
      }

      if (!completed) {
        throw new Error('The model response ended before completing the agent round.');
      }
      if (roundToolCalls.length === 0) {
        const finalContent = content.trim();
        if (!finalContent) {
          throw new Error('The agent completed without an assistant response.');
        }
        return {
          content: finalContent,
          reasoning: reasoning.trim() || noReasoningMessage,
          toolEvents,
          changedFiles: [...changedFiles]
        };
      }

      toolCallCount += roundToolCalls.length;
      if (toolCallCount > maximumToolCalls) {
        throw new Error(`The agent exceeded the ${maximumToolCalls}-tool-call safety limit.`);
      }

      loopMessages.push({
        role: 'assistant',
        content: roundContent,
        toolCalls: roundToolCalls
      });
      for (const toolCall of roundToolCalls) {
        const result = await this.executeTool(toolCall, changedFiles);
        toolEvents.push(result.event);
        await handlers.onToolEvent?.(result.event);
        loopMessages.push({
          role: 'tool',
          content: result.output,
          toolCallId: toolCall.id
        });
      }
    }

    throw new Error(`The agent exceeded the ${maximumRounds}-round safety limit.`);
  }

  private async executeTool(
    toolCall: ModelToolCall,
    changedFiles: Set<string>
  ): Promise<{ output: string; event: ToolEvent }> {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(toolCall.function.arguments || '{}') as Record<string, unknown>;
    } catch {
      return this.failedToolEvent(toolCall.function.name, 'Tool arguments were not valid JSON.');
    }

    try {
      switch (toolCall.function.name) {
        case 'list_files': {
          const paths = flattenTree(await this.fileService.listTree()).slice(0, 500);
          return {
            output: paths.join('\n') || 'The project contains no visible files.',
            event: createToolEvent('read', 'Listed project files', `${paths.length} paths returned.`)
          };
        }
        case 'read_file': {
          const path = requiredString(args, 'path');
          const file = await this.fileService.readTextFile(path);
          return {
            output: file.content,
            event: createToolEvent('read', 'Read project file', path, path)
          };
        }
        case 'write_file': {
          const path = requiredString(args, 'path');
          const nextContent = stringValue(args, 'content');
          let operation: 'create' | 'edit' = 'edit';
          try {
            const current = await this.fileService.readTextFile(path);
            await this.fileService.writeTextFile(path, nextContent, current.updatedAt);
          } catch (error) {
            if (!(error instanceof NotFoundError)) {
              throw error;
            }
            operation = 'create';
            await this.fileService.createTextFile(path, nextContent);
          }
          changedFiles.add(path);
          return {
            output: `${operation === 'create' ? 'Created' : 'Updated'} ${path}.`,
            event: createToolEvent(
              operation,
              operation === 'create' ? 'Created project file' : 'Updated project file',
              path,
              path
            )
          };
        }
        case 'edit_file': {
          const path = requiredString(args, 'path');
          const oldString = requiredString(args, 'oldString');
          const newString = stringValue(args, 'newString');
          const current = await this.fileService.readTextFile(path);
          const matchCount = current.content.split(oldString).length - 1;
          if (matchCount !== 1) {
            throw new Error(`Expected one exact match in ${path}, found ${matchCount}.`);
          }
          await this.fileService.writeTextFile(
            path,
            current.content.replace(oldString, newString),
            current.updatedAt
          );
          changedFiles.add(path);
          return {
            output: `Edited ${path}.`,
            event: createToolEvent('edit', 'Edited project file', path, path)
          };
        }
        default:
          return this.failedToolEvent(toolCall.function.name, 'The requested tool is not available.');
      }
    } catch (error) {
      return this.failedToolEvent(
        toolCall.function.name,
        error instanceof Error ? error.message : 'Tool execution failed.'
      );
    }
  }

  private failedToolEvent(toolName: string, message: string): { output: string; event: ToolEvent } {
    return {
      output: `Tool ${toolName} failed: ${message}`,
      event: createToolEvent('read', `Tool failed: ${toolName}`, message)
    };
  }
}

function flattenTree(nodes: FileTreeNode[]): string[] {
  return nodes.flatMap((node) => [
    `${node.type === 'directory' ? 'dir' : 'file'} ${node.path}`,
    ...(node.children ? flattenTree(node.children) : [])
  ]);
}

function requiredString(args: Record<string, unknown>, name: string): string {
  const value = stringValue(args, name).trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function stringValue(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string') {
    throw new Error(`${name} must be a string.`);
  }
  return value;
}

function createToolEvent(
  type: ToolEvent['type'],
  label: string,
  detail?: string,
  filePath?: string
): ToolEvent {
  return {
    id: randomUUID(),
    type,
    label,
    detail,
    filePath,
    createdAt: new Date().toISOString()
  };
}
