/**
 * Agent Loop — the core orchestrator.
 * Sends messages to AOAI with tool definitions, processes tool_calls,
 * executes tools, feeds results back, and iterates until done or max iterations.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { AzureOpenAIClient } from './aoaiClient';
import { BuiltinTools } from './builtinTools';
import { McpClient } from './mcpClient';
import { ContextManager } from './contextManager';
import { validateToolArgs, buildToolSchemaMap } from './toolValidator';
import { getSetting } from './config';
import { ChatMessage, ContentPart, ToolCall, ToolDefinition, ToolResult, ExtensionMessage, AgentPlanStep } from './types';

export interface AgentCallbacks {
    sendToWebview(msg: ExtensionMessage): void;
}

/** Tools that are never worth retrying (user-cancelled or confirmed unique) */
const NO_RETRY_TOOLS = new Set(['run_terminal_command', 'apply_code_action', 'edit_file', 'set_plan', 'update_plan_step']);

/** Max number of automatic retries per tool call */
const MAX_TOOL_RETRIES = 1;

/** Delay (ms) before retrying a failed tool */
const RETRY_DELAY_MS = 600;

/** Max number of auto-fix cycles when the model stops but errors remain */
const MAX_AUTOFIX_CYCLES = 3;

/** Tools that modify files — used to track which files may have new diagnostics */
const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'delete_file', 'apply_code_action', 'rename_symbol']);

const SYSTEM_PROMPT = `You are Junior Agent, a highly capable AI coding assistant running inside VS Code. You have access to tools that let you interact with the developer's workspace.

## Capabilities
- Read, write, edit and delete files in the workspace
- List directories and explore the file tree
- Resolve document symbols, definitions, and references
- Perform semantic code search over indexed chunks
- Search for text patterns across the codebase (grep)
- Search for files by name
- Run terminal commands (build, test, install, git, etc.)
- View compiler/lint diagnostics
- See currently open editor tabs

## Guidelines
- Always read relevant files before making changes
- Do NOT re-read a file you already read in this conversation unless you need to verify an edit you just made. The content is already in your context.
- For code navigation questions (where defined/used), prefer symbol tools (find_symbol, get_document_symbols, go_to_definition, find_references) before broad grep
- For conceptual questions (architecture/flow), prefer semantic_search before broad grep
- Use edit_file for targeted edits (replacing exact strings) rather than rewriting entire files
- When creating new files, use write_file
- Run appropriate build/test commands after making changes to verify they work
- If a tool call fails, try to understand why and retry with adjusted parameters
- Be thorough but concise in explanations
- When the user asks you to do something, take action using tools rather than just explaining what to do

## Post-Edit Validation
- After write_file and edit_file, diagnostics are automatically checked. If the result includes "Post-edit diagnostics", errors or warnings were detected.
- When you see post-edit diagnostics with Errors, fix them immediately using edit_file before moving on. Do not ignore errors.
- For Warnings, use your judgment — fix them if straightforward, otherwise note them and continue.
- Use apply_code_action to list and apply VS Code quick-fixes when available (e.g. auto-imports, missing declarations).
- After multiple edits, run get_diagnostics with no path to check the overall workspace health before finishing.

## Large File Handling
- read_file output includes line numbers (e.g. "42: const x = 1;") — use these to orient yourself.
- Large files are auto-capped at the first 250 lines. Only use startLine/endLine to read MORE if you specifically need content beyond what was shown. Do NOT re-read sections you already have.
- For edit_file, include enough surrounding context in old_string (3-5 lines before and after) to ensure a unique match.
- If edit_file fails with "not found", re-read the target area with read_file to get the exact current text, then retry.

## Context Awareness
- Before the first iteration you receive a [Context Snapshot] system message with open editors, recent diagnostics, and workspace layout. Use this to orient yourself — you often don\'t need to call get_open_editors or get_file_tree at the start.
- Failed tool calls are automatically retried once. If the retry also fails, analyze the error message and try a different approach rather than repeating the same call.

## Planning
- At the START of every task, call set_plan with 3-6 specific, actionable steps describing your approach.
- As you begin each step, call update_plan_step with status "in_progress".
- When you finish a step, call update_plan_step with status "completed".
- If a step fails, call update_plan_step with status "failed".
- Keep step titles short (under 10 words). Example: "Read the relevant source files", "Add validation to handleSubmit", "Run build to verify".`;

export class AgentLoop {
    private messages: ChatMessage[] = [];
    private abortController: AbortController | null = null;
    private running = false;
    private maxIterations: number;
    /** Dynamic plan steps set by the model via set_plan / update_plan_step tools */
    private planSteps: AgentPlanStep[] = [];
    private contextManager = new ContextManager();
    /** Cached tool name → definition map for argument validation. */
    private toolSchemaMap: Map<string, ToolDefinition> = new Map();
    /** Files edited during the current agent run (relative paths). */
    private editedFiles: Set<string> = new Set();

    constructor(
        private aoaiClient: AzureOpenAIClient,
        private builtinTools: BuiltinTools,
        private mcpClient: McpClient,
        private callbacks: AgentCallbacks
    ) {
        this.maxIterations = getSetting<number>('agent.maxIterations') ?? 25;
    }

    isRunning(): boolean { return this.running; }

    getMessages(): ChatMessage[] { return [...this.messages]; }

    setMessages(messages: ChatMessage[]) {
        this.messages = messages;
    }

    clearMessages() {
        this.messages = [];
        this.planSteps = [];
    }

    /**
     * Load custom project instructions from well-known file paths.
     * Checks (in order): .junior/instructions.md, .github/copilot-instructions.md
     * Returns the file contents or null if none found.
     */
    private loadCustomInstructions(): string | null {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root) { return null; }
        const candidates = [
            path.join(root, '.junior', 'instructions.md'),
            path.join(root, '.github', 'copilot-instructions.md'),
        ];
        for (const filePath of candidates) {
            try {
                if (fs.existsSync(filePath)) {
                    const content = fs.readFileSync(filePath, 'utf-8').trim();
                    if (content.length > 0) {
                        // Cap at 4000 chars to avoid ballooning the system prompt
                        return content.length > 4000
                            ? content.slice(0, 4000) + '\n... [instructions truncated]'
                            : content;
                    }
                }
            } catch { /* ignore read errors */ }
        }
        return null;
    }

    /** Called by set_plan tool — replaces the plan with new steps (first step auto-starts) */
    setPlan(steps: { id: string; title: string }[]) {
        this.planSteps = steps.map((s, i) => ({
            id: s.id, title: s.title,
            status: i === 0 ? 'in_progress' as const : 'pending' as const
        }));
        this.callbacks.sendToWebview({ type: 'agentPlan', steps: [...this.planSteps] });
    }

    /** Called by update_plan_step tool — updates a step's status and auto-advances */
    updatePlanStep(stepId: string, status: AgentPlanStep['status']) {
        const step = this.planSteps.find(s => s.id === stepId);
        if (step) {
            step.status = status;
            // Auto-advance: if completed/failed and no step is in_progress, start next pending
            if ((status === 'completed' || status === 'failed') &&
                !this.planSteps.some(s => s.status === 'in_progress')) {
                const next = this.planSteps.find(s => s.status === 'pending');
                if (next) { next.status = 'in_progress'; }
            }
            // The agentPlan message triggers the frontend to detect plan step changes
            // and split/create new progress cards automatically.
            this.callbacks.sendToWebview({ type: 'agentPlan', steps: [...this.planSteps] });
        }
    }

    cancel() {
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
        this.running = false;
    }

    /** Map a tool name + args to a progress card icon and human-readable label */
    private describeToolForProgress(name: string, args: Record<string, unknown>): { icon: 'search' | 'read' | 'edit' | 'run' | 'check' | 'loading'; label: string; detail?: string } {
        switch (name) {
            case 'grep_search':
                return { icon: 'search', label: `Searched for regex ${typeof args.pattern === 'string' ? `\`${args.pattern}\`` : ''}`, detail: typeof args.include === 'string' ? `(${args.include})` : undefined };
            case 'search_files':
                return { icon: 'search', label: `Searched files: ${args.query || ''}` };
            case 'semantic_search':
                return { icon: 'search', label: `Semantic search: ${args.query || ''}` };
            case 'find_symbol':
                return { icon: 'search', label: `Found symbol: ${args.name || ''}` };
            case 'go_to_definition':
                return { icon: 'search', label: `Go to definition: ${args.symbol || ''}` };
            case 'find_references':
                return { icon: 'search', label: `Find references: ${args.symbol || ''}` };
            case 'read_file':
                return { icon: 'read', label: `Read ${this.shortPath(args.path)}`, detail: args.startLine ? `lines ${args.startLine} to ${args.endLine || ''}` : undefined };
            case 'get_document_symbols':
                return { icon: 'read', label: `Loaded symbols for ${this.shortPath(args.path)}` };
            case 'list_directory':
                return { icon: 'read', label: `Listed ${this.shortPath(args.path) || '.'}` };
            case 'get_file_tree':
                return { icon: 'read', label: 'Loaded workspace file tree' };
            case 'get_open_editors':
                return { icon: 'read', label: 'Checked open editors' };
            case 'get_diagnostics':
                return { icon: 'check', label: `Diagnostics${args.path ? ' for ' + this.shortPath(args.path) : ''}` };
            case 'write_file':
                return { icon: 'edit', label: `Created ${this.shortPath(args.path)}` };
            case 'edit_file':
                return { icon: 'edit', label: `Edited ${this.shortPath(args.path)}` };
            case 'delete_file':
                return { icon: 'edit', label: `Deleted ${this.shortPath(args.path)}` };
            case 'apply_code_action':
                return { icon: 'edit', label: `Applied code action at ${this.shortPath(args.path)}` };
            case 'run_terminal_command':
                return { icon: 'run', label: `Ran: ${this.truncateStr(String(args.command || ''), 60)}` };
            case 'set_plan':
                return { icon: 'loading', label: 'Setting plan' };
            case 'update_plan_step':
                return { icon: 'loading', label: 'Updating plan step' };
            default:
                if (name.startsWith('mcp_')) {
                    return { icon: 'run', label: `MCP: ${name.replace(/^mcp_/, '')}` };
                }
                return { icon: 'loading', label: `Running: ${name}` };
        }
    }

    private shortPath(p: unknown): string {
        if (typeof p !== 'string') { return ''; }
        // Show just the last 2-3 path segments
        const parts = p.replace(/\\/g, '/').split('/');
        return parts.length > 3 ? parts.slice(-3).join('/') : p;
    }

    private truncateStr(s: string, max: number): string {
        return s.length <= max ? s : s.slice(0, max) + '...';
    }

    /** Run the agent loop: send user message, process tool calls iteratively */
    async run(userMessage: string, images?: string[], files?: { name: string; content: string }[]): Promise<void> {
        if (this.running) { return; }
        this.running = true;
        this.abortController = new AbortController();
        this.planSteps = [];
        this.editedFiles.clear();
        let activeCardTitle: string | null = null;
        let autofixCycles = 0;

        // Add system prompt if first message
        if (this.messages.length === 0) {
            let prompt = SYSTEM_PROMPT;
            const customInstructions = this.loadCustomInstructions();
            if (customInstructions) {
                prompt += '\n\n## Custom Project Instructions\n' + customInstructions;
            }
            this.messages.push({ role: 'system', content: prompt });
        }

        // Build user message content — multimodal array when images/files are present
        const hasImages = images && images.length > 0;
        const hasFiles = files && files.length > 0;

        if (hasImages || hasFiles) {
            const parts: ContentPart[] = [];

            // Prepend file contents as context
            if (hasFiles) {
                for (const f of files!) {
                    parts.push({ type: 'text', text: `[Attached file: ${f.name}]\n${f.content}` });
                }
            }

            // Add user text
            if (userMessage.trim()) {
                parts.push({ type: 'text', text: userMessage });
            }

            // Add images for vision API
            if (hasImages) {
                for (const dataUri of images!) {
                    parts.push({ type: 'image_url', image_url: { url: dataUri } });
                }
            }

            this.messages.push({ role: 'user', content: parts });
        } else {
            this.messages.push({ role: 'user', content: userMessage });
        }

        // Gather all tool definitions
        const tools = this.getAllToolDefinitions();
        this.toolSchemaMap = buildToolSchemaMap(tools);

        // Inject context snapshot before the first model call
        const contextPack = this.buildContextPack();
        if (contextPack) {
            this.messages.push({ role: 'system', content: contextPack });
        }

        try {
            // Show status when the API is rate-limited and retrying
            this.aoaiClient.setRetryCallback((waitSec, attempt, maxRetries) => {
                this.callbacks.sendToWebview({
                    type: 'setStatus',
                    status: `Rate limited — retrying in ${waitSec}s (attempt ${attempt}/${maxRetries})...`
                });
            });

            let iteration = 0;
            activeCardTitle = null;
            while (iteration < this.maxIterations && this.running) {
                iteration++;
                this.callbacks.sendToWebview({ type: 'setStatus', status: `Thinking${iteration > 1 ? ` (iteration ${iteration})` : ''}...` });

                // Trim context if approaching the window limit
                this.messages = this.contextManager.trimIfNeeded(this.messages);

                // Validate the client
                const validation = await this.aoaiClient.validate();
                if (validation) {
                    this.callbacks.sendToWebview({ type: 'error', message: `Configuration error: ${validation}` });
                    break;
                }

                this.callbacks.sendToWebview({ type: 'setStatus', status: `Thinking${iteration > 1 ? ` (iteration ${iteration})` : ''}...` });

                // Stream the response
                this.callbacks.sendToWebview({ type: 'startAssistantMessage' });

                let assistantText = '';
                let toolCalls: ToolCall[] = [];

                const stream = this.aoaiClient.streamChat(
                    this.messages,
                    tools,
                    this.abortController.signal
                );

                for await (const chunk of stream) {
                    if (!this.running) { break; }

                    if (chunk.type === 'text') {
                        assistantText += chunk.text;
                        this.callbacks.sendToWebview({ type: 'appendAssistantText', text: chunk.text });
                    } else if (chunk.type === 'toolCalls') {
                        toolCalls = chunk.calls;
                    }
                }

                this.callbacks.sendToWebview({ type: 'endAssistantMessage' });

                if (!this.running) { break; }

                // Add assistant message to history
                const assistantMsg: ChatMessage = {
                    role: 'assistant',
                    content: assistantText || null
                };
                if (toolCalls.length > 0) {
                    assistantMsg.tool_calls = toolCalls;
                }
                this.messages.push(assistantMsg);

                // If no tool calls, check for unfixed errors before ending
                if (toolCalls.length === 0) {
                    if (autofixCycles < MAX_AUTOFIX_CYCLES && this.editedFiles.size > 0) {
                        const errorSummary = await this.checkEditedFileDiagnostics();
                        if (errorSummary) {
                            autofixCycles++;
                            this.messages.push({
                                role: 'system',
                                content: `[Auto-fix] The following errors were detected in files you edited. Please fix them before finishing:\n${errorSummary}`
                            });
                            this.callbacks.sendToWebview({ type: 'setStatus', status: `Auto-fixing errors (cycle ${autofixCycles}/${MAX_AUTOFIX_CYCLES})...` });
                            continue;
                        }
                    }
                    break;
                }

                // Tools that are safe to run concurrently (read-only, no side effects)
                const READ_ONLY_TOOLS = new Set([
                    'read_file', 'list_directory', 'search_files', 'grep_search',
                    'semantic_search', 'get_file_tree', 'find_symbol', 'get_symbol_detail',
                    'go_to_definition', 'find_references', 'get_diagnostics', 'get_open_editors',
                    'set_plan', 'update_plan_step'
                ]);

                const allReadOnly = toolCalls.every(tc => READ_ONLY_TOOLS.has(tc.function.name));

                // Start or reuse progress card for this batch of tool calls
                const currentStep = this.planSteps.find(s => s.status === 'in_progress');
                const cardTitle = currentStep ? currentStep.title : `Working`;
                this.callbacks.sendToWebview({ type: 'progressCardStart', title: cardTitle });
                activeCardTitle = cardTitle;

                if (allReadOnly && toolCalls.length > 1) {
                    // ── Parallel execution for read-only tool calls ──
                    this.callbacks.sendToWebview({ type: 'setStatus', status: `Running ${toolCalls.length} tools in parallel...` });

                    // Show all tool calls and emit progress steps
                    for (const tc of toolCalls) {
                        let args: Record<string, unknown>;
                        try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }
                        this.callbacks.sendToWebview({
                            type: 'toolCall', name: tc.function.name, args: tc.function.arguments, id: tc.id
                        });
                        const desc = this.describeToolForProgress(tc.function.name, args);
                        this.callbacks.sendToWebview({ type: 'progressCardStep', icon: desc.icon, label: desc.label, detail: desc.detail, status: 'running', toolName: tc.function.name });
                    }

                    // Execute all in parallel
                    const results = await Promise.all(toolCalls.map(async (tc) => {
                        let args: Record<string, unknown>;
                        try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }
                        const result = await this.executeToolWithRetry(tc.function.name, args);
                        return { tc, result };
                    }));

                    // Report results and add to history
                    for (const { tc, result } of results) {
                        this.callbacks.sendToWebview({
                            type: 'toolResult', id: tc.id, result: result.result, success: result.success
                        });
                        let args: Record<string, unknown>;
                        try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }
                        // Track edited files for auto-fix
                        if (result.success && WRITE_TOOLS.has(tc.function.name) && typeof args.path === 'string') {
                            this.editedFiles.add(args.path);
                        }
                        const desc = this.describeToolForProgress(tc.function.name, args);
                        this.callbacks.sendToWebview({ type: 'progressCardStep', icon: result.success ? 'done' : 'error', label: desc.label, detail: desc.detail, status: result.success ? 'done' : 'error', toolName: tc.function.name });
                        this.messages.push({
                            role: 'tool', content: result.result, tool_call_id: tc.id, name: tc.function.name
                        });
                    }
                } else {
                    // ── Sequential execution (writes / mixed / single tool) ──
                    for (const tc of toolCalls) {
                        if (!this.running) { break; }

                        this.callbacks.sendToWebview({ type: 'setStatus', status: `Running: ${tc.function.name}` });

                        let args: Record<string, unknown>;
                        try {
                            args = JSON.parse(tc.function.arguments);
                        } catch {
                            args = {};
                        }

                        this.callbacks.sendToWebview({
                            type: 'toolCall',
                            name: tc.function.name,
                            args: tc.function.arguments,
                            id: tc.id
                        });

                        // Emit progress step as "running"
                        const desc = this.describeToolForProgress(tc.function.name, args);
                        this.callbacks.sendToWebview({ type: 'progressCardStep', icon: desc.icon, label: desc.label, detail: desc.detail, status: 'running', toolName: tc.function.name });

                        const result = await this.executeToolWithRetry(tc.function.name, args);

                        // Track edited files for auto-fix
                        if (result.success && WRITE_TOOLS.has(tc.function.name) && typeof args.path === 'string') {
                            this.editedFiles.add(args.path);
                        }

                        this.callbacks.sendToWebview({
                            type: 'toolResult',
                            id: tc.id,
                            result: result.result,
                            success: result.success
                        });

                        // Update the last progress step with the result
                        this.callbacks.sendToWebview({ type: 'progressCardStep', icon: result.success ? 'done' : 'error', label: desc.label, detail: desc.detail, status: result.success ? 'done' : 'error', toolName: tc.function.name });

                        // Add tool result to history
                        this.messages.push({
                            role: 'tool',
                            content: result.result,
                            tool_call_id: tc.id,
                            name: tc.function.name
                        });
                    }
                }

                // Signal end of this tool batch (frontend may merge with next if same title)
                this.callbacks.sendToWebview({ type: 'progressCardEnd' });

            }

            if (iteration >= this.maxIterations) {
                this.callbacks.sendToWebview({
                    type: 'error',
                    message: `Agent reached maximum iterations (${this.maxIterations}). The agent stopped to prevent an infinite loop.`
                });
            }
        } catch (e: unknown) {
            if ((e as Error).name !== 'AbortError') {
                this.callbacks.sendToWebview({
                    type: 'error',
                    message: `Agent error: ${e instanceof Error ? e.message : String(e)}`
                });
            }
        } finally {
            // Final close for any lingering card
            this.callbacks.sendToWebview({ type: 'progressCardEnd' });
            // Mark any remaining pending/in-progress plan steps as completed
            for (const step of this.planSteps) {
                if (step.status === 'in_progress' || step.status === 'pending') {
                    step.status = 'completed';
                }
            }
            if (this.planSteps.length > 0) {
                this.callbacks.sendToWebview({ type: 'agentPlan', steps: [...this.planSteps] });
            }
            this.running = false;
            this.abortController = null;
            this.callbacks.sendToWebview({ type: 'agentDone' });
            this.callbacks.sendToWebview({ type: 'setStatus', status: '' });
        }
    }

    private getAllToolDefinitions(): ToolDefinition[] {
        const builtin = this.builtinTools.getDefinitions();
        const mcp = this.mcpClient.getToolDefinitions();
        return [...builtin, ...mcp];
    }

    /**
     * Check diagnostics on all files edited during this run.
     * Returns a summary string of Error-level diagnostics, or null if clean.
     */
    private async checkEditedFileDiagnostics(): Promise<string | null> {
        if (this.editedFiles.size === 0) { return null; }

        // Wait briefly for language servers to process changes
        await new Promise(r => setTimeout(r, 800));

        const errors: string[] = [];
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root) { return null; }

        for (const relPath of this.editedFiles) {
            const absPath = path.resolve(root, relPath);
            const uri = vscode.Uri.file(absPath);
            try {
                const diags = vscode.languages.getDiagnostics(uri);
                for (const d of diags) {
                    if (d.severity === vscode.DiagnosticSeverity.Error) {
                        errors.push(`${relPath}:${d.range.start.line + 1}: [Error] ${d.message}`);
                    }
                }
            } catch {
                // File may have been deleted — skip
            }
        }

        if (errors.length === 0) { return null; }
        // Cap at 20 errors to avoid bloating context
        const capped = errors.slice(0, 20);
        if (errors.length > 20) {
            capped.push(`... and ${errors.length - 20} more errors.`);
        }
        return capped.join('\n');
    }

    private async executeTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
        // Validate arguments against the tool's schema
        const toolDef = this.toolSchemaMap.get(name);
        if (toolDef) {
            const validation = validateToolArgs(toolDef, args);
            if (!validation.valid) {
                return { success: false, result: `Invalid arguments: ${validation.errors.join(' ')}` };
            }
        }

        // Check built-in tools first
        const handler = this.builtinTools.getHandler(name);
        if (handler) {
            return handler(args);
        }

        // Check MCP tools (prefixed with "mcp_")
        if (name.startsWith('mcp_')) {
            return this.mcpClient.callTool(name, args);
        }

        return { success: false, result: `Unknown tool: ${name}` };
    }

    /**
     * Execute a tool with automatic retry on failure.
     * Retries once after a short delay unless the tool is in the no-retry set
     * or the failure indicates user cancellation.
     */
    private async executeToolWithRetry(name: string, args: Record<string, unknown>): Promise<ToolResult> {
        const result = await this.executeTool(name, args);

        if (result.success) { return result; }

        // Don't retry certain tools or user-declined actions
        if (NO_RETRY_TOOLS.has(name)) { return result; }
        if (result.result.includes('User declined')) { return result; }
        if (result.result.includes('Invalid path')) { return result; }

        // Retry once
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        const retry = await this.executeTool(name, args);
        if (!retry.success) {
            retry.result = `[Retry also failed] ${retry.result}`;
        }
        return retry;
    }

    /**
     * Build a concise context snapshot to inject before the first model call.
     * Gives the model awareness of open files, diagnostics, and workspace shape
     * without requiring extra tool calls.
     */
    private buildContextPack(): string {
        const sections: string[] = [];

        // 1. Open editors
        try {
            const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs);
            const openFiles = tabs
                .map(t => {
                    const input = t.input as { uri?: vscode.Uri } | undefined;
                    return input?.uri ? vscode.workspace.asRelativePath(input.uri, false) : null;
                })
                .filter(Boolean);
            if (openFiles.length > 0) {
                sections.push('Open editors:\n' + openFiles.map(f => `  ${f}`).join('\n'));
            }
        } catch { /* ignore */ }

        // 2. Active diagnostics (errors and warnings only, capped)
        try {
            const allDiags = vscode.languages.getDiagnostics() as [vscode.Uri, vscode.Diagnostic[]][];
            const important: string[] = [];
            for (const [uri, diags] of allDiags) {
                for (const d of diags) {
                    if (d.severity > vscode.DiagnosticSeverity.Warning) { continue; }
                    const relPath = vscode.workspace.asRelativePath(uri, false);
                    const sev = d.severity === vscode.DiagnosticSeverity.Error ? 'Error' : 'Warning';
                    important.push(`  ${relPath}:${d.range.start.line + 1}: [${sev}] ${d.message}`);
                }
                if (important.length >= 20) { break; }
            }
            if (important.length > 0) {
                sections.push('Active diagnostics:\n' + important.join('\n'));
            }
        } catch { /* ignore */ }

        // 3. Active file (the focused editor)
        try {
            const activeEditor = vscode.window.activeTextEditor;
            if (activeEditor) {
                const relPath = vscode.workspace.asRelativePath(activeEditor.document.uri, false);
                const line = activeEditor.selection.active.line + 1;
                sections.push(`Active file: ${relPath} (cursor at line ${line})`);
            }
        } catch { /* ignore */ }

        // 4. Workspace name
        try {
            const wsName = vscode.workspace.workspaceFolders?.[0]?.name;
            if (wsName) {
                sections.push(`Workspace: ${wsName}`);
            }
        } catch { /* ignore */ }

        if (sections.length === 0) { return ''; }
        return '[Context Snapshot]\n' + sections.join('\n\n');
    }
}


