export const seedFiles: Record<string, string> = {
  'README.md': `# Workspace

This is your Junior workspace. Add files Junior should read or edit, then chat with an agent to draft, review, and publish changes.

- Drop documents into \`notes/\` or any folder you create.
- Agent edits arrive as pending changes you approve before publishing.
`,
  'skills/site-publishing/SKILL.md': `# Site publishing

Use this skill when the user asks to publish workspace content through an attached MCP server.

1. Treat \`package/**\` as the default publication root unless the user names another path.
2. Exclude \`.junior/**\`, conversation history, temporary notes, and unrelated workspace files.
3. Inspect the workspace once and call the MCP server's site-list operation once when an existing site must be identified.
4. Prefer updating an existing site. Do not delete a site unless the user explicitly requests deletion or the MCP contract requires replacement.
5. Do not read every publication file into model context. Call \`call_mcp_tool\` with \`workspaceFileBindings\` so Junior injects matching file contents into the MCP arguments server-side.
6. Set each binding's \`argumentPath\` to the file-array field required by the selected MCP tool, usually \`/files\`.
7. Return the published URL or identifier, site ID, and number of files transferred.
8. If the MCP result is an error, report the exact actionable error and do not claim publication succeeded.
`,
  'notes/.keep': ''
};