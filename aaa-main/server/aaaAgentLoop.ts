import { randomUUID } from 'node:crypto';
import { AgentRunError, NotFoundError } from './httpErrors.js';
import type {
  ModelChatClient,
  ModelChatMessage,
  ModelToolCall,
  ModelToolDefinition,
  ResolvedModelConnection
} from './modelTypes.js';
import { ProjectFileService } from './projectFileService.js';
import { builtInToolNames, type BuiltInToolName, type WorkflowSkill } from './projectWorkflowService.js';
import type { BrowserCaptureService } from './services/browserCaptureService.js';
import type { McpToolbox } from './services/mcpHttpClient.js';
import type { FileTreeNode, ToolEvent } from '../src/types/api.js';

const noReasoningMessage = 'No reasoning was emitted for this turn.';
const maximumToolOutputCharacters = 60_000;
const fileReferencePrefix = 'aaa-file:';

const builtInDefinitions: Record<BuiltInToolName, ModelToolDefinition> = {
  list_files: {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files and directories in the project. Hidden folders such as .github are omitted unless a path inside them is given.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Optional project-relative directory to list.' }
        }
      }
    }
  },
  read_file: {
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
  search_files: {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Case-insensitive text search across project text files. Returns path:line: text matches.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          path: { type: 'string', description: 'Optional project-relative file or directory to limit the search.' }
        },
        required: ['query']
      }
    }
  },
  write_file: {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or fully replace a UTF-8 text file using a project-relative path; missing parent folders are created. '
        + 'content must be the complete raw file text with real line breaks, not escaped \\n sequences.',
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
  edit_file: {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Replace one exact text occurrence in an existing project file. Use real line breaks in oldString and newString.',
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
  },
  copy_path: {
    type: 'function',
    function: {
      name: 'copy_path',
      description: 'Copy a project file or directory (for example a skill template) to a new project path. '
        + 'Existing destination files are never overwritten; the result lists created and preserved files.',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string' },
          destination: { type: 'string' }
        },
        required: ['source', 'destination']
      }
    }
  },
  browser_capture: {
    type: 'function',
    function: {
      name: 'browser_capture',
      description: 'Control the project Microsoft Edge evidence-capture session. Launch visible Edge by default for interactive authentication, navigate to an absolute HTTP(S) URL, capture a PNG with JSON provenance, inspect status, or close the session.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['launch', 'status', 'navigate', 'capture', 'close'] },
          url: { type: 'string', description: 'Absolute HTTP(S) URL for launch or navigate.' },
          headless: { type: 'boolean', description: 'Launch headless when true; defaults to visible Edge.' },
          outputPath: { type: 'string', description: 'Optional project-relative PNG path.' },
          fullPage: { type: 'boolean', description: 'Capture the full page; defaults to true.' }
        },
        required: ['action']
      }
    }
  },
  load_skill: {
    type: 'function',
    function: {
      name: 'load_skill',
      description: 'Load the full procedure (SKILL.md) and bundled file list of a project skill by id.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Skill id from the skill catalog.' } },
        required: ['name']
      }
    }
  }
};

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

export interface AaaAgentLoopOptions {
  /** Built-in tools to expose; defaults to every built-in tool except load_skill when no skills exist. */
  tools?: Iterable<BuiltInToolName>;
  skills?: WorkflowSkill[];
  mcp?: McpToolbox;
  mcpFilter?: (server: string, tool: string) => boolean;
  browserCapture?: BrowserCaptureService;
  projectId?: string;
  maxRounds?: number;
  maxToolCalls?: number;
  timeoutMs?: number;
}

export class AaaAgentLoop {
  private readonly builtIns: Set<BuiltInToolName>;
  private readonly skills: WorkflowSkill[];
  private readonly maxRounds: number;
  private readonly maxToolCalls: number;
  private readonly timeoutMs: number;

  constructor(
    private readonly modelClient: ModelChatClient,
    private readonly fileService: ProjectFileService,
    private readonly options: AaaAgentLoopOptions = {}
  ) {
    this.skills = options.skills ?? [];
    this.builtIns = new Set(options.tools ?? builtInToolNames);
    if (this.skills.length === 0) this.builtIns.delete('load_skill');
    this.maxRounds = options.maxRounds ?? envNumber('AAA_AGENT_MAX_ROUNDS', 30);
    this.maxToolCalls = options.maxToolCalls ?? envNumber('AAA_AGENT_MAX_TOOL_CALLS', 120);
    this.timeoutMs = options.timeoutMs ?? envNumber('AAA_AGENT_TIMEOUT_MS', 15 * 60_000);
  }

  async run(
    connection: ResolvedModelConnection,
    messages: ModelChatMessage[],
    userSignal: AbortSignal,
    handlers: AaaAgentProgressHandlers = {}
  ): Promise<AaaAgentRunResult> {
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal = AbortSignal.any([userSignal, timeoutSignal]);
    const throwIfStopped = () => {
      if (userSignal.aborted) throw userSignal.reason;
      if (timeoutSignal.aborted) {
        throw new AgentRunError(`The agent run exceeded its ${Math.round(this.timeoutMs / 60_000)}-minute time limit.`);
      }
    };

    const loopMessages = [...messages];
    const toolEvents: ToolEvent[] = [];
    const changedFiles = new Set<string>();
    let reasoning = '';
    let content = '';
    let toolCallCount = 0;

    const emit = async (event: ToolEvent) => {
      toolEvents.push(event);
      await handlers.onToolEvent?.(event);
    };

    const tools = [...this.builtIns].map((name) => builtInDefinitions[name]);
    if (this.options.mcp) {
      const loaded = await this.options.mcp.load(signal, this.options.mcpFilter).catch((error: unknown) => {
        throwIfStopped();
        throw error;
      });
      tools.push(...loaded.definitions);
      for (const error of loaded.errors) {
        await emit(createToolEvent('mcp', 'MCP server unavailable', error));
      }
    }

    try {
      for (let round = 0; round < this.maxRounds; round += 1) {
        let roundContent = '';
        let roundToolCalls: ModelToolCall[] = [];
        let completed = false;

        for await (const chunk of this.modelClient.stream(connection, loopMessages, signal, tools)) {
          throwIfStopped();
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
        throwIfStopped();

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
        if (toolCallCount > this.maxToolCalls) {
          throw new AgentRunError(
            `The agent exceeded the ${this.maxToolCalls}-tool-call safety limit. Ask for a smaller step and continue.`
          );
        }

        loopMessages.push({
          role: 'assistant',
          content: roundContent,
          toolCalls: roundToolCalls
        });
        if (roundContent && !/\s$/.test(content)) {
          content += '\n\n';
          await handlers.onAssistantText?.('\n\n');
        }
        for (const toolCall of roundToolCalls) {
          throwIfStopped();
          const result = await this.executeTool(toolCall, changedFiles, signal);
          await emit(result.event);
          loopMessages.push({
            role: 'tool',
            content: truncate(result.output),
            toolCallId: toolCall.id
          });
        }
      }
    } catch (error) {
      if (!userSignal.aborted && timeoutSignal.aborted) throwIfStopped();
      throw error;
    }

    throw new AgentRunError(
      `The agent exceeded the ${this.maxRounds}-round safety limit. Ask it to continue from where it stopped.`
    );
  }

  private async executeTool(
    toolCall: ModelToolCall,
    changedFiles: Set<string>,
    signal: AbortSignal
  ): Promise<{ output: string; event: ToolEvent }> {
    const toolName = toolCall.function.name;
    let args: Record<string, unknown>;
    try {
      args = parseToolArguments(toolCall.function.arguments);
    } catch {
      return this.failedToolEvent(toolName, 'Tool arguments were not valid JSON.');
    }

    try {
      if (this.options.mcp?.has(toolName)) {
        return await this.executeMcpTool(toolName, args, signal);
      }
      if (!this.builtIns.has(toolName as BuiltInToolName)) {
        return this.failedToolEvent(toolName, 'The requested tool is not available.');
      }
      switch (toolName as BuiltInToolName) {
        case 'list_files': {
          const directory = optionalString(args, 'path');
          const paths = flattenTree(await this.fileService.listTree({
            path: directory,
            includeHidden: Boolean(directory)
          })).slice(0, 1000);
          return {
            output: paths.join('\n') || 'No visible files were found.',
            event: createToolEvent('read', 'Listed project files', `${directory ? `${directory}: ` : ''}${paths.length} paths returned.`)
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
        case 'search_files': {
          const query = requiredString(args, 'query');
          const directory = optionalString(args, 'path');
          const matches = await this.fileService.searchFiles(query, { path: directory, maxResults: 200 });
          return {
            output: matches.map((match) => `${match.path}:${match.line}: ${match.text}`).join('\n')
              || `No matches for "${query}".`,
            event: createToolEvent('search', 'Searched project files', `"${query}" · ${matches.length} matches`)
          };
        }
        case 'write_file': {
          const path = requiredString(args, 'path');
          const nextContent = repairEscapedNewlines(path, stringValue(args, 'content'));
          let operation: 'create' | 'edit' = 'edit';
          try {
            const current = await this.fileService.readTextFile(path);
            await this.fileService.writeTextFile(path, nextContent, current.updatedAt);
          } catch (error) {
            if (!(error instanceof NotFoundError)) {
              throw error;
            }
            operation = 'create';
            await this.fileService.createTextFile(path, nextContent, { createParents: true });
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
          const current = await this.fileService.readTextFile(path);
          let oldString = requiredString(args, 'oldString');
          let newString = stringValue(args, 'newString');
          if (!current.content.includes(oldString)) {
            const repaired = repairEscapedNewlines(path, oldString, true);
            if (current.content.includes(repaired)) {
              oldString = repaired;
              newString = repairEscapedNewlines(path, newString, true);
            }
          } else {
            newString = repairEscapedNewlines(path, newString);
          }
          const matchCount = current.content.split(oldString).length - 1;
          if (matchCount !== 1) {
            throw new Error(`Expected one exact match in ${path}, found ${matchCount}.`);
          }
          await this.fileService.writeTextFile(
            path,
            current.content.replace(oldString, () => newString),
            current.updatedAt
          );
          changedFiles.add(path);
          return {
            output: `Edited ${path}.`,
            event: createToolEvent('edit', 'Edited project file', path, path)
          };
        }
        case 'copy_path': {
          const source = requiredString(args, 'source');
          const destination = requiredString(args, 'destination');
          const result = await this.fileService.copyPath(source, destination);
          result.created.forEach((file) => changedFiles.add(file));
          return {
            output: [
              `Copied ${source} to ${destination}.`,
              `Created (${result.created.length}):`,
              ...result.created.map((file) => `- ${file}`),
              `Preserved existing (${result.preserved.length}):`,
              ...result.preserved.map((file) => `- ${file}`)
            ].join('\n'),
            event: createToolEvent(
              'create',
              'Copied project files',
              `${source} → ${destination} · ${result.created.length} created, ${result.preserved.length} preserved`,
              destination
            )
          };
        }
        case 'browser_capture': {
          const browserCapture = this.options.browserCapture;
          const projectId = this.options.projectId;
          if (!browserCapture || !projectId) throw new Error('Browser capture is not configured for this run.');
          const action = requiredString(args, 'action');
          if (action === 'launch') {
            const status = await browserCapture.launch(projectId, {
              headless: optionalBoolean(args, 'headless'),
              url: optionalString(args, 'url')
            });
            return {
              output: JSON.stringify(status),
              event: createToolEvent('browser', 'Launched Edge capture session', status.headless ? 'Headless' : 'Visible')
            };
          }
          if (action === 'status') {
            const status = browserCapture.status(projectId);
            return {
              output: JSON.stringify(status),
              event: createToolEvent('browser', 'Checked Edge capture session', status.active ? status.currentUrl : 'Not running')
            };
          }
          if (action === 'navigate') {
            const status = await browserCapture.navigate(projectId, { url: requiredString(args, 'url') });
            return {
              output: JSON.stringify(status),
              event: createToolEvent('browser', 'Navigated Edge capture session', status.currentUrl)
            };
          }
          if (action === 'capture') {
            const result = await browserCapture.capture(projectId, this.fileService, {
              outputPath: optionalString(args, 'outputPath'),
              fullPage: optionalBoolean(args, 'fullPage')
            });
            changedFiles.add(result.path);
            changedFiles.add(result.metadataPath);
            return {
              output: JSON.stringify(result),
              event: createToolEvent('browser', 'Captured browser evidence', `${result.sourceUrl} → ${result.path}`, result.path)
            };
          }
          if (action === 'close') {
            const status = await browserCapture.close(projectId);
            return {
              output: JSON.stringify(status),
              event: createToolEvent('browser', 'Closed Edge capture session')
            };
          }
          throw new Error(`Unknown browser_capture action "${action}".`);
        }
        case 'load_skill': {
          const name = requiredString(args, 'name').replace(/^\//, '');
          const skill = this.skills.find((candidate) =>
            candidate.id.toLowerCase() === name.toLowerCase() || candidate.name.toLowerCase() === name.toLowerCase());
          if (!skill) {
            throw new Error(`Unknown skill "${name}". Available skills: ${this.skills.map((item) => item.id).join(', ')}`);
          }
          const file = await this.fileService.readTextFile(skill.sourcePath);
          const bundled = flattenTree(await this.fileService.listTree({ path: skill.directory, includeHidden: true }))
            .filter((entry) => entry.startsWith('file ') && !entry.endsWith('/SKILL.md'))
            .map((entry) => entry.slice(5));
          return {
            output: [
              `# Skill ${skill.id} (${skill.sourcePath})`,
              `Skill directory: ${skill.directory}`,
              '',
              file.content,
              ...(bundled.length ? ['', '## Bundled files', ...bundled.map((entry) => `- ${entry}`)] : [])
            ].join('\n'),
            event: createToolEvent('skill', 'Loaded skill', skill.name, skill.sourcePath)
          };
        }
      }
    } catch (error) {
      if (signal.aborted) throw error;
      return this.failedToolEvent(
        toolName,
        error instanceof Error ? error.message : 'Tool execution failed.'
      );
    }
  }

  private async executeMcpTool(
    toolName: string,
    args: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<{ output: string; event: ToolEvent }> {
    const route = this.options.mcp!.describe(toolName)!;
    const referencedFiles: string[] = [];
    const resolvedArgs = await this.resolveFileReferences(args, referencedFiles) as Record<string, unknown>;
    const result = await this.options.mcp!.call(toolName, resolvedArgs, signal);
    const detail = [
      `${route.server} · ${route.tool}`,
      ...(referencedFiles.length ? [`${referencedFiles.length} project file${referencedFiles.length === 1 ? '' : 's'} sent`] : []),
      ...(result.isError ? ['returned an error'] : [])
    ].join(' · ');
    return {
      output: result.isError ? `MCP tool ${route.tool} returned an error:\n${result.text}` : result.text || 'OK',
      event: createToolEvent('mcp', result.isError ? `MCP tool failed: ${route.tool}` : 'Called MCP tool', detail)
    };
  }

  private async resolveFileReferences(value: unknown, referencedFiles: string[]): Promise<unknown> {
    if (typeof value === 'string' && value.startsWith(fileReferencePrefix)) {
      const filePath = value.slice(fileReferencePrefix.length).trim();
      referencedFiles.push(filePath);
      return (await this.fileService.readTextFile(filePath)).content;
    }
    if (Array.isArray(value)) {
      return Promise.all(value.map((item) => this.resolveFileReferences(item, referencedFiles)));
    }
    if (value && typeof value === 'object') {
      const entries = await Promise.all(Object.entries(value).map(async ([key, item]) =>
        [key, await this.resolveFileReferences(item, referencedFiles)] as const));
      return Object.fromEntries(entries);
    }
    return value;
  }

  private failedToolEvent(toolName: string, message: string): { output: string; event: ToolEvent } {
    return {
      output: `Tool ${toolName} failed: ${message}`,
      event: createToolEvent('read', `Tool failed: ${toolName}`, message)
    };
  }
}

const repairableExtensions = /\.(md|markdown|txt|csv|ya?ml)$/i;

/**
 * Some models double-escape tool-call JSON so a file arrives as one line containing
 * literal "\n" sequences. For prose/text formats, decode those escapes when the text
 * has no real line breaks. JSON and source files are left untouched because a
 * single-line value can legitimately contain "\n" there.
 */
export function repairEscapedNewlines(filePath: string, value: string, force = false): string {
  if (!force && !repairableExtensions.test(filePath)) return value;
  if (/[\r\n]/.test(value) || (value.match(/\\n/g)?.length ?? 0) < (force ? 1 : 2)) return value;
  try {
    const decoded = JSON.parse(`"${value}"`) as unknown;
    if (typeof decoded === 'string') return decoded;
  } catch {
    // Fall back to decoding only whitespace escapes when the text is not a valid JSON string body.
  }
  return value.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
}

function parseToolArguments(raw: string): Record<string, unknown> {
  let parsed = JSON.parse(raw || '{}') as unknown;
  if (typeof parsed === 'string') parsed = JSON.parse(parsed) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Tool arguments must be a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

function flattenTree(nodes: FileTreeNode[]): string[] {
  return nodes.flatMap((node) => [
    `${node.type === 'directory' ? 'dir' : 'file'} ${node.path}`,
    ...(node.children ? flattenTree(node.children) : [])
  ]);
}

function truncate(value: string): string {
  return value.length > maximumToolOutputCharacters
    ? `${value.slice(0, maximumToolOutputCharacters)}\n\n[Output truncated at ${maximumToolOutputCharacters} characters.]`
    : value;
}

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function requiredString(args: Record<string, unknown>, name: string): string {
  const value = stringValue(args, name).trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalBoolean(args: Record<string, unknown>, name: string): boolean | undefined {
  const value = args[name];
  return typeof value === 'boolean' ? value : undefined;
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
