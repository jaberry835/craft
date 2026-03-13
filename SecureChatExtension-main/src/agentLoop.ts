/**
 * Agent Loop — the core orchestrator.
 * Sends messages to AOAI with tool definitions, processes tool_calls,
 * executes tools, feeds results back, and iterates until done or max iterations.
 */
import * as vscode from 'vscode';
import { AzureOpenAIClient } from './aoaiClient';
import { BuiltinTools } from './builtinTools';
import { McpClient } from './mcpClient';
import { ChatMessage, ContentPart, ToolCall, ToolDefinition, ToolResult, ExtensionMessage } from './types';

export interface AgentCallbacks {
    sendToWebview(msg: ExtensionMessage): void;
}

const SYSTEM_PROMPT = `You are SecureChat Agent, a highly capable AI coding assistant running inside VS Code. You have access to tools that let you interact with the developer's workspace.

## Capabilities
- Read, write, edit and delete files in the workspace
- List directories and explore the file tree
- Search for text patterns across the codebase (grep)
- Search for files by name
- Run terminal commands (build, test, install, git, etc.)
- View compiler/lint diagnostics
- See currently open editor tabs

## Guidelines
- Always read relevant files before making changes
- Use edit_file for targeted edits (replacing exact strings) rather than rewriting entire files
- When creating new files, use write_file
- Run appropriate build/test commands after making changes to verify they work
- If a tool call fails, try to understand why and retry with adjusted parameters
- Be thorough but concise in explanations
- When the user asks you to do something, take action using tools rather than just explaining what to do`;

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

        // Add system prompt if first message
        if (this.messages.length === 0) {
            this.messages.push({ role: 'system', content: SYSTEM_PROMPT });
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

        try {
            let iteration = 0;
            while (iteration < this.maxIterations && this.running) {
                iteration++;
                this.callbacks.sendToWebview({ type: 'setStatus', status: `Thinking${iteration > 1 ? ` (iteration ${iteration})` : ''}...` });

                // Validate the client
                const validation = this.aoaiClient.validate();
                if (validation) {
                    this.callbacks.sendToWebview({ type: 'error', message: `Configuration error: ${validation}` });
                    break;
                }

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
                    break;
                }

                // Execute each tool call
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

                    const result = await this.executeTool(tc.function.name, args);

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
}
