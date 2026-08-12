import { DefaultAzureCredential } from '@azure/identity';
import type { ResolvedMcpServerDefinition } from '../types.js';

interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: { message?: string };
  tools?: unknown;
  capabilities?: unknown;
  protocolVersion?: string;
}

interface McpToolRaw {
  name: string;
  description?: string;
  inputSchema?: {
    type?: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

export interface DiscoveredMcpTool {
  serverId: string;
  serverName: string;
  toolName: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface McpToolCallResult {
  isError: boolean;
  text?: string;
  structuredContent?: unknown;
  content: Array<Record<string, unknown>>;
}

interface McpConnectionState {
  server: ResolvedMcpServerDefinition;
  sessionId?: string;
}

export class McpHttpRuntime {
  private static readonly credential = new DefaultAzureCredential();
  private readonly connections = new Map<string, McpConnectionState>();

  constructor(private readonly servers: ResolvedMcpServerDefinition[]) {}

  async discoverTools(): Promise<{ tools: DiscoveredMcpTool[]; warnings: string[] }> {
    const tools: DiscoveredMcpTool[] = [];
    const warnings: string[] = [];

    for (const server of this.servers) {
      try {
        const connection = this.connectionFor(server);
        await this.sendRequest(connection, 'initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'Junior', version: '1.0.0' }
        }, 15000);
        void this.sendNotification(connection, 'initialized', {}).catch(() => undefined);
        const result = await this.sendRequest(connection, 'tools/list', {}, 15000) as { tools?: McpToolRaw[] };
        for (const tool of result.tools ?? []) {
          tools.push({
            serverId: server.id,
            serverName: server.name,
            toolName: tool.name,
            description: tool.description ?? '',
            inputSchema: {
              type: 'object',
              properties: tool.inputSchema?.properties ?? {},
              ...(tool.inputSchema?.required ? { required: tool.inputSchema.required } : {})
            }
          });
        }
      } catch (error) {
        const cachedTools = server.discoveredTools ?? [];
        for (const tool of cachedTools) {
          tools.push({
            serverId: server.id,
            serverName: server.name,
            toolName: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema
          });
        }
        warnings.push(`${server.name}: ${error instanceof Error ? error.message : String(error)}${cachedTools.length > 0 ? `; using ${cachedTools.length} persisted tool definition${cachedTools.length === 1 ? '' : 's'}` : ''}`);
      }
    }

    return { tools, warnings };
  }

  async callTool(serverId: string, toolName: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    const connection = this.connections.get(serverId);
    if (!connection) {
      throw new Error(`MCP server is not connected: ${serverId}`);
    }

    const result = await this.sendRequest(connection, 'tools/call', {
      name: toolName,
      arguments: args
    }, 30000) as {
      content?: Array<Record<string, unknown>>;
      structuredContent?: unknown;
      isError?: boolean;
    };

    const content = Array.isArray(result.content) ? result.content : [];
    const text = content
      .filter((item) => item.type === 'text' && typeof item.text === 'string')
      .map((item) => String(item.text))
      .join('\n')
      .trim();

    return {
      isError: Boolean(result.isError),
      ...(text ? { text } : {}),
      ...(Object.hasOwn(result, 'structuredContent') ? { structuredContent: result.structuredContent } : {}),
      content
    };
  }

  private connectionFor(server: ResolvedMcpServerDefinition): McpConnectionState {
    const existing = this.connections.get(server.id);
    if (existing) {
      return existing;
    }

    const next: McpConnectionState = { server };
    this.connections.set(server.id, next);
    return next;
  }

  private async sendNotification(connection: McpConnectionState, method: string, params: unknown): Promise<void> {
    await this.httpPost(connection, {
      jsonrpc: '2.0',
      id: Date.now(),
      method,
      params
    }, 5000);
  }

  private async sendRequest(connection: McpConnectionState, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    const response = await this.httpPost(connection, {
      jsonrpc: '2.0',
      id,
      method,
      params
    }, timeoutMs);

    if (response.contentType.includes('text/event-stream')) {
      return this.parseSseResponse(connection.server.name, response.body, id);
    }

    let parsed: JsonRpcResponse;
    try {
      parsed = JSON.parse(response.body) as JsonRpcResponse;
    } catch {
      throw new Error(`Invalid JSON response from ${connection.server.name}.`);
    }

    if (parsed.error?.message) {
      throw new Error(parsed.error.message);
    }

    return parsed.result;
  }

  private async httpPost(connection: McpConnectionState, payload: Record<string, unknown>, timeoutMs: number): Promise<{ body: string; contentType: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const headers = await this.buildHeaders(connection.server);
      const response = await fetch(connection.server.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...(connection.sessionId ? { 'Mcp-Session-Id': connection.sessionId } : {}),
          ...headers
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      const sessionId = response.headers.get('mcp-session-id');
      if (sessionId) {
        connection.sessionId = sessionId;
      }

      const body = await response.text();
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${body.slice(0, 300)}`);
      }

      return {
        body,
        contentType: (response.headers.get('content-type') ?? '').toLowerCase()
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Request timed out for ${connection.server.name}.`, { cause: error });
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private parseSseResponse(serverName: string, body: string, requestId: number): unknown {
    const lines = body.split('\n');
    let fallback: unknown;

    for (const line of lines) {
      if (!line.startsWith('data:')) {
        continue;
      }

      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') {
        continue;
      }

      let parsed: JsonRpcResponse;
      try {
        parsed = JSON.parse(data) as JsonRpcResponse;
      } catch {
        continue;
      }

      if (parsed.id === requestId) {
        if (parsed.error?.message) {
          throw new Error(parsed.error.message);
        }
        return parsed.result;
      }

      if (typeof parsed.result !== 'undefined') {
        fallback = parsed.result;
      } else if (parsed.tools || parsed.capabilities || parsed.protocolVersion) {
        fallback = parsed;
      }
    }

    if (typeof fallback !== 'undefined') {
      return fallback;
    }

    throw new Error(`No matching SSE result returned from ${serverName}.`);
  }

  private async buildHeaders(server: ResolvedMcpServerDefinition): Promise<Record<string, string>> {
    const headers: Record<string, string> = { ...(server.customHeaders ?? {}) };

    switch (server.authMode) {
      case 'bearer-token':
        if (server.bearerToken) {
          headers.Authorization = `Bearer ${server.bearerToken}`;
        }
        break;
      case 'api-key':
        if (server.apiKey) {
          headers['x-api-key'] = server.apiKey;
          headers['api-key'] = server.apiKey;
        }
        break;
      case 'entra': {
        const scope = server.audience?.trim();
        if (!scope) {
          throw new Error(`MCP server ${server.name} is missing an Entra audience.`);
        }
        const token = await McpHttpRuntime.credential.getToken(scope);
        if (!token?.token) {
          throw new Error(`No Entra token available for ${server.name}.`);
        }
        headers.Authorization = `Bearer ${token.token}`;
        break;
      }
      default:
        break;
    }

    return headers;
  }
}