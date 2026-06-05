- Build Junior Workbench as a web-first client for Junior's agent-working-over-files loop.
- Preserve the separation between client UI, server-side agent service, workspace storage, permission gates, and publish flow.
- Keep VS Code-specific APIs out of shared/server code; adapt filesystem, secrets, auth, webview messaging, diagnostics, diff, terminal, and settings behind web-friendly interfaces.
- Start with local filesystem workspace storage for development and keep the boundary ready for Blob Storage, Git-backed storage, or Azure Files later.
- Treat agent writes as pending changes that humans can inspect, approve, or undo before publishing.
- Keep the first vertical slice small, typed, and easy to replace with the real Junior AgentLoop from SecureChatExtension.

## Workspace Write Behavior

- Assume you can create and edit files/folders in this workspace unless the user explicitly asks for a plan-only response.
- When asked to implement something, perform the changes directly in the repo instead of only describing them.
- Create missing directories/files as needed to complete the task end-to-end.
- Prefer making small, concrete edits and then report exactly what changed.
- If a write is blocked by tooling, permissions, or ambiguity, state the blocker and propose the next concrete command/edit.
