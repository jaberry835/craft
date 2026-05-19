# Junior Workbench Handoff

## Product Goal

Junior Workbench is the web version of Junior, currently a VS Code extension. It should be a purpose-built Azure-hosted web app for building security approval packages. Users should not need VS Code.

## Non-Negotiable Loop

Preserve Junior's agent-working-over-files loop. This is not just a chatbot. The agent must iterate over a workspace: ask questions, create and edit files, read and search package docs, show pending changes, let humans approve or undo changes, and finally publish the package as a static website.

Files are the source of truth. Chat is the coordination layer.

## Recommended Architecture

- Web app UI with chat panel, file tree, Monaco editor, markdown preview, package preview, and publish flow.
- Server-side Junior agent service that owns model access, auth, tools, retrieval, file edits, sessions, permissions, and audit.
- Storage abstraction for workspaces.
- Local filesystem storage for development.
- Blob Storage or Git-backed storage for production.
- Azure Files only where filesystem semantics are required.
- Static output to Azure Static Web Apps, Blob static hosting, or App Service.
- Optional browser extension companion for capturing context from portals/pages.
- Keep VS Code Junior as a power-user client, but make the web app the approachable client.

## Existing Junior Reference

Local reference repo: `C:\Users\SystemAdministrator\source\repos\SecureChatExtension`

Important extension concepts to port behind web-friendly adapters:

- `AgentLoop` with middleware pipeline.
- Built-in tool registry.
- Custom agents.
- Retrieval and workspace indexing.
- Session state.
- Permission gates.
- File tools, search tools, terminal tools.
- VS Code webview UI messaging.
- Pending file changes with approve and undo.

VS Code-specific APIs that need adapters:

- Workspace filesystem.
- SecretStorage.
- Webview messaging.
- Diagnostics.
- Inline diff.
- Terminal.
- Authentication.
- Settings.

## Workspace Indexing Requirement

The web app should treat the package workspace like Junior treats a VS Code workspace.

The workspace model must:

- Maintain a file tree of all package files.
- Index file names, paths, and metadata.
- Index document contents for search and retrieval.
- Let the agent use tools like `read_file`, `search_files`, `grep_search`, `semantic_search`, `write_file`, and `edit_file`.
- Refresh the index when files change.
- Feed relevant package context into the agent loop before each turn.
- Keep generated package artifacts, evidence docs, decisions, assumptions, and open questions as normal workspace files.

Recommended layered index:

- Workspace manifest: paths, file types, modified timestamps, sizes, hashes, package status.
- Text index: keyword search over Markdown, JSON, YAML, TXT, CSV, and similar docs.
- Semantic index: chunk documents, embed chunks, retrieve relevant context for each agent turn.
- Package structure index: domain files and folders such as `intake.md`, `architecture.md`, `data-classification.md`, `threat-model.md`, `controls.md`, `risk-register.md`, `approval-summary.md`, `evidence/`, `decisions/`, and `questions.md`.
- Change index: track what the agent changed during a run so the user can review, approve, undo, or publish.

The model should not merely remember chat. It should have grounded knowledge of the whole working package through indexed files.

## First Vertical Slice

1. Scaffold a TypeScript web app.
2. Add a file-tree/workspace model.
3. Add markdown editor and preview.
4. Add chat panel.
5. Add backend API for agent messages and workspace file operations.
6. Implement local filesystem workspace storage first.
7. Add fake/simple agent tool loop first, then port Junior `AgentLoop`.
8. Add diff/approve model.
9. Add static package preview/publish.

## Current Implementation Notes

This repo contains the first slice:

- React + Vite client in `src/`.
- Express API in `server/`.
- Custom-agent style definitions in `config/agents.json`; the web UI can edit the selected agent prompt and Azure AI Search grounding endpoint/index.
- Azure OpenAI model connection metadata in `config/agent-connections.json`; Entra ID is the default auth mode, and API keys are optional fallback env vars.
- Local workspace storage in `server/services/localWorkspaceStorage.ts`.
- Workspace manifest/text/package-section index in `server/services/workspaceIndexer.ts`.
- Optional Azure AI Search grounding in `server/services/groundingService.ts`.
- Pending change tracking in `server/services/changeManager.ts`.
- Temporary server-side agent loop in `server/services/simpleJuniorAgent.ts`.
- Static HTML publishing in `server/services/publisher.ts`.

Next major step: extract Junior's real reusable agent loop and tool registry from `SecureChatExtension`, then replace VS Code dependencies with web/server adapters. Keep the agent model connection boundary so each configured agent can use Azure OpenAI, and keep grounding providers pluggable so workspace index and Azure AI Search results can be composed per agent.
