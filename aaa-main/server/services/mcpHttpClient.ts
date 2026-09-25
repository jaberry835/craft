import type { ModelToolDefinition } from '../modelTypes.js';

type Fetch = typeof globalThis.fetch;

export interface McpServerConfig {
  name: string;
  url: string;
  headers?: Record<string, string>;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpToolResult {
  text: string;
  isError: boolean;
  structured?: unknown;
}

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  result?: unknown;
  error?: { code?: number; message?: string };
}

const protocolVersion = '2025-06-18';

function envMilliseconds(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Servers that recently failed to connect are skipped for a short period so that an
 * unreachable server (common on isolated networks, where packets are dropped rather
 * than refused) does not stall every chat turn. Keyed by server name and URL.
 */
const unreachableServers = new Map<string, { until: number; message: string }>();
const healthKey = (server: McpServerConfig) => `${server.name}|${server.url}`;

/** Clears the remembered failure for a server, e.g. after a successful connection test. */
export function markMcpServerHealthy(server: McpServerConfig): void {
  unreachableServers.delete(healthKey(server));
}

/** Test hook: forget every remembered MCP server failure. */
export function resetMcpServerHealth(): void {
  unreachableServers.clear();
}

/**
 * Minimal MCP client for the Streamable HTTP transport. It supports the subset AAA
 * needs (initialize, tools/list, tools/call) with JSON or SSE responses and optional
 * Mcp-Session-Id sessions, without adding an SDK dependency to the offline bundle.
 *
 * Connecting and listing tools use a short timeout (`AAA_MCP_CONNECT_TIMEOUT_MS`,
 * default 8 s) so a down server fails fast; tool calls use a longer one
 * (`AAA_MCP_TOOL_TIMEOUT_MS`, default 120 s) for legitimately slow work.
 */
export class McpHttpClient {
  private sessionId?: string;
  private negotiatedVersion?: string;
  private initialized = false;
  private nextId = 1;

  constructor(
    private readonly server: McpServerConfig,
    private readonly fetchImpl: Fetch = globalThis.fetch,
    private readonly callTimeoutMs = envMilliseconds('AAA_MCP_TOOL_TIMEOUT_MS', 120_000),
    private readonly connectTimeoutMs = envMilliseconds('AAA_MCP_CONNECT_TIMEOUT_MS', 8_000)
  ) {}

  get name(): string {
    return this.server.name;
  }

  get config(): McpServerConfig {
    return this.server;
  }

  async listTools(signal?: AbortSignal): Promise<McpTool[]> {
    await this.initialize(signal);
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const result = await this.request('tools/list', cursor ? { cursor } : {}, signal, this.connectTimeoutMs) as {
        tools?: McpTool[];
        nextCursor?: string;
      };
      tools.push(...(result.tools ?? []).filter((tool) => typeof tool?.name === 'string'));
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolResult> {
    await this.initialize(signal);
    const result = await this.request('tools/call', { name, arguments: args }, signal, this.callTimeoutMs) as {
      content?: Array<{ type?: string; text?: string; resource?: { text?: string; uri?: string } }>;
      structuredContent?: unknown;
      isError?: boolean;
    };
    const parts = (result.content ?? []).map((item) => {
      if (item.type === 'text' && typeof item.text === 'string') return item.text;
      if (item.type === 'resource' && item.resource) return item.resource.text ?? item.resource.uri ?? '';
      return item.type ? `[${item.type} content]` : '';
    }).filter(Boolean);
    if (result.structuredContent !== undefined) {
      parts.push(parts.length ? `Structured result: ${JSON.stringify(result.structuredContent)}` : JSON.stringify(result.structuredContent));
    }
    return { text: parts.join('\n'), isError: result.isError === true, structured: result.structuredContent };
  }

  private async initialize(signal?: AbortSignal): Promise<void> {
    if (this.initialized) return;
    const result = await this.request('initialize', {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: 'aaa-workbench', version: '0.1.0' }
    }, signal, this.connectTimeoutMs) as { protocolVersion?: string };
    this.negotiatedVersion = typeof result?.protocolVersion === 'string' ? result.protocolVersion : protocolVersion;
    const acknowledgement = await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, signal, this.connectTimeoutMs);
    await acknowledgement.body?.cancel().catch(() => undefined);
    this.initialized = true;
  }

  private async request(
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    timeoutMs: number
  ): Promise<unknown> {
    const id = this.nextId++;
    const response = await this.post({ jsonrpc: '2.0', id, method, params }, signal, timeoutMs);
    const sessionId = response.headers.get('mcp-session-id');
    if (sessionId) this.sessionId = sessionId;
    const contentType = response.headers.get('content-type') ?? '';
    const message = contentType.includes('text/event-stream')
      ? await this.readSseResponse(response, id)
      : await response.json() as JsonRpcMessage;
    if (message.error) {
      throw new Error(`MCP server ${this.server.name} rejected ${method}: ${message.error.message ?? 'unknown error'}`);
    }
    return message.result ?? {};
  }

  private async post(body: Record<string, unknown>, signal: AbortSignal | undefined, timeoutMs: number): Promise<Response> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signals = [timeout, ...(signal ? [signal] : [])];
    let response: Response;
    try {
      response = await this.fetchImpl(this.server.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...(this.negotiatedVersion ? { 'MCP-Protocol-Version': this.negotiatedVersion } : {}),
          ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
          ...this.server.headers
        },
        body: JSON.stringify(body),
        signal: AbortSignal.any(signals)
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error(timeout.aborted
        ? `MCP server ${this.server.name} did not respond within ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`} at ${safeHost(this.server.url)}.`
        : `MCP server ${this.server.name} could not be reached at ${safeHost(this.server.url)}.`, {
        cause: error
      });
    }
    if (!response.ok) {
      throw new Error(`MCP server ${this.server.name} returned HTTP ${response.status}.`);
    }
    return response;
  }

  private async readSseResponse(response: Response, id: number): Promise<JsonRpcMessage> {
    if (!response.body) throw new Error(`MCP server ${this.server.name} returned an empty stream.`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = done ? '' : events.pop() ?? '';
        for (const event of events) {
          const data = event.split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          if (!data) continue;
          const message = JSON.parse(data) as JsonRpcMessage;
          if (message.id === id) return message;
        }
        if (done) break;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    throw new Error(`MCP server ${this.server.name} closed the stream without a response.`);
  }
}

/** Exposes the tools of one or more MCP servers to the model under collision-free function names. */
export class McpToolbox {
  private readonly routes = new Map<string, { client: McpHttpClient; tool: string }>();

  constructor(
    private readonly clients: McpHttpClient[],
    private readonly retryAfterMs = envMilliseconds('AAA_MCP_RETRY_AFTER_MS', 60_000)
  ) {}

  /**
   * Lists every server's tools in parallel. A server that fails, times out, or failed
   * recently is reported in `errors` and skipped; it never fails or blocks the run.
   */
  async load(
    signal?: AbortSignal,
    filter?: (server: string, tool: string) => boolean
  ): Promise<{ definitions: ModelToolDefinition[]; errors: string[] }> {
    const listed = await Promise.all(this.clients.map(async (client) => {
      const key = healthKey(client.config);
      const known = unreachableServers.get(key);
      if (known && known.until > Date.now()) {
        const seconds = Math.ceil((known.until - Date.now()) / 1000);
        return { client, error: `${known.message} Skipped; AAA retries it in about ${seconds} s.` };
      }
      try {
        const tools = await client.listTools(signal);
        unreachableServers.delete(key);
        return { client, tools };
      } catch (error) {
        if (signal?.aborted) throw error;
        const message = error instanceof Error ? error.message : `MCP server ${client.name} is unavailable.`;
        unreachableServers.set(key, { until: Date.now() + this.retryAfterMs, message });
        console.error(`[mcp] ${message} Continuing without its tools.`);
        return { client, error: `${message} Continuing without its tools.` };
      }
    }));

    const definitions: ModelToolDefinition[] = [];
    const errors: string[] = [];
    for (const { client, tools, error } of listed) {
      if (error) {
        errors.push(error);
        continue;
      }
      for (const tool of tools ?? []) {
        if (filter && !filter(client.name, tool.name)) continue;
        const functionName = this.uniqueName(`mcp_${client.name}_${tool.name}`);
        this.routes.set(functionName, { client, tool: tool.name });
        const { $schema: _schema, ...schema } = tool.inputSchema ?? {};
        void _schema;
        definitions.push({
          type: 'function',
          function: {
            name: functionName,
            description: `[MCP ${client.name}] ${tool.description ?? tool.name}`.slice(0, 900)
              + ' String arguments may be "aaa-file:<project-relative-path>" to send that project file\'s text.',
            parameters: {
              type: 'object',
              properties: {},
              ...schema
            } as ModelToolDefinition['function']['parameters']
          }
        });
      }
    }
    return { definitions, errors };
  }

  has(functionName: string): boolean {
    return this.routes.has(functionName);
  }

  describe(functionName: string): { server: string; tool: string } | undefined {
    const route = this.routes.get(functionName);
    return route ? { server: route.client.name, tool: route.tool } : undefined;
  }

  async call(functionName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolResult> {
    const route = this.routes.get(functionName);
    if (!route) throw new Error(`Unknown MCP tool: ${functionName}`);
    return route.client.callTool(route.tool, args, signal);
  }

  private uniqueName(candidate: string): string {
    const base = candidate.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
    let name = base;
    for (let suffix = 2; this.routes.has(name); suffix += 1) {
      name = `${base.slice(0, 60)}_${suffix}`;
    }
    return name;
  }
}

function safeHost(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return 'the configured endpoint';
  }
}
