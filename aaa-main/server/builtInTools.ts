/**
 * The single registry of AAA built-in tools. The agent harness, the tool surface, and
 * the Project customizations list all derive from this catalog, so a tool added here
 * is listed, enabled by default, and exposed to every agent without further wiring.
 */
export const builtInToolCatalog = [
  { name: 'list_files', label: 'List files', description: 'Inspect project paths without leaving the project root.', capability: 'read' },
  { name: 'read_file', label: 'Read file', description: 'Read supported UTF-8 project files.', capability: 'read' },
  { name: 'search_files', label: 'Search files', description: 'Find text across project files.', capability: 'search' },
  { name: 'write_file', label: 'Write file', description: 'Create or replace supported project text files.', capability: 'edit' },
  { name: 'edit_file', label: 'Edit file', description: 'Apply a targeted exact-text replacement.', capability: 'edit' },
  { name: 'copy_path', label: 'Copy path', description: 'Copy template files or folders without overwriting existing files.', capability: 'edit' },
  { name: 'delete_path', label: 'Delete path', description: 'Delete a project file or folder (folders need recursive; AAA state and customization folders are protected).', capability: 'edit' },
  { name: 'browser_capture', label: 'Browser capture', description: 'Launch Microsoft Edge, navigate to web pages, and save screenshot evidence.', capability: 'browser' },
  { name: 'download_file', label: 'Download file', description: 'Save files or JSON from MCP servers (HTTP URLs on their hosts or MCP resource URIs) into the project.', capability: 'download' },
  { name: 'load_skill', label: 'Load skill', description: 'Load a project skill procedure when a request matches it.', capability: 'skills' }
] as const;

export type BuiltInToolName = (typeof builtInToolCatalog)[number]['name'];

export const builtInToolNames: readonly BuiltInToolName[] = builtInToolCatalog.map((tool) => tool.name);

/** Customization item id for a built-in tool, e.g. `browser_capture` → `tool:browser-capture`. */
export function builtInToolItemId(name: string): string {
  return `tool:${name.replace(/_/g, '-')}`;
}

/** Built-in tool name for a customization item id, e.g. `tool:browser-capture` → `browser_capture`. */
export function builtInToolNameFromItemId(itemId: string): string {
  return itemId.replace(/^tool:/, '').replace(/-/g, '_');
}
