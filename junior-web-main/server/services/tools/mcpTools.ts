import { randomUUID } from 'node:crypto';
import type { ToolEvent, WorkspaceTreeNode } from '../../types.js';
import type { DiscoveredMcpTool, McpHttpRuntime } from '../mcpHttpRuntime.js';
import type { WorkspaceStorage } from '../workspaceStorage.js';
import type { LoopToolEntry } from './types.js';

interface WorkspaceFileBinding {
  argumentPath: string;
  include: string[];
  exclude?: string[];
  format?: 'path-content-objects';
}

export function createMcpTool(storage: WorkspaceStorage): LoopToolEntry {
  return {
    definition: {
      name: 'call_mcp_tool',
      description: 'Call one of the attached MCP tools using its serverId, toolName, and JSON arguments. For tools that accept workspace file content, use workspaceFileBindings to inject matching files server-side instead of reading every file first.',
      isReadOnly: true,
      requiresConfirmation: false,
      confirmationCategory: 'workspace-read',
      category: 'workspace',
      parameters: {
        type: 'object',
        properties: {
          serverId: { type: 'string' },
          toolName: { type: 'string' },
          arguments: { type: 'object' },
          workspaceFileBindings: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                argumentPath: { type: 'string', description: 'JSON Pointer destination in MCP arguments, for example /files.' },
                include: { type: 'array', items: { type: 'string' }, description: 'Workspace glob patterns such as package/**.' },
                exclude: { type: 'array', items: { type: 'string' } },
                format: { type: 'string', enum: ['path-content-objects'] }
              },
              required: ['argumentPath', 'include']
            }
          }
        },
        required: ['serverId', 'toolName']
      }
    },
    execute: async (context, args) => {
      const runtime = context.state.get('mcpRuntime') as McpHttpRuntime | undefined;
      const availableTools = context.state.get('mcpDiscoveredTools') as DiscoveredMcpTool[] | undefined;
      const serverId = String(args.serverId ?? '').trim();
      const toolName = String(args.toolName ?? '').trim();
      const toolArgs = args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments)
        ? structuredClone(args.arguments as Record<string, unknown>)
        : {};

      if (!runtime) {
        return { success: false, result: 'No MCP runtime is available for this run.' };
      }

      if (!serverId || !toolName) {
        return { success: false, result: 'serverId and toolName are required.' };
      }

      const selectedTool = availableTools?.find((tool) => tool.serverId === serverId && tool.toolName === toolName);
      if (!selectedTool) {
        return { success: false, result: `Unknown MCP tool ${toolName} on server ${serverId}.` };
      }

      try {
        const bindings = parseWorkspaceFileBindings(args.workspaceFileBindings);
        for (const binding of bindings) {
          const files = await resolveWorkspaceFiles(storage, binding);
          setJsonPointer(toolArgs, binding.argumentPath, files);
          context.toolEvents.push(createToolEvent(
            'read',
            'Bound workspace files to MCP call',
            `${files.length} file${files.length === 1 ? '' : 's'} injected at ${binding.argumentPath} for ${selectedTool.toolName}.`
          ));
        }
        const result = await runtime.callTool(serverId, toolName, toolArgs);
        context.toolEvents.push(createToolEvent('ask', `Called MCP tool ${selectedTool.toolName}`, `${selectedTool.serverName} (${selectedTool.serverId})`));
        return { success: !result.isError, result: formatMcpResult(result) };
      } catch (error) {
        return { success: false, result: error instanceof Error ? error.message : String(error) };
      }
    }
  };
}

function createToolEvent(type: ToolEvent['type'], label: string, detail?: string): ToolEvent {
  return {
    id: randomUUID(),
    type,
    label,
    detail,
    createdAt: new Date().toISOString()
  };
}

function parseWorkspaceFileBindings(value: unknown): WorkspaceFileBinding[] {
  if (typeof value === 'undefined') {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error('workspaceFileBindings must be an array.');
  }
  if (value.length > 4) {
    throw new Error('At most 4 workspace file bindings are allowed per MCP call.');
  }

  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('Each workspace file binding must be an object.');
    }
    const candidate = entry as Record<string, unknown>;
    const argumentPath = String(candidate.argumentPath ?? '').trim();
    const include = Array.isArray(candidate.include) ? candidate.include.map(String).map((item) => item.trim()).filter(Boolean) : [];
    const exclude = Array.isArray(candidate.exclude) ? candidate.exclude.map(String).map((item) => item.trim()).filter(Boolean) : [];
    if (!argumentPath.startsWith('/') || include.length === 0) {
      throw new Error('Each workspace file binding requires a JSON Pointer argumentPath and at least one include glob.');
    }
    return { argumentPath, include, exclude, format: 'path-content-objects' };
  });
}

async function resolveWorkspaceFiles(storage: WorkspaceStorage, binding: WorkspaceFileBinding): Promise<Array<{ path: string; content: string; contentType: string }>> {
  const paths = flattenFiles(await storage.listTree())
    .filter((path) => binding.include.some((pattern) => matchesGlob(path, pattern)))
    .filter((path) => !(binding.exclude ?? []).some((pattern) => matchesGlob(path, pattern)))
    .sort((left, right) => left.localeCompare(right));
  if (paths.length === 0) {
    throw new Error(`No workspace files matched: ${binding.include.join(', ')}.`);
  }
  if (paths.length > 50) {
    throw new Error(`Workspace binding matched ${paths.length} files; the maximum is 50.`);
  }

  const files: Array<{ path: string; content: string; contentType: string }> = [];
  let totalBytes = 0;
  for (const path of paths) {
    const file = await storage.readTextFile(path);
    const bytes = Buffer.byteLength(file.content, 'utf8');
    if (bytes > 1_048_576) {
      throw new Error(`Workspace file ${path} exceeds the 1 MiB MCP binding limit.`);
    }
    totalBytes += bytes;
    if (totalBytes > 4_194_304) {
      throw new Error('Workspace files exceed the 4 MiB MCP binding payload limit.');
    }
    files.push({ path, content: file.content, contentType: contentTypeForPath(path) });
  }
  return files;
}

function flattenFiles(nodes: WorkspaceTreeNode[]): string[] {
  return nodes.flatMap((node) => node.type === 'file' ? [node.path] : flattenFiles(node.children ?? []));
}

function matchesGlob(filePath: string, pattern: string): boolean {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const normalizedPattern = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  const escaped = normalizedPattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const expression = escaped.replace(/\*\*/g, '§DOUBLESTAR§').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/§DOUBLESTAR§/g, '.*');
  return new RegExp(`^${expression}$`, 'i').test(normalizedPath);
}

function setJsonPointer(target: Record<string, unknown>, pointer: string, value: unknown): void {
  const segments = pointer.split('/').slice(1).map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (segments.length === 0 || segments.some((segment) => !segment || segment === '__proto__' || segment === 'prototype' || segment === 'constructor')) {
    throw new Error(`Unsafe or invalid workspace binding argumentPath: ${pointer}`);
  }

  let current = target;
  for (const segment of segments.slice(0, -1)) {
    const existing = current[segment];
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }
  current[segments.at(-1)!] = value;
}

function contentTypeForPath(filePath: string): string {
  const extension = filePath.toLowerCase().split('.').pop();
  return extension === 'md' || extension === 'markdown' ? 'text/markdown'
    : extension === 'json' ? 'application/json'
      : extension === 'html' ? 'text/html'
        : extension === 'css' ? 'text/css'
          : 'text/plain';
}

function formatMcpResult(result: Awaited<ReturnType<McpHttpRuntime['callTool']>>): string {
  const parts: string[] = [];
  if (result.text) {
    parts.push(result.text);
  }
  if (typeof result.structuredContent !== 'undefined') {
    parts.push(JSON.stringify(result.structuredContent));
  }
  if (parts.length === 0 && result.content.length > 0) {
    parts.push(JSON.stringify(result.content));
  }
  return `${result.isError ? 'MCP tool error: ' : ''}${parts.join('\n') || 'MCP tool completed without response content.'}`;
}