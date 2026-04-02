/**
 * MCP (Model Context Protocol) client — supports both stdio-based and HTTP-based
 * MCP servers.  Performs the JSON-RPC initialize/initialized handshake, discovers
 * tools, and proxies tool calls for the agent loop.
 *
 * stdio:  spawns a local process, communicates via newline-delimited JSON-RPC
 * HTTP:   POSTs JSON-RPC to a remote endpoint, reads JSON responses
 */
import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as http from 'http';
import * as https from 'https';
import { McpAuthSessionConfig, McpServerConfig, McpToolInfo, ToolDefinition, ToolResult } from './types';
import { getSetting } from './config';

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

interface McpConnectionBase {
    tools: McpToolInfo[];
    nextId: number;
    serverName: string;
    transport: 'stdio' | 'http';
}

interface StdioConnection extends McpConnectionBase {
    transport: 'stdio';
    process: cp.ChildProcess;
    pendingRequests: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
    buffer: Buffer;
}

interface HttpConnection extends McpConnectionBase {
    transport: 'http';
    baseUrl: string;
    headers: Record<string, string>;
    authSessionConfig?: McpAuthSessionConfig;
    sessionId?: string;
}

type McpConnection = StdioConnection | HttpConnection;

export class McpClient {
    private connections: Map<string, McpConnection> = new Map();
    private mcpToolNameMap: Map<string, { serverName: string; toolName: string }> = new Map();
    private outputChannel: vscode.OutputChannel;
    private healthCheckInterval: ReturnType<typeof setInterval> | undefined;
    /** Interval between stdio health checks (ms) */
    private static readonly HEALTH_CHECK_INTERVAL_MS = 30_000;
    /** Timeout for a single health ping (ms) */
    private static readonly HEALTH_PING_TIMEOUT_MS = 5_000;

    constructor() {
        this.outputChannel = vscode.window.createOutputChannel('Junior MCP');
        this.startHealthChecks();
    }

    /** Load MCP server configs from VS Code settings and connect to each */
    async connectConfiguredServers(): Promise<void> {
        const servers = this.getConfiguredServers();
        const names = Object.keys(servers);
        this.outputChannel.appendLine(`MCP: found ${names.length} configured server(s): ${names.join(', ') || '(none)'}`);

        for (const [name, config] of Object.entries(servers)) {
            try {
                this.outputChannel.appendLine(`MCP: connecting "${name}" — transport: ${config.url ? 'HTTP' : config.command ? 'stdio' : 'UNKNOWN'}`);
                await this.connectServer(name, config);
            } catch (e: unknown) {
                this.outputChannel.appendLine(`MCP: FAILED to connect "${name}": ${e instanceof Error ? e.message : String(e)}`);
            }
        }
        this.outputChannel.appendLine(`MCP: ${this.getToolCount()} total tools across ${this.connections.size} connected server(s)`);
    }

    private getConfiguredServers(): Record<string, McpServerConfig> {
        const ownServers = getSetting<Record<string, McpServerConfig>>('mcp.servers') || {};
        const includeExternalServers = getSetting<boolean>('mcp.includeExternalServers', true) ?? true;
        const externalServerSettings = getSetting<string[]>('mcp.externalServerSettings', ['mcp.servers']) || ['mcp.servers'];

        if (!includeExternalServers) {
            return ownServers;
        }

        const combinedServers: Record<string, McpServerConfig> = { ...ownServers };
        for (const settingPath of externalServerSettings) {
            const externalServers = this.readServerConfigSetting(settingPath);
            if (!externalServers) {
                continue;
            }

            for (const [name, config] of Object.entries(externalServers)) {
                if (!this.isMcpServerConfig(config)) {
                    this.outputChannel.appendLine(`MCP: skipped invalid config for "${name}" from setting "${settingPath}"`);
                    continue;
                }

                if (combinedServers[name]) {
                    this.outputChannel.appendLine(`MCP: keeping "${name}" from junior.mcp.servers and ignoring duplicate in "${settingPath}"`);
                    continue;
                }

                combinedServers[name] = config;
            }
        }

        return combinedServers;
    }

    private readServerConfigSetting(settingPath: string): Record<string, unknown> | undefined {
        const idx = settingPath.lastIndexOf('.');
        if (idx <= 0 || idx === settingPath.length - 1) {
            this.outputChannel.appendLine(`MCP: skipped invalid settings path "${settingPath}"`);
            return undefined;
        }

        const section = settingPath.slice(0, idx);
        const key = settingPath.slice(idx + 1);
        const value = vscode.workspace.getConfiguration(section).get<unknown>(key);

        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return undefined;
        }

        return value as Record<string, unknown>;
    }

    private isMcpServerConfig(value: unknown): value is McpServerConfig {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return false;
        }

        const config = value as McpServerConfig;
        return typeof config.command === 'string' || typeof config.url === 'string';
    }

    private hasAuthorizationHeader(headers: Record<string, string>): boolean {
        return Object.keys(headers).some(key => key.toLowerCase() === 'authorization');
    }

    private getImplicitAuthSessionConfig(config: McpServerConfig): McpAuthSessionConfig | undefined {
        if (!config.url) {
            return undefined;
        }

        try {
            const parsed = new URL(config.url);
            const isGitHubRemoteMcp = parsed.protocol === 'https:'
                && parsed.hostname === 'api.githubcopilot.com'
                && parsed.pathname.startsWith('/mcp');

            if (!isGitHubRemoteMcp) {
                if (parsed.protocol === 'https:' && /(?:login\.microsoftonline\.com|login\.microsoft\.com|login\.windows\.net)$/i.test(parsed.hostname)) {
                    return {
                        providerId: 'microsoft',
                        scopes: [],
                        tokenHeader: 'Authorization',
                        tokenScheme: 'Bearer',
                        createIfNone: true
                    };
                }

                return undefined;
            }

            return {
                providerId: 'github',
                scopes: ['repo', 'workflow', 'user:email', 'read:user'],
                tokenHeader: 'Authorization',
                tokenScheme: 'Bearer',
                createIfNone: true
            };
        } catch {
            return undefined;
        }
    }

    private async resolveHttpHeaders(name: string, config: McpServerConfig): Promise<Record<string, string>> {
        const headers = { ...(config.headers || {}) };
        if (this.hasAuthorizationHeader(headers)) {
            return headers;
        }

        const authConfig = config.authSession || this.getImplicitAuthSessionConfig(config);
        if (!authConfig) {
            return headers;
        }

        try {
            const session = authConfig.createIfNone
                ? await vscode.authentication.getSession(authConfig.providerId, authConfig.scopes || [], { createIfNone: true })
                : await vscode.authentication.getSession(authConfig.providerId, authConfig.scopes || [], { silent: true });

            if (!session?.accessToken) {
                this.outputChannel.appendLine(`MCP: no ${authConfig.providerId} auth session available for "${name}"; continuing without auth header`);
                return headers;
            }

            const tokenHeader = authConfig.tokenHeader || 'Authorization';
            const tokenScheme = authConfig.tokenScheme ?? 'Bearer';
            headers[tokenHeader] = tokenScheme ? `${tokenScheme} ${session.accessToken}` : session.accessToken;
            this.outputChannel.appendLine(`MCP: using VS Code ${authConfig.providerId} session for "${name}"`);
        } catch (e: unknown) {
            this.outputChannel.appendLine(`MCP: auth session lookup failed for "${name}": ${e instanceof Error ? e.message : String(e)}`);
        }

        return headers;
    }

    private getEffectiveAuthSessionConfig(config: McpServerConfig): McpAuthSessionConfig | undefined {
        return config.authSession || this.getImplicitAuthSessionConfig(config);
    }

    private async resolveChallengeHeaders(
        name: string,
        authConfig: McpAuthSessionConfig | undefined,
        wwwAuthenticate: string,
        existingHeaders: Record<string, string>
    ): Promise<Record<string, string> | undefined> {
        if (!authConfig) {
            return undefined;
        }

        try {
            const session = authConfig.createIfNone
                ? await vscode.authentication.getSession(
                    authConfig.providerId,
                    { wwwAuthenticate, fallbackScopes: authConfig.scopes || [] },
                    { createIfNone: true }
                )
                : await vscode.authentication.getSession(
                    authConfig.providerId,
                    { wwwAuthenticate, fallbackScopes: authConfig.scopes || [] },
                    { silent: true }
                );

            if (!session?.accessToken) {
                this.outputChannel.appendLine(`MCP: challenge auth did not yield a ${authConfig.providerId} token for "${name}"`);
                return undefined;
            }

            const tokenHeader = authConfig.tokenHeader || 'Authorization';
            const tokenScheme = authConfig.tokenScheme ?? 'Bearer';
            const headers = { ...existingHeaders };
            headers[tokenHeader] = tokenScheme ? `${tokenScheme} ${session.accessToken}` : session.accessToken;
            this.outputChannel.appendLine(`MCP: resolved OAuth challenge for "${name}" using ${authConfig.providerId}`);
            return headers;
        } catch (e: unknown) {
            this.outputChannel.appendLine(`MCP: challenge auth failed for "${name}": ${e instanceof Error ? e.message : String(e)}`);
            return undefined;
        }
    }

    async connectServer(name: string, config: McpServerConfig): Promise<void> {
        // Disconnect old connection if exists
        if (this.connections.has(name)) {
            this.disconnectServer(name);
        }

        if (config.url) {
            await this.connectHttpServer(name, config);
        } else if (config.command) {
            await this.connectStdioServer(name, config);
        } else {
            throw new Error('MCP server config must have either "command" (stdio) or "url" (HTTP).');
        }
    }

    // ── stdio transport ──────────────────────────────────────────────

    private async connectStdioServer(name: string, config: McpServerConfig): Promise<void> {
        this.outputChannel.appendLine(`Connecting to MCP server (stdio): ${name} (${config.command})`);

        const cwd = config.cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
        const proc = cp.spawn(config.command!, config.args || [], {
            cwd,
            env: { ...process.env, ...(config.env || {}) },
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            shell: process.platform === 'win32'
        });

        const conn: StdioConnection = {
            transport: 'stdio',
            process: proc,
            tools: [],
            nextId: 1,
            pendingRequests: new Map(),
            buffer: Buffer.alloc(0),
            serverName: name
        };

        proc.stderr?.on('data', (data: Buffer) => {
            this.outputChannel.appendLine(`[${name} stderr] ${data.toString()}`);
        });

        proc.on('error', (err: Error) => {
            this.outputChannel.appendLine(`[${name}] spawn error: ${err.message}`);
        });

        proc.stdout?.on('data', (data: Buffer) => {
            this.outputChannel.appendLine(`[${name} stdout] received ${data.length} bytes`);
            conn.buffer = Buffer.concat([conn.buffer, data]);
            this.processStdioBuffer(conn);
        });

        proc.on('exit', (code) => {
            this.outputChannel.appendLine(`MCP server "${name}" exited with code ${code}`);
            this.connections.delete(name);
        });

        this.connections.set(name, conn);

        try {
            await this.sendRequest(conn, 'initialize', {
                protocolVersion: '2024-11-05',
                capabilities: {},
                clientInfo: { name: 'Junior', version: '1.0.0' }
            }, 30000);

            this.sendNotification(conn, 'initialized', {});

            const toolsResult = await this.sendRequest(conn, 'tools/list', {}, 10000) as { tools?: McpToolRaw[] };
            if (toolsResult?.tools) {
                conn.tools = toolsResult.tools.map(t => ({
                    name: t.name,
                    description: t.description || '',
                    inputSchema: (t.inputSchema as McpToolInfo['inputSchema']) || { type: 'object' as const, properties: {}, required: [] },
                    serverName: name
                }));
            }
            this.outputChannel.appendLine(`MCP server "${name}" connected (stdio) with ${conn.tools.length} tools`);
        } catch (e: unknown) {
            this.outputChannel.appendLine(`MCP handshake failed for "${name}": ${e instanceof Error ? e.message : String(e)}`);
            proc.kill();
            this.connections.delete(name);
            throw e;
        }
    }

    // ── HTTP transport ───────────────────────────────────────────────

    private async connectHttpServer(name: string, config: McpServerConfig): Promise<void> {
        this.outputChannel.appendLine(`[${name}] Connecting to MCP server (HTTP): ${config.url}`);
        const headers = await this.resolveHttpHeaders(name, config);
        const authSessionConfig = this.getEffectiveAuthSessionConfig(config);

        const conn: HttpConnection = {
            transport: 'http',
            baseUrl: config.url!.replace(/\/+$/, ''),
            headers,
            authSessionConfig,
            tools: [],
            nextId: 1,
            serverName: name
        };

        this.connections.set(name, conn);

        try {
            this.outputChannel.appendLine(`[${name}] Sending initialize...`);
            const initResult = await this.sendRequest(conn, 'initialize', {
                protocolVersion: '2024-11-05',
                capabilities: {},
                clientInfo: { name: 'Junior', version: '1.0.0' }
            }, 15000);
            this.outputChannel.appendLine(`[${name}] Initialize result: ${JSON.stringify(initResult).slice(0, 500)}`);

            this.outputChannel.appendLine(`[${name}] Sending initialized notification...`);
            this.sendNotification(conn, 'initialized', {});

            this.outputChannel.appendLine(`[${name}] Requesting tools/list...`);
            const toolsResult = await this.sendRequest(conn, 'tools/list', {}, 15000) as { tools?: McpToolRaw[] };
            this.outputChannel.appendLine(`[${name}] tools/list result: ${JSON.stringify(toolsResult).slice(0, 1000)}`);

            if (toolsResult?.tools) {
                conn.tools = toolsResult.tools.map(t => ({
                    name: t.name,
                    description: t.description || '',
                    inputSchema: (t.inputSchema as McpToolInfo['inputSchema']) || { type: 'object' as const, properties: {}, required: [] },
                    serverName: name
                }));
            }
            this.outputChannel.appendLine(`[${name}] Connected (HTTP) with ${conn.tools.length} tools`);
            if (conn.tools.length > 0) {
                this.outputChannel.appendLine(`[${name}] Tools: ${conn.tools.map(t => t.name).join(', ')}`);
            }
        } catch (e: unknown) {
            this.outputChannel.appendLine(`[${name}] HTTP handshake FAILED: ${e instanceof Error ? e.stack || e.message : String(e)}`);
            this.connections.delete(name);
            throw e;
        }
    }

    /** Send a JSON-RPC request over HTTP. Handles both JSON and SSE responses. */
    private httpPost(conn: HttpConnection, body: string, timeoutMs: number, allowAuthRetry = true): Promise<{ body: string; headers: http.IncomingHttpHeaders; contentType: string }> {
        return new Promise((resolve, reject) => {
            const parsed = new URL(conn.baseUrl);
            const isHttps = parsed.protocol === 'https:';
            const mod = isHttps ? https : http;

            const reqHeaders: Record<string, string> = {
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/event-stream',
                ...conn.headers
            };

            if (conn.sessionId) {
                reqHeaders['Mcp-Session-Id'] = conn.sessionId;
            }

            const options: http.RequestOptions = {
                hostname: parsed.hostname,
                port: parsed.port || (isHttps ? 443 : 80),
                path: parsed.pathname + parsed.search,
                method: 'POST',
                headers: reqHeaders,
                timeout: timeoutMs
            };

            this.outputChannel.appendLine(`[${conn.serverName}] HTTP POST ${parsed.pathname} (${body.slice(0, 200)})`);

            const req = mod.request(options, (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (chunk: Buffer) => chunks.push(chunk));
                res.on('end', () => {
                    const responseBody = Buffer.concat(chunks).toString('utf8');
                    const ct = (res.headers['content-type'] || '').toLowerCase();

                    this.outputChannel.appendLine(`[${conn.serverName}] HTTP ${res.statusCode} Content-Type: ${ct} Body(${responseBody.length}): ${responseBody.slice(0, 500)}`);

                    // Capture session ID
                    const sid = res.headers['mcp-session-id'];
                    if (sid && typeof sid === 'string') {
                        conn.sessionId = sid;
                        this.outputChannel.appendLine(`[${conn.serverName}] Session ID: ${sid}`);
                    }

                    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                        resolve({ body: responseBody, headers: res.headers, contentType: ct });
                    } else if (allowAuthRetry && res.statusCode === 401 && typeof res.headers['www-authenticate'] === 'string') {
                        const challenge = res.headers['www-authenticate'];
                        this.resolveChallengeHeaders(conn.serverName, conn.authSessionConfig, challenge, conn.headers)
                            .then(updatedHeaders => {
                                if (!updatedHeaders) {
                                    reject(new Error(`HTTP ${res.statusCode}: ${responseBody.slice(0, 500)}`));
                                    return;
                                }

                                conn.headers = updatedHeaders;
                                this.httpPost(conn, body, timeoutMs, false).then(resolve, reject);
                            })
                            .catch(reject);
                    } else {
                        reject(new Error(`HTTP ${res.statusCode}: ${responseBody.slice(0, 500)}`));
                    }
                });
            });

            req.on('error', (err) => {
                this.outputChannel.appendLine(`[${conn.serverName}] HTTP request error: ${err.message}`);
                reject(err);
            });
            req.on('timeout', () => {
                this.outputChannel.appendLine(`[${conn.serverName}] HTTP request timed out`);
                req.destroy();
                reject(new Error('HTTP request timed out'));
            });
            req.write(body);
            req.end();
        });
    }

    disconnectServer(name: string) {
        const conn = this.connections.get(name);
        if (conn) {
            if (conn.transport === 'stdio') {
                conn.process.kill();
                conn.pendingRequests.forEach(p => p.reject(new Error('Server disconnected')));
            }
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
        this.mcpToolNameMap.clear();
        const usedNames = new Set<string>();

        for (const conn of this.connections.values()) {
            for (const tool of conn.tools) {
                const functionName = this.makeFunctionName(conn.serverName, tool.name, usedNames);
                this.mcpToolNameMap.set(functionName, { serverName: conn.serverName, toolName: tool.name });

                defs.push({
                    type: 'function',
                    function: {
                        name: functionName,
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
        const mapped = this.mcpToolNameMap.get(fullName);
        const serverName = mapped?.serverName;
        const toolName = mapped?.toolName;

        // Backward-compat fallback for any previously generated names.
        if (!serverName || !toolName) {
            const match = fullName.match(/^mcp_([^_]+)_(.+)$/);
            if (!match) {
                return { success: false, result: `Invalid MCP tool name format: ${fullName}` };
            }

            return this.callToolByName(match[1], match[2], args);
        }

        return this.callToolByName(serverName, toolName, args);
    }

    private async callToolByName(serverName: string, toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
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

    private makeFunctionName(serverName: string, toolName: string, usedNames: Set<string>): string {
        const serverPart = this.sanitizeFunctionNamePart(serverName) || 'server';
        const toolPart = this.sanitizeFunctionNamePart(toolName) || 'tool';
        const base = `mcp_${serverPart}_${toolPart}`;

        let candidate = base;
        let index = 2;
        while (usedNames.has(candidate)) {
            candidate = `${base}_${index}`;
            index++;
        }

        usedNames.add(candidate);
        return candidate;
    }

    private sanitizeFunctionNamePart(value: string): string {
        // Azure OpenAI expects function names to match: ^[a-zA-Z0-9_\.-]+$
        return value.replace(/[^a-zA-Z0-9_.-]/g, '_');
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

    // ── JSON-RPC transport (dispatch by type) ──

    private sendRequest(conn: McpConnection, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
        if (conn.transport === 'http') {
            return this.sendHttpRequest(conn, method, params, timeoutMs);
        }
        return this.sendStdioRequest(conn, method, params, timeoutMs);
    }

    private sendNotification(conn: McpConnection, method: string, params: unknown) {
        if (conn.transport === 'http') {
            // Fire-and-forget HTTP POST for notifications
            const id = conn.nextId++;
            const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
            this.httpPost(conn, JSON.stringify(msg), 5000).catch(() => {});
            return;
        }
        const msg: JsonRpcNotification = { jsonrpc: '2.0', method, params };
        const payload = `${JSON.stringify(msg)}\n`;
        (conn as StdioConnection).process.stdin?.write(payload);
    }

    // ── HTTP request ──

    private async sendHttpRequest(conn: HttpConnection, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
        const id = conn.nextId++;
        const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
        const { body, contentType } = await this.httpPost(conn, JSON.stringify(msg), timeoutMs);

        // Handle SSE responses (text/event-stream)
        if (contentType.includes('text/event-stream')) {
            return this.parseSSEResponse(conn.serverName, body, id);
        }

        // Plain JSON response
        try {
            const parsed = JSON.parse(body) as JsonRpcResponse;
            if (parsed.error) {
                throw new Error(parsed.error.message);
            }
            return parsed.result;
        } catch (e) {
            if (e instanceof SyntaxError) {
                throw new Error(`Invalid JSON response: ${body.slice(0, 200)}`);
            }
            throw e;
        }
    }

    /**
     * Parse an SSE (Server-Sent Events) response body.
     * Extracts JSON-RPC messages from `data:` lines and returns the result
     * matching the given request id.
     */
    private parseSSEResponse(serverName: string, body: string, requestId: number): unknown {
        const lines = body.split('\n');
        let lastResult: unknown = undefined;

        for (const line of lines) {
            if (!line.startsWith('data:')) { continue; }
            const data = line.slice(5).trim();
            if (!data || data === '[DONE]') { continue; }

            try {
                const parsed = JSON.parse(data);
                this.outputChannel.appendLine(`[${serverName}] SSE event: ${data.slice(0, 300)}`);

                // JSON-RPC response with matching id
                if (parsed.id === requestId) {
                    if (parsed.error) {
                        throw new Error(parsed.error.message);
                    }
                    return parsed.result;
                }

                // JSON-RPC response without id match — store as fallback
                if ('result' in parsed) {
                    lastResult = parsed.result;
                }

                // Some servers send the result directly as a non-RPC object
                if (parsed.tools || parsed.capabilities || parsed.protocolVersion) {
                    lastResult = parsed;
                }
            } catch (e) {
                if (e instanceof SyntaxError) {
                    this.outputChannel.appendLine(`[${serverName}] SSE parse skip: ${data.slice(0, 100)}`);
                } else {
                    throw e;
                }
            }
        }

        if (lastResult !== undefined) {
            return lastResult;
        }

        this.outputChannel.appendLine(`[${serverName}] SSE: no matching result found for id ${requestId}`);
        return undefined;
    }

    // ── stdio request ──

    private sendStdioRequest(conn: StdioConnection, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
        const id = conn.nextId++;
        const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
        const payload = `${JSON.stringify(msg)}\n`;

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                conn.pendingRequests.delete(id);
                reject(new Error(`Request timed out: ${method}`));
            }, timeoutMs);

            conn.pendingRequests.set(id, {
                resolve: (val) => { clearTimeout(timer); resolve(val); },
                reject: (err) => { clearTimeout(timer); reject(err); }
            });

            conn.process.stdin?.write(payload, (err) => {
                if (err) {
                    clearTimeout(timer);
                    conn.pendingRequests.delete(id);
                    reject(err);
                }
            });
        });
    }

    private processStdioBuffer(conn: StdioConnection) {
        while (true) {
            if (conn.buffer.length === 0) {
                break;
            }

            // Legacy framing support: Content-Length headers.
            const headerMarker = Buffer.from('Content-Length:', 'utf8');
            if (conn.buffer.subarray(0, headerMarker.length).equals(headerMarker)) {
                const crlfHeaderEnd = conn.buffer.indexOf(Buffer.from('\r\n\r\n', 'utf8'));
                const lfHeaderEnd = conn.buffer.indexOf(Buffer.from('\n\n', 'utf8'));
                const headerEnd = crlfHeaderEnd !== -1 ? crlfHeaderEnd : lfHeaderEnd;
                const separatorLength = crlfHeaderEnd !== -1 ? 4 : 2;
                if (headerEnd === -1) {
                    break;
                }

                const header = conn.buffer.toString('utf8', 0, headerEnd);
                const match = header.match(/Content-Length:\s*(\d+)/i);
                if (!match) {
                    conn.buffer = conn.buffer.subarray(headerEnd + separatorLength);
                    continue;
                }

                const contentLength = parseInt(match[1], 10);
                const bodyStart = headerEnd + separatorLength;
                if (conn.buffer.length < bodyStart + contentLength) {
                    break;
                }

                const body = conn.buffer.toString('utf8', bodyStart, bodyStart + contentLength);
                conn.buffer = conn.buffer.subarray(bodyStart + contentLength);
                this.handleStdioMessage(conn, body);
                continue;
            }

            // Current MCP SDK framing: one JSON-RPC message per line.
            const newlineIndex = conn.buffer.indexOf(0x0a);
            if (newlineIndex === -1) {
                break;
            }

            const line = conn.buffer.toString('utf8', 0, newlineIndex).replace(/\r$/, '').trim();
            conn.buffer = conn.buffer.subarray(newlineIndex + 1);
            if (!line) {
                continue;
            }

            this.handleStdioMessage(conn, line);
        }
    }

    private handleStdioMessage(conn: StdioConnection, body: string) {
        try {
            const parsed = JSON.parse(body) as JsonRpcResponse | JsonRpcNotification;
            if ('id' in parsed && parsed.id != null) {
                const pending = conn.pendingRequests.get(parsed.id);
                if (pending) {
                    conn.pendingRequests.delete(parsed.id);
                    if ('error' in parsed && parsed.error) {
                        pending.reject(new Error(parsed.error.message));
                    } else if ('result' in parsed) {
                        pending.resolve(parsed.result);
                    } else {
                        pending.resolve(undefined);
                    }
                }
                return;
            }

            this.outputChannel.appendLine(`[${conn.serverName}] notification: ${body.slice(0, 300)}`);
        } catch {
            this.outputChannel.appendLine(`[${conn.serverName}] Parse error: ${body.slice(0, 200)}`);
        }
    }

    dispose() {
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
            this.healthCheckInterval = undefined;
        }
        this.disconnectAll();
        this.outputChannel.dispose();
    }

    /** Periodically ping stdio connections to detect hung/dead servers */
    private startHealthChecks() {
        this.healthCheckInterval = setInterval(() => {
            for (const [name, conn] of this.connections) {
                if (conn.transport !== 'stdio') { continue; }
                // Check if the process is still alive
                if (conn.process.exitCode !== null) {
                    this.outputChannel.appendLine(`MCP health: "${name}" process exited (code ${conn.process.exitCode}). Removing.`);
                    this.connections.delete(name);
                    continue;
                }
                // Send a lightweight ping (tools/list is safe and idempotent)
                this.sendRequest(conn, 'ping', {}, McpClient.HEALTH_PING_TIMEOUT_MS).catch(() => {
                    // ping may not be supported — try tools/list as fallback
                    this.sendRequest(conn, 'tools/list', {}, McpClient.HEALTH_PING_TIMEOUT_MS).catch(() => {
                        this.outputChannel.appendLine(`MCP health: "${name}" is unresponsive. Disconnecting.`);
                        this.disconnectServer(name);
                    });
                });
            }
        }, McpClient.HEALTH_CHECK_INTERVAL_MS);
    }
}

interface McpToolRaw {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
}

