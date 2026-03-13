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
import { ChatMessage, ContentPart, ToolCall, ToolDefinition, ToolResult, ExtensionMessage, AgentPlanStep } from './types';

export interface AgentCallbacks {
    sendToWebview(msg: ExtensionMessage): void;
}

/** Tools that are never worth retrying (user-cancelled or confirmed unique) */
const NO_RETRY_TOOLS = new Set(['run_terminal_command', 'apply_code_action']);

/** Max number of automatic retries per tool call */
const MAX_TOOL_RETRIES = 1;

/** Delay (ms) before retrying a failed tool */
const RETRY_DELAY_MS = 600;

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

## Context Awareness
- Before the first iteration you receive a [Context Snapshot] system message with open editors, recent diagnostics, and workspace layout. Use this to orient yourself — you often don\'t need to call get_open_editors or get_file_tree at the start.
- Failed tool calls are automatically retried once. If the retry also fails, analyze the error message and try a different approach rather than repeating the same call.`;

export class AgentLoop {
    private messages: ChatMessage[] = [];
    private abortController: AbortController | null = null;
    private running = false;
    private maxIterations: number;

    constructor(
        private aoaiClient: AzureOpenAIClient,
        private builtinTools: BuiltinTools,
        private mcpClient: McpClient,
        private callbacks: AgentCallbacks
    ) {
        this.maxIterations = vscode.workspace.getConfiguration('securechat.agent')
            .get<number>('maxIterations') ?? 25;
    }

    isRunning(): boolean { return this.running; }

    getMessages(): ChatMessage[] { return [...this.messages]; }

    setMessages(messages: ChatMessage[]) {
        this.messages = messages;
    }

    clearMessages() {
        this.messages = [];
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

    private createDefaultPlan(): AgentPlanStep[] {
        return [
            { id: 'analyze', title: 'Analyze request', status: 'pending' },
            { id: 'gather', title: 'Gather code context', status: 'pending' },
            { id: 'execute', title: 'Execute tools / edits', status: 'pending' },
            { id: 'validate', title: 'Validate and finalize', status: 'pending' }
        ];
    }

    private setPlanStatus(plan: AgentPlanStep[], id: string, status: AgentPlanStep['status']) {
        const step = plan.find(s => s.id === id);
        if (step) {
            step.status = status;
        }
        this.callbacks.sendToWebview({ type: 'agentPlan', steps: [...plan] });
    }

    cancel() {
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
        this.running = false;
    }

    /** Run the agent loop: send user message, process tool calls iteratively */
    async run(userMessage: string, images?: string[], files?: { name: string; content: string }[]): Promise<void> {
        if (this.running) { return; }
        this.running = true;
        this.abortController = new AbortController();
        const plan = this.createDefaultPlan();
        this.setPlanStatus(plan, 'analyze', 'in_progress');

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
        this.setPlanStatus(plan, 'analyze', 'completed');
        this.setPlanStatus(plan, 'gather', 'in_progress');

        // Inject context snapshot before the first model call
        const contextPack = this.buildContextPack();
        if (contextPack) {
            this.messages.push({ role: 'system', content: contextPack });
        }

        try {
            let iteration = 0;
            while (iteration < this.maxIterations && this.running) {
                iteration++;
                this.callbacks.sendToWebview({ type: 'setStatus', status: `Thinking${iteration > 1 ? ` (iteration ${iteration})` : ''}...` });

                // Validate the client
                const validation = await this.aoaiClient.validate();
                if (validation) {
                    this.callbacks.sendToWebview({ type: 'error', message: `Configuration error: ${validation}` });
                    this.setPlanStatus(plan, 'gather', 'failed');
                    break;
                }

                this.setPlanStatus(plan, 'gather', 'completed');

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

                // If no tool calls, we're done
                if (toolCalls.length === 0) {
                    this.setPlanStatus(plan, 'execute', 'completed');
                    break;
                }

                this.setPlanStatus(plan, 'execute', 'in_progress');

                // Tools that are safe to run concurrently (read-only, no side effects)
                const READ_ONLY_TOOLS = new Set([
                    'read_file', 'list_directory', 'search_files', 'grep_search',
                    'semantic_search', 'get_file_tree', 'find_symbol', 'get_symbol_detail',
                    'go_to_definition', 'find_references', 'get_diagnostics', 'get_open_editors'
                ]);

                const allReadOnly = toolCalls.every(tc => READ_ONLY_TOOLS.has(tc.function.name));

                if (allReadOnly && toolCalls.length > 1) {
                    // ── Parallel execution for read-only tool calls ──
                    this.callbacks.sendToWebview({ type: 'setStatus', status: `Running ${toolCalls.length} tools in parallel...` });

                    // Show all tool calls first
                    for (const tc of toolCalls) {
                        let args: Record<string, unknown>;
                        try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }
                        this.callbacks.sendToWebview({
                            type: 'toolCall', name: tc.function.name, args: tc.function.arguments, id: tc.id
                        });
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

                        const result = await this.executeToolWithRetry(tc.function.name, args);

                        this.callbacks.sendToWebview({
                            type: 'toolResult',
                            id: tc.id,
                            result: result.result,
                            success: result.success
                        });

                        // Add tool result to history
                        this.messages.push({
                            role: 'tool',
                            content: result.result,
                            tool_call_id: tc.id,
                            name: tc.function.name
                        });
                    }
                }

                this.setPlanStatus(plan, 'execute', 'completed');
            }

            if (iteration >= this.maxIterations) {
                this.callbacks.sendToWebview({
                    type: 'error',
                    message: `Agent reached maximum iterations (${this.maxIterations}). The agent stopped to prevent an infinite loop.`
                });
                this.setPlanStatus(plan, 'validate', 'failed');
            }
        } catch (e: unknown) {
            if ((e as Error).name !== 'AbortError') {
                this.callbacks.sendToWebview({
                    type: 'error',
                    message: `Agent error: ${e instanceof Error ? e.message : String(e)}`
                });
                this.setPlanStatus(plan, 'validate', 'failed');
            }
        } finally {
            const validate = plan.find(s => s.id === 'validate');
            if (validate && validate.status === 'pending') {
                this.setPlanStatus(plan, 'validate', 'in_progress');
                this.setPlanStatus(plan, 'validate', 'completed');
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

    private async executeTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
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


