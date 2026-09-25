import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { AgentRunError, NotFoundError } from './httpErrors.js';
import { log } from './logger.js';
import type {
  ModelChatClient,
  ModelChatMessage,
  ModelToolCall,
  ModelToolDefinition,
  ModelUsage,
  ResolvedModelConnection
} from './modelTypes.js';
import { ProjectFileService } from './projectFileService.js';
import { builtInToolNames, type BuiltInToolName, type WorkflowSkill } from './projectWorkflowService.js';
import type { BrowserCaptureService } from './services/browserCaptureService.js';
import { httpDownload, type McpToolbox } from './services/mcpHttpClient.js';
import type { FileTreeNode, RunUsage, ToolEvent } from '../src/types/api.js';
import {
  addRequestUsage,
  emptyRunUsage,
  estimateMessageTokens,
  estimateTextTokens,
  estimateToolTokens,
  estimatedUsage
} from './tokenUsage.js';

const noReasoningMessage = 'No reasoning was emitted for this turn.';
const maximumToolOutputCharacters = 60_000;
const fileReferencePrefix = 'aaa-file:';
const trimmedToolOutputPrefix = '[AAA removed this earlier tool output';

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
  delete_path: {
    type: 'function',
    function: {
      name: 'delete_path',
      description: 'Delete a project file or folder. Deleting a non-empty folder requires recursive: true. '
        + 'The project root and the .aaa, .git, .github, and .vscode folders cannot be deleted. This cannot be undone, '
        + 'so only delete when the user asked for it or it is clearly part of the requested change.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Project-relative file or folder path.' },
          recursive: { type: 'boolean', description: 'Required to delete a folder that is not empty.' }
        },
        required: ['path']
      }
    }
  },
  browser_capture: {
    type: 'function',
    function: {
      name: 'browser_capture',
      description: 'Control the project Microsoft Edge evidence-capture session. Launch visible Edge by default for interactive authentication, navigate to an absolute HTTP(S) URL, capture the top of the page up to two viewport heights as a PNG with JSON provenance, inspect status, or close the session.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['launch', 'status', 'navigate', 'capture', 'close'] },
          url: { type: 'string', description: 'Absolute HTTP(S) URL for launch or navigate.' },
          headless: { type: 'boolean', description: 'Launch headless when true; defaults to visible Edge.' },
          outputPath: { type: 'string', description: 'Optional project-relative PNG path.' }
        },
        required: ['action']
      }
    }
  },
  download_file: {
    type: 'function',
    function: {
      name: 'download_file',
      description: 'Download a file or JSON into the project. url is either an http(s) URL on an enabled MCP server\'s host '
        + '(the server\'s authentication is applied) or an MCP resource URI such as one from a resource_link, which is read '
        + 'through the MCP server. JSON is pretty-printed and text results include a preview. Existing files are never '
        + 'overwritten; a numbered name is used instead.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Absolute http(s) URL or MCP resource URI.' },
          path: { type: 'string', description: 'Optional project-relative destination file, or a folder ending in /. Defaults to downloads/<source>/<name>.' },
          server: { type: 'string', description: 'MCP server name; required for resource URIs when more than one server is connected.' }
        },
        required: ['url']
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
  /** Called after every model request with the cumulative run usage. */
  onUsage?: (usage: RunUsage) => void | Promise<void>;
}

export interface AaaAgentRunResult {
  content: string;
  reasoning: string;
  toolEvents: ToolEvent[];
  changedFiles: string[];
  usage: RunUsage;
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
  /** Warnings shown as agent steps at the start of the run, e.g. unusable MCP servers. */
  notices?: Array<{ type: ToolEvent['type']; label: string; detail?: string }>;
  /** Hosts download_file may fetch from without an MCP server (defaults to AAA_DOWNLOAD_ALLOWED_HOSTS). */
  downloadAllowedHosts?: string[];
  /** Fetch used for allow-listed, non-MCP downloads; injectable for tests. */
  httpFetch?: typeof globalThis.fetch;
  /**
   * Called once before the first request when the estimated prompt (messages plus tool
   * definitions) exceeds `contextWindow * threshold`. May return replacement messages,
   * for example after compacting the conversation, and the usage that work consumed.
   */
  onContextPressure?: (estimatedTokens: number, budgetTokens: number) =>
    Promise<{ messages: ModelChatMessage[]; usage?: ModelUsage } | undefined>;
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
    const usage = emptyRunUsage();
    let reasoning = '';
    let content = '';
    let toolCallCount = 0;
    // Actual input tokens of the previous request and how many messages it covered,
    // used to estimate the next request's context size.
    let measuredInput: { tokens: number; messageCount: number } | undefined;

    const emit = async (event: ToolEvent) => {
      toolEvents.push(event);
      await handlers.onToolEvent?.(event);
    };

    const tools = [...this.builtIns].map((name) => builtInDefinitions[name]);
    for (const notice of this.options.notices ?? []) {
      await emit(createToolEvent(notice.type, notice.label, notice.detail));
    }
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
      const window = connection.definition.contextWindow;
      if (window && this.options.onContextPressure) {
        const budget = window * (connection.definition.compaction?.threshold ?? 0.8);
        const estimate = estimateMessageTokens(loopMessages) + estimateToolTokens(tools);
        if (estimate > budget) {
          const relieved = await this.options.onContextPressure(estimate, budget);
          throwIfStopped();
          if (relieved) {
            loopMessages.splice(0, loopMessages.length, ...relieved.messages);
            if (relieved.usage) {
              addRequestUsage(usage, relieved.usage, { auxiliary: true });
              await handlers.onUsage?.({ ...usage });
            }
          }
        }
      }

      for (let round = 0; round < this.maxRounds; round += 1) {
        let roundContent = '';
        let roundToolCalls: ModelToolCall[] = [];
        let roundUsage: ModelUsage | undefined;
        let completed = false;

        const trimmed = this.trimContext(connection, loopMessages, tools, measuredInput);
        if (trimmed) {
          await emit(trimmed.event);
          if (measuredInput) measuredInput.tokens = Math.max(0, measuredInput.tokens - trimmed.removedTokens);
        }

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
          } else if (chunk.type === 'usage') {
            roundUsage = chunk.usage;
          } else {
            completed = true;
          }
        }
        throwIfStopped();

        if (!completed) {
          throw new Error('The model response ended before completing the agent round.');
        }
        const requestUsage = roundUsage ?? estimatedUsage(
          estimateMessageTokens(loopMessages) + estimateToolTokens(tools),
          estimateTextTokens(roundContent) + estimateMessageTokens([{ role: 'assistant', content: '', toolCalls: roundToolCalls }])
        );
        addRequestUsage(usage, requestUsage, { estimated: !roundUsage });
        measuredInput = { tokens: requestUsage.inputTokens, messageCount: loopMessages.length };
        await handlers.onUsage?.({ ...usage });

        if (roundToolCalls.length === 0) {
          const finalContent = content.trim();
          if (!finalContent) {
            throw new Error('The agent completed without an assistant response.');
          }
          return {
            content: finalContent,
            reasoning: reasoning.trim() || noReasoningMessage,
            toolEvents,
            changedFiles: [...changedFiles],
            usage
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

  /**
   * Keeps a long run inside the configured context window. When the next request is
   * estimated to exceed `contextWindow * threshold`, the oldest tool outputs the model
   * has already seen are replaced with a short placeholder until the estimate falls to
   * 70% of that budget (hysteresis keeps the prompt prefix stable for caching).
   */
  private trimContext(
    connection: ResolvedModelConnection,
    loopMessages: ModelChatMessage[],
    tools: ModelToolDefinition[],
    measured: { tokens: number; messageCount: number } | undefined
  ): { event: ToolEvent; removedTokens: number } | undefined {
    const window = connection.definition.contextWindow;
    if (!window) return undefined;
    const budget = window * (connection.definition.compaction?.threshold ?? 0.8);
    let estimate = measured
      ? measured.tokens + estimateMessageTokens(loopMessages.slice(measured.messageCount))
      : estimateMessageTokens(loopMessages) + estimateToolTokens(tools);
    if (estimate <= budget) return undefined;

    // Results after the last assistant turn have not been seen by the model yet.
    let lastAssistant = -1;
    loopMessages.forEach((message, index) => {
      if (message.role === 'assistant') lastAssistant = index;
    });
    const target = budget * 0.7;
    let removedResults = 0;
    let removedTokens = 0;
    for (let index = 0; index < lastAssistant && estimate > target; index += 1) {
      const message = loopMessages[index]!;
      if (message.role !== 'tool' || message.content.startsWith(trimmedToolOutputPrefix)) continue;
      const placeholder = `${trimmedToolOutputPrefix} (${message.content.length} characters) to stay within the `
        + 'model context window. Call the tool again if you still need it.]';
      const saved = estimateTextTokens(message.content) - estimateTextTokens(placeholder);
      if (saved <= 0) continue;
      loopMessages[index] = { ...message, content: placeholder };
      estimate -= saved;
      removedResults += 1;
      removedTokens += saved;
    }
    if (removedResults === 0) return undefined;
    return {
      removedTokens,
      event: createToolEvent(
        'context',
        'Trimmed earlier tool output',
        `Removed ${removedResults} earlier tool result${removedResults === 1 ? '' : 's'} (~${removedTokens.toLocaleString('en-US')} tokens) `
          + `to stay within the ${window.toLocaleString('en-US')}-token context window.`
      )
    };
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
        return await this.executeMcpTool(toolName, args, changedFiles, signal);
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
          const path = assertAgentWritable(requiredString(args, 'path'));
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
          const path = assertAgentWritable(requiredString(args, 'path'));
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
          const destination = assertAgentWritable(requiredString(args, 'destination'));
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
              outputPath: optionalString(args, 'outputPath')
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
        case 'download_file':
          return await this.downloadFile(args, changedFiles, signal);
        case 'delete_path': {
          const target = path.posix.normalize(requiredString(args, 'path').replace(/\\/g, '/')).replace(/^\.\/+/, '').replace(/\/+$/, '');
          const topLevel = target.split('/')[0]!.toLowerCase();
          if (!target || target === '.' || target.startsWith('..') || protectedTopLevel.has(topLevel)) {
            throw new Error(`${target || 'The project root'} is protected and cannot be deleted by the agent. Ask the user to delete it from the Files panel if needed.`);
          }
          const parent = target.includes('/') ? target.slice(0, target.lastIndexOf('/')) : '';
          const listing = await this.fileService.listTree({ ...(parent ? { path: parent } : {}), includeHidden: true });
          const node = findNode(listing, target);
          if (!node) throw new NotFoundError(`Project path was not found: ${target}`);
          const contained = node.type === 'directory' ? flattenTree(node.children ?? []).filter((entry) => entry.startsWith('file ')).length : 0;
          if (node.type === 'directory' && (node.children?.length ?? 0) > 0 && optionalBoolean(args, 'recursive') !== true) {
            throw new Error(`${target} is a folder with ${contained} file${contained === 1 ? '' : 's'}; pass recursive: true to delete it and its contents.`);
          }
          await this.fileService.deletePath(target);
          changedFiles.add(target);
          const summary = node.type === 'directory'
            ? `Deleted folder ${target} (${contained} file${contained === 1 ? '' : 's'}).`
            : `Deleted ${target}.`;
          return { output: summary, event: createToolEvent('edit', 'Deleted project path', summary, target) };
        }
      }
    } catch (error) {
      if (signal.aborted) throw error;
      const message = error instanceof Error ? error.message : 'Tool execution failed.';
      if (this.options.mcp?.has(toolName)) {
        log.error('mcp', 'MCP tool call failed.', { tool: toolName, error: message });
        return {
          output: `Tool ${toolName} failed: ${message} Continue without it or try another approach.`,
          event: createToolEvent('mcp', `MCP tool failed: ${toolName}`, message)
        };
      }
      return this.failedToolEvent(toolName, message);
    }
  }

  private async executeMcpTool(
    toolName: string,
    args: Record<string, unknown>,
    changedFiles: Set<string>,
    signal: AbortSignal
  ): Promise<{ output: string; event: ToolEvent }> {
    const route = this.options.mcp!.describe(toolName)!;
    const referencedFiles: string[] = [];
    const resolvedArgs = await this.resolveFileReferences(args, referencedFiles) as Record<string, unknown>;
    const result = await this.options.mcp!.call(toolName, resolvedArgs, signal);

    const saved: string[] = [];
    const notes: string[] = [];
    for (const [index, file] of (result.files ?? []).entries()) {
      try {
        const name = downloadFileName(file.name ?? file.uri, file.mimeType, `${route.tool}-result${index ? `-${index + 1}` : ''}`);
        const stored = await this.saveContent(`downloads/${safeSegment(route.server)}/${name}`, file.data, file.mimeType);
        changedFiles.add(stored.path);
        saved.push(stored.path);
        notes.push(`Saved ${stored.path} (${formatBytes(stored.size)}) from the MCP result.${stored.preview ? `\n${stored.preview}` : ''}`);
      } catch (error) {
        notes.push(`Could not save an embedded ${file.mimeType ?? 'file'} from the MCP result: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
    }
    for (const link of result.links ?? []) {
      notes.push(`Resource link: ${link.uri}${link.name ? ` (${link.name})` : ''}${link.mimeType ? ` [${link.mimeType}]` : ''}. `
        + `Call download_file with {"url": ${JSON.stringify(link.uri)}, "server": ${JSON.stringify(route.server)}} to save it.`);
    }

    const detail = [
      `${route.server} · ${route.tool}`,
      ...(referencedFiles.length ? [`${referencedFiles.length} project file${referencedFiles.length === 1 ? '' : 's'} sent`] : []),
      ...(saved.length ? [`${saved.length} file${saved.length === 1 ? '' : 's'} saved`] : []),
      ...(result.links?.length ? [`${result.links.length} resource link${result.links.length === 1 ? '' : 's'}`] : []),
      ...(result.isError ? ['returned an error'] : [])
    ].join(' · ');
    const body = [result.text, ...notes].filter(Boolean).join('\n\n');
    return {
      output: result.isError ? `MCP tool ${route.tool} returned an error:\n${body}` : body || 'OK',
      event: createToolEvent('mcp', result.isError ? `MCP tool failed: ${route.tool}` : 'Called MCP tool', detail, saved[0])
    };
  }

  /** Implements download_file for MCP-host HTTP URLs, allow-listed hosts, and MCP resource URIs. */
  private async downloadFile(
    args: Record<string, unknown>,
    changedFiles: Set<string>,
    signal: AbortSignal
  ): Promise<{ output: string; event: ToolEvent }> {
    const raw = requiredString(args, 'url');
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error('url must be an absolute http(s) URL or an MCP resource URI.');
    }
    const mcp = this.options.mcp;
    const serverName = optionalString(args, 'server');
    const named = serverName ? mcp?.client(serverName) : undefined;
    if (serverName && !named) {
      throw new Error(`Unknown MCP server "${serverName}". Connected servers: ${mcp?.serverNames().join(', ') || 'none'}.`);
    }
    const destination = optionalString(args, 'path');

    const saved: Array<{ path: string; size: number; preview?: string }> = [];
    let source: string;
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      const client = named?.sharesOrigin(url) ? named : mcp?.clientForUrl(url);
      let download;
      if (client) {
        source = client.name;
        download = await client.download(url, signal);
      } else if (hostAllowed(url.hostname, this.options.downloadAllowedHosts ?? envList('AAA_DOWNLOAD_ALLOWED_HOSTS'))) {
        source = url.hostname;
        download = await httpDownload(url, this.options.httpFetch ?? globalThis.fetch, {}, 120_000, signal);
      } else {
        const hosts = (mcp?.serverNames() ?? []).map((name) => mcp!.client(name)!.config.url)
          .map((value) => { try { return new URL(value).host; } catch { return value; } });
        throw new Error(`download_file only fetches from enabled MCP server hosts (${hosts.join(', ') || 'none connected'}) `
          + 'or hosts listed in AAA_DOWNLOAD_ALLOWED_HOSTS.');
      }
      const lastSegment = decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1) ?? '');
      const name = downloadFileName(download.fileName ?? lastSegment, download.contentType, 'download');
      saved.push(await this.saveContent(destinationPath(destination, `downloads/${safeSegment(source)}`, name), download.data, download.contentType));
    } else {
      const names = mcp?.serverNames() ?? [];
      const client = named ?? (names.length === 1 ? mcp!.client(names[0]!) : undefined);
      if (!client) {
        throw new Error(names.length === 0
          ? 'No MCP server is connected to read this resource URI.'
          : `Specify server for MCP resource URIs. Connected servers: ${names.join(', ')}.`);
      }
      source = client.name;
      const contents = await client.readResource(raw, signal);
      if (contents.length === 0) throw new Error(`MCP server ${client.name} returned no content for ${raw}.`);
      for (const [index, content] of contents.entries()) {
        const name = downloadFileName(content.uri, content.mimeType, `resource${index ? `-${index + 1}` : ''}`);
        const data = content.data ?? Buffer.from(content.text ?? '', 'utf8');
        const target = contents.length === 1 ? destinationPath(destination, `downloads/${safeSegment(source)}`, name)
          : `${destination?.replace(/\/+$/, '') || `downloads/${safeSegment(source)}`}/${name}`;
        saved.push(await this.saveContent(target, data, content.mimeType));
      }
    }

    saved.forEach((file) => changedFiles.add(file.path));
    return {
      output: saved.map((file) => `Saved ${file.path} (${formatBytes(file.size)}) from ${source}.${file.preview ? `\n${file.preview}` : ''}`).join('\n\n'),
      event: createToolEvent('create', 'Downloaded file', saved.map((file) => `${file.path} (${formatBytes(file.size)})`).join(', '), saved[0]?.path)
    };
  }

  /** Saves bytes as a new project file; JSON is pretty-printed and text gets a preview for the model. */
  private async saveContent(
    targetPath: string,
    data: Buffer,
    mimeType?: string
  ): Promise<{ path: string; size: number; preview?: string }> {
    let content = data;
    assertAgentWritable(targetPath);
    const isJson = /json/i.test(mimeType ?? '') || /\.json$/i.test(targetPath);
    const isText = isJson || /^text\/|xml|yaml|csv|markdown/i.test(mimeType ?? '') || /\.(txt|md|csv|xml|ya?ml|html?|log)$/i.test(targetPath);
    let text: string | undefined;
    if (isText) {
      text = data.toString('utf8');
      if (isJson) {
        try {
          text = `${JSON.stringify(JSON.parse(text), null, 2)}\n`;
          content = Buffer.from(text, 'utf8');
        } catch {
          // Keep the original bytes when the payload is not valid JSON.
        }
      }
    }
    const stored = await this.fileService.saveNewFile(targetPath, content);
    const previewLimit = 4_000;
    return {
      path: stored.path,
      size: stored.size,
      ...(text !== undefined
        ? { preview: `Preview:\n${text.length > previewLimit ? `${text.slice(0, previewLimit)}\n[… ${text.length - previewLimit} more characters in ${stored.path}]` : text}` }
        : {})
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
    log.warn('tool', 'Tool call failed; the error was returned to the model.', { tool: toolName, error: message });
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

/** Top-level folders holding AAA state, VCS data, or project customizations. */
const protectedTopLevel = new Set(['.aaa', '.git', '.github', '.vscode']);
/** Folders the agent may never write: review hashes, enable toggles, and VCS data. */
const readOnlyTopLevel = new Set(['.aaa', '.git']);

/**
 * Rejects agent writes into AAA's own state. `.aaa` holds publication review hashes and
 * customization toggles; letting the agent write there would let it mark its own drafts
 * reviewed or re-enable capabilities the user turned off.
 */
function assertAgentWritable(target: string): string {
  const normalized = path.posix.normalize(target.replace(/\\/g, '/')).replace(/^\.\/+/, '');
  const topLevel = normalized.split('/')[0]!.toLowerCase();
  if (readOnlyTopLevel.has(topLevel)) {
    throw new Error(`${target} is inside ${topLevel}/, which holds AAA review and customization state (or version control data) and cannot be changed by the agent.`);
  }
  return target;
}

function findNode(nodes: FileTreeNode[], target: string): FileTreeNode | undefined {
  for (const node of nodes) {
    if (node.path === target) return node;
    if (node.children && target.startsWith(`${node.path}/`)) {
      const found = findNode(node.children, target);
      if (found) return found;
    }
  }
  return undefined;
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

function envList(name: string): string[] {
  return (process.env[name] ?? '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
}

/** Matches a hostname against entries such as `files.example.gov` or `*.example.gov`. */
function hostAllowed(hostname: string, allowed: string[]): boolean {
  const host = hostname.toLowerCase();
  return allowed.some((entry) => {
    const rule = entry.toLowerCase();
    return rule.startsWith('*.') ? host.endsWith(rule.slice(1)) && host.length > rule.length - 1 : host === rule;
  });
}

const mimeExtensions: Record<string, string> = {
  'application/json': '.json',
  'text/json': '.json',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'text/csv': '.csv',
  'text/html': '.html',
  'text/xml': '.xml',
  'application/xml': '.xml',
  'application/yaml': '.yaml',
  'text/yaml': '.yaml',
  'application/pdf': '.pdf',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'application/msword': '.doc',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx'
};

/** A safe single path segment. */
function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '').slice(0, 100) || 'download';
}

/** Chooses a storable file name from a URI/name hint and a MIME type. */
function downloadFileName(hint: string | undefined, mimeType: string | undefined, fallback: string): string {
  let base = hint ?? '';
  try {
    base = decodeURIComponent(base.split(/[?#]/)[0]!.split(/[/\\]/).filter(Boolean).at(-1) ?? '');
  } catch {
    base = base.split(/[/\\]/).at(-1) ?? '';
  }
  let name = safeSegment(base || fallback);
  if (!ProjectFileService.canStore(name)) {
    const extension = mimeExtensions[(mimeType ?? '').split(';')[0]!.trim().toLowerCase()];
    if (!extension) {
      throw new Error(`Files of type ${mimeType ?? 'unknown'} (${name}) cannot be saved in the project.`);
    }
    name = `${name.replace(/\.[A-Za-z0-9]{1,8}$/, '')}${extension}`;
  }
  return name;
}

/** Resolves an optional destination (file path, folder ending in /, or default folder). */
function destinationPath(destination: string | undefined, defaultFolder: string, name: string): string {
  if (!destination) return `${defaultFolder}/${name}`;
  return destination.endsWith('/') ? `${destination.replace(/\/+$/, '')}/${name}` : destination;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
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
