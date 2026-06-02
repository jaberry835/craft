import { randomUUID } from 'node:crypto';
import type { ToolEvent } from '../../types.js';
import type { DiscoveredMcpTool, McpHttpRuntime } from '../mcpHttpRuntime.js';
import type { LoopToolEntry } from './types.js';

export function createMcpTool(): LoopToolEntry {
  return {
    definition: {
      name: 'call_mcp_tool',
      description: 'Call one of the attached MCP tools using its serverId, toolName, and JSON arguments. Only use discovered MCP tools listed in the system context.',
      isReadOnly: true,
      requiresConfirmation: false,
      confirmationCategory: 'workspace-read',
      category: 'workspace',
      parameters: {
        type: 'object',
        properties: {
          serverId: { type: 'string' },
          toolName: { type: 'string' },
          arguments: { type: 'object' }
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
        ? args.arguments as Record<string, unknown>
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
        const result = await runtime.callTool(serverId, toolName, toolArgs);
        context.toolEvents.push(createToolEvent('ask', `Called MCP tool ${selectedTool.toolName}`, `${selectedTool.serverName} (${selectedTool.serverId})`));
        return { success: true, result };
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