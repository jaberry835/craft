/**
 * Adapter that wraps existing BuiltinTools handlers as IFunctionTool
 * objects and populates a ToolRegistry.
 *
 * Also wraps MCP tools discovered by McpClient into the same interface.
 */

import type { ToolDefinition, ToolResult } from '../types';
import type { BuiltinTools } from '../builtinTools';
import type { McpClient } from '../mcpClient';
import { FunctionTool, ToolRegistry, type IFunctionTool } from '../framework/tools';

/** Tools that only read — never modify the workspace. */
const READ_ONLY_TOOLS = new Set([
    'read_file', 'list_directory', 'search_files', 'grep_search',
    'semantic_search', 'get_file_tree', 'get_document_symbols',
    'find_symbol', 'go_to_definition', 'find_references',
    'check_terminal_output', 'get_diagnostics', 'get_open_editors',
]);

/** Tools that require user confirmation before execution. */
const CONFIRMATION_TOOLS = new Set([
    'write_file', 'edit_file', 'replace_lines', 'delete_file',
    'apply_code_action', 'rename_symbol', 'run_terminal_command',
]);

/** Confirmation categories for grouping session approvals. */
const CONFIRMATION_CATEGORIES: Record<string, string> = {
    'write_file': 'file-write',
    'edit_file': 'file-edit',
    'replace_lines': 'file-edit',
    'delete_file': 'file-delete',
    'apply_code_action': 'code-action',
    'rename_symbol': 'code-action',
    'run_terminal_command': 'terminal',
};

/**
 * Build a ToolRegistry from the existing BuiltinTools instance.
 * Each registered handler becomes an IFunctionTool.
 */
export function buildToolRegistryFromBuiltins(builtinTools: BuiltinTools): ToolRegistry {
    const registry = new ToolRegistry();
    const definitions = builtinTools.getDefinitions();

    for (const def of definitions) {
        const name = def.function.name;
        const handler = builtinTools.getHandler(name);
        if (!handler) { continue; }

        const tool = new FunctionTool({
            definition: def,
            handler,
            isReadOnly: READ_ONLY_TOOLS.has(name),
            requiresConfirmation: CONFIRMATION_TOOLS.has(name),
            confirmationCategory: CONFIRMATION_CATEGORIES[name],
        });

        registry.register(tool);
    }

    return registry;
}

/**
 * Add MCP tools from an McpClient to an existing registry.
 * MCP tools are named `mcp_{serverName}_{toolName}` by convention.
 */
export function addMcpToolsToRegistry(registry: ToolRegistry, mcpClient: McpClient): void {
    const definitions = mcpClient.getToolDefinitions();

    for (const def of definitions) {
        const name = def.function.name;

        const tool: IFunctionTool = {
            name,
            definition: def,
            isReadOnly: false, // MCP tools are assumed to have side effects
            requiresConfirmation: false, // MCP tools handle their own confirmation
            execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
                return mcpClient.callTool(name, args);
            },
            validate: () => ({ valid: true, errors: [] }), // MCP schemas are self-validated
        };

        registry.register(tool);
    }
}
