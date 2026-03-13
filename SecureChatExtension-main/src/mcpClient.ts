/**
 * MCP (Model Context Protocol) client — spawns stdio-based MCP servers,
 * performs the JSON-RPC initialize/initialized handshake, discovers tools,
 * and proxies tool calls for the agent loop.
 */
import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import { McpServerConfig, McpToolInfo, ToolDefinition, ToolResult } from './types';

interface JsonRpcRequest {
    jsonrpc: '2.0';
    id: number;
    method: string;
    params?: unknown;
}

interface JsonRpcResponse {
    jsonrpc: '2.0';
    id: number;
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
    jsonrpc: '2.0';
    method: string;
    params?: unknown;
}

interface McpConnection {
    process: cp.ChildProcess;
    tools: McpToolInfo[];
    nextId: number;
    pendingRequests: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
    buffer: string;
    serverName: string;
}

export class McpClient {
    private connections: Map<string, McpConnection> = new Map();
    private outputChannel: vscode.OutputChannel;

    constructor() {
        this.outputChannel = vscode.window.createOutputChannel('SecureChat MCP');
    }

    /** Load MCP server configs from VS Code settings and connect to each */
    async connectConfiguredServers(): Promise<void> {
        const cfg = vscode.workspace.getConfiguration('securechat.mcp');
        const servers = cfg.get<Record<string, McpServerConfig>>('servers') || {};

        for (const [name, config] of Object.entries(servers)) {
            try {
                await this.connectServer(name, config);
            } catch (e: unknown) {
                this.outputChannel.appendLine(`Failed to connect MCP server "${name}": ${e instanceof Error ? e.message : String(e)}`);
            }
        }
    }

    async connectServer(name: string, config: McpServerConfig): Promise<void> {
        // Disconnect old connection if exists
        if (this.connections.has(name)) {
            this.disconnectServer(name);
        }

        this.outputChannel.appendLine(`Connecting to MCP server: ${name} (${config.command})`);

        const cwd = config.cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
        const proc = cp.spawn(config.command, config.args || [], {
            cwd,
            env: { ...process.env, ...(config.env || {}) },
            stdio: ['pipe', 'pipe', 'pipe']
        });

        const conn: McpConnection = {
            process: proc,
            tools: [],
            nextId: 1,
            pendingRequests: new Map(),
            buffer: '',
            serverName: name
        };

        // Handle stderr
        proc.stderr?.on('data', (data: Buffer) => {
            this.outputChannel.appendLine(`[${name} stderr] ${data.toString()}`);
        });

        // Handle stdout (JSON-RPC over stdio with Content-Length headers)
        proc.stdout?.on('data', (data: Buffer) => {
            conn.buffer += data.toString();
            this.processBuffer(conn);
        });

        proc.on('exit', (code) => {
            this.outputChannel.appendLine(`MCP server "${name}" exited with code ${code}`);
            this.connections.delete(name);
        });

        this.connections.set(name, conn);

        // MCP initialize handshake
        try {
            const initResult = await this.sendRequest(conn, 'initialize', {
                protocolVersion: '2024-11-05',
                capabilities: {},
                clientInfo: { name: 'SecureChat', version: '1.0.0' }
            }, 10000) as { capabilities?: { tools?: unknown } };

            // Send initialized notification
            this.sendNotification(conn, 'initialized', {});

            // Discover tools
            const toolsResult = await this.sendRequest(conn, 'tools/list', {}, 10000) as { tools?: McpToolRaw[] };
            if (toolsResult?.tools) {
                conn.tools = toolsResult.tools.map(t => ({
                    name: t.name,
                    description: t.description || '',
                    inputSchema: (t.inputSchema as McpToolInfo['inputSchema']) || { type: 'object' as const, properties: {}, required: [] },
                    serverName: name
                }));
            }
            this.outputChannel.appendLine(`MCP server "${name}" connected with ${conn.tools.length} tools`);
        } catch (e: unknown) {
            this.outputChannel.appendLine(`MCP handshake failed for "${name}": ${e instanceof Error ? e.message : String(e)}`);
            proc.kill();
            this.connections.delete(name);
            throw e;
        }
    }

    disconnectServer(name: string) {
        const conn = this.connections.get(name);
        if (conn) {
            conn.process.kill();
            conn.pendingRequests.forEach(p => p.reject(new Error('Server disconnected')));
            this.connections.delete(name);
            this.outputChannel.appendLine(`Disconnected MCP server: ${name}`);
        }
    }

    disconnectAll() {
        for (const name of [...this.connections.keys()]) {
            this.disconnectServer(name);
        }
    }

    /** Get all discovered MCP tools as OpenAI function definitions */
    getToolDefinitions(): ToolDefinition[] {
        const defs: ToolDefinition[] = [];
        for (const conn of this.connections.values()) {
            for (const tool of conn.tools) {
                defs.push({
                    type: 'function',
                    function: {
                        name: `mcp_${conn.serverName}_${tool.name}`,
                        description: `[MCP: ${conn.serverName}] ${tool.description}`,
                        parameters: tool.inputSchema
                    }
                });
            }
        }
        return defs;
    }

    /** Call an MCP tool — name format: mcp_{serverName}_{toolName} */
    async callTool(fullName: string, args: Record<string, unknown>): Promise<ToolResult> {
        // Parse mcp_<serverName>_<toolName>
        const match = fullName.match(/^mcp_([^_]+)_(.+)$/);
        if (!match) {
            return { success: false, result: `Invalid MCP tool name format: ${fullName}` };
        }

        const serverName = match[1];
        const toolName = match[2];
        const conn = this.connections.get(serverName);
        if (!conn) {
            return { success: false, result: `MCP server "${serverName}" is not connected.` };
        }

        try {
            const response = await this.sendRequest(conn, 'tools/call', {
                name: toolName,
                arguments: args
            }, 30000) as { content?: Array<{ type: string; text?: string }> };

            const text = response?.content
                ?.filter(c => c.type === 'text')
                .map(c => c.text)
                .join('\n') || 'No response';

            return { success: true, result: text };
        } catch (e: unknown) {
            return { success: false, result: `MCP tool call failed: ${e instanceof Error ? e.message : String(e)}` };
        }
    }

    getConnectedServers(): string[] {
        return [...this.connections.keys()];
    }

    getToolCount(): number {
        let count = 0;
        for (const conn of this.connections.values()) {
            count += conn.tools.length;
        }
        return count;
    }

    // ── JSON-RPC transport ──

    private sendRequest(conn: McpConnection, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
        const id = conn.nextId++;
        const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
        const payload = JSON.stringify(msg);
        const frame = `Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`;

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                conn.pendingRequests.delete(id);
                reject(new Error(`Request timed out: ${method}`));
            }, timeoutMs);

            conn.pendingRequests.set(id, {
                resolve: (val) => { clearTimeout(timer); resolve(val); },
                reject: (err) => { clearTimeout(timer); reject(err); }
            });

            conn.process.stdin?.write(frame, (err) => {
                if (err) {
                    clearTimeout(timer);
                    conn.pendingRequests.delete(id);
                    reject(err);
                }
            });
        });
    }

    private sendNotification(conn: McpConnection, method: string, params: unknown) {
        const msg: JsonRpcNotification = { jsonrpc: '2.0', method, params };
        const payload = JSON.stringify(msg);
        const frame = `Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`;
        conn.process.stdin?.write(frame);
    }

    private processBuffer(conn: McpConnection) {
        while (true) {
            // Look for Content-Length header
            const headerEnd = conn.buffer.indexOf('\r\n\r\n');
            if (headerEnd === -1) { break; }

            const header = conn.buffer.slice(0, headerEnd);
            const match = header.match(/Content-Length:\s*(\d+)/i);
            if (!match) {
                // Skip malformed data
                conn.buffer = conn.buffer.slice(headerEnd + 4);
                continue;
            }

            const contentLength = parseInt(match[1], 10);
            const bodyStart = headerEnd + 4;
            if (conn.buffer.length < bodyStart + contentLength) {
                break; // Wait for more data
            }

            const body = conn.buffer.slice(bodyStart, bodyStart + contentLength);
            conn.buffer = conn.buffer.slice(bodyStart + contentLength);

            try {
                const parsed = JSON.parse(body) as JsonRpcResponse;
                if ('id' in parsed && parsed.id != null) {
                    const pending = conn.pendingRequests.get(parsed.id);
                    if (pending) {
                        conn.pendingRequests.delete(parsed.id);
                        if (parsed.error) {
                            pending.reject(new Error(parsed.error.message));
                        } else {
                            pending.resolve(parsed.result);
                        }
                    }
                }
                // Notifications (no id) are logged but not processed
                if (!('id' in parsed)) {
                    this.outputChannel.appendLine(`[${conn.serverName}] notification: ${body}`);
                }
            } catch (e) {
                this.outputChannel.appendLine(`[${conn.serverName}] Parse error: ${body.slice(0, 200)}`);
            }
        }
    }

    dispose() {
        this.disconnectAll();
        this.outputChannel.dispose();
    }
}

interface McpToolRaw {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
}
