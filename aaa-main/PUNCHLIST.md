# AAA Implementation Punch List

This list tracks the path from the visual prototype to a working local A&A demo. Work is ordered around the core user loop first. Agent, skill, and MCP configuration popovers intentionally come later.

## Status key

- `[x]` Complete
- `[~]` In progress
- `[ ]` Not started

## 1. Product shell and visual foundation

- [x] Build the React, Vite, and TypeScript application shell.
- [x] Add AAA / A&A Accelerator branding.
- [x] Add resizable session, chat, and artifact panes.
- [x] Add light and dark themes with local preference persistence.
- [x] Add Files, Preview, Source, and Web artifact tabs.
- [x] Add desktop and compact responsive layouts.
- [x] Keep the chat anchored to the newest content during session loads, sends, model streaming, reasoning, and tool-step updates.
- [x] Add a stable non-wrapping `Ctrl K` session-search shortcut that focuses the search field.

## 2. Local project workspace

- [x] Add a local application server.
- [x] Discover configured A&A project directories.
- [x] Return project metadata and the active project.
- [x] Create managed authorization projects from the bundled package and customization template.
- [x] Switch projects from the top bar and persist the active selection across restarts.
- [x] Keep runtime-created projects under ignored local data without rewriting tracked seed configuration.
- [x] Enforce project-root path boundaries for every file operation.
- [x] Persist local application data outside the assessed project files.

**Acceptance criteria:** AAA starts locally with one command, can create and switch persistent projects, and cannot read outside an allowed project root.

## 3. Project-specific sessions

- [x] List chat sessions for the selected project.
- [x] Create, rename, and delete sessions.
- [x] Persist session titles, timestamps, messages, and active project.
- [x] Restore session history after restarting the application.
- [x] Generate a useful default session title from the first user message.

**Acceptance criteria:** Sessions belong to one project, survive a restart, and can be managed from the left pane.

## 4. Functional chat

- [x] Send and persist user messages.
- [x] Add environment-backed model configuration and a credential-safe readiness endpoint.
- [x] Add a provider-neutral model client boundary with Azure OpenAI as the first adapter.
- [x] Add abort-aware NDJSON streaming on the project/session backend.
- [x] Persist assistant messages and structured run events with running, completed, failed, and aborted lifecycle states.
- [x] Stream assistant output to the UI.
- [x] Render Junior Web-style live and persisted reasoning and agent-step boxes.
- [x] Stop an active response.
- [x] Run a bounded model-driven agent loop with safe project file list, read, create, replace, and targeted edit tools.
- [x] Refresh the artifact tree and selected file after agent-driven file changes.
- [ ] Add review/approval policy for higher-impact agent actions before expanding beyond project file tools.
- [x] Show actionable errors rather than success-shaped fallback responses.
- [x] Keep the model/provider boundary replaceable for an air-gapped runtime.

**Acceptance criteria:** A restored session displays the complete conversation, reasoning, and agent steps; new messages stream without losing history; and a user can ask the agent to inspect or change a project file and see the persisted result in Artifacts.

## 5. Real project files

- [x] Build a real file tree from the selected project directory.
- [x] Expand and collapse directories.
- [x] Refresh the tree.
- [x] Open text, Markdown, JSON, and supported raster image files.
- [x] Render selected Markdown in Preview.
- [x] Show selected text files in Source.
- [x] Add safe file create, rename, save, and delete operations.
- [x] Upload one or more local files into the project root or a selected folder.
- [x] Drag local files onto the Files pane or a folder while preserving project boundaries.
- [x] Reject duplicate names, excluded paths, unsupported types, and files larger than 10 MB.
- [x] Add an editable Source view with `Ctrl S` / `Cmd S` save and optimistic concurrency.
- [x] Add create, rename, and delete controls with in-app confirmation dialogs.
- [x] Indicate unsaved changes, protect navigation, and surface file-operation failures and conflicts.

**Acceptance criteria:** The right pane reflects files on disk, previews real content, and blocks traversal outside the project.

## 6. Published Web preview

- [x] Serve reviewed Markdown through a local preview route.
- [x] Display the selected Markdown document in the Web tab through the local preview route.
- [x] Keep navigation local and air-gap compatible.
- [x] Distinguish draft preview from reviewed/published output using exact-content review hashes.

**Acceptance criteria:** A selected Markdown file has a locally served browser-style view without an external network dependency.

## 7. Security-package workflow

- [ ] Detect package configuration and expected folder structure.
- [ ] Surface control families, control responses, evidence, and validation status.
- [ ] Wire package initialization to the existing offline skill/script.
- [ ] Show structured progress for analyze and validate workflows.
- [ ] Preserve the human-review and publication boundary.

**Acceptance criteria:** A user can initialize, inspect, build, and validate the demo package while retaining traceable local evidence.

## 8. VS Code-style capability popovers

- [x] Add a dismissible VS Code-inspired project customization window.
- [x] Discover project agents, skills, MCP servers, instructions, and built-in tools.
- [x] Add friendly category navigation, counts, search, status, and enable toggles.
- [x] Persist enabled/disabled customization choices per project.
- [x] Add friendly create/edit forms for agents, skills, MCP servers, and built-in tool availability.
- [x] Store agent and skill changes in project Markdown and MCP changes in `.vscode/mcp.json`.
- [x] Mark Instructions and Hooks as disabled coming-soon capabilities.
- [ ] Add friendly create/edit forms for Instructions and Hooks.
- [ ] Test MCP server connections without exposing endpoint credentials.
- [ ] Replace permanent capability navigation with a compact Agent picker.
- [ ] Add Skills as a searchable composer popover.
- [ ] Add MCP servers and tools as status/configuration popovers.
- [ ] Add an evidence/context attachment popover.
- [ ] Keep advanced editing behind secondary configuration views.

**Acceptance criteria:** Agents, skills, MCP servers, tools, and evidence can be selected without navigating away from the conversation.

## 9. Reliability and offline packaging

- [x] Add focused API and persistence tests.
- [x] Add path-boundary and invalid-input tests.
- [x] Keep project-partitioned JSON session storage as the default local and air-gap backend.
- [x] Add optional native `/projectId` Cosmos DB session storage with Entra or API-key authentication and an explicit Junior-compatible schema mode.
- [x] Validate the configured Cosmos partition schema and optionally create a dedicated AAA database/container when explicitly enabled.
- [x] Surface configured Cosmos failures without silently falling back to local session files.
- [x] Add a credential-safe storage readiness endpoint for session and workspace-file backends.
- [x] Report Junior-compatible blob settings as configured/ready but inactive until project-file storage is abstracted.
- [~] Add browser tests for the core project/session/chat/file flow.
- [x] Verify light and dark visual contrast for the project and customization milestone.
- [x] Verify a normal browser reload makes no unintended external runtime requests.
- [x] Produce pinned dependency and offline installation guidance.

**Acceptance criteria:** Build, lint, tests, and core browser flow pass; the runtime is demonstrably local-first.

### Storage slice provenance and deliberate omissions

Adapted from Junior Web:

- `server/services/chatSessionStore.ts`
- `server/services/localChatSessionStore.ts`
- `server/services/cosmosChatSessionStore.ts`
- `server/services/cosmosContainerFactory.ts`
- `server/services/persistenceFactories.ts`
- `server/services/workspaceStorageFactory.ts`
- `server/test/persistenceFactories.test.ts`
- `server/test/workspaceStorageFactory.test.ts`

Deliberately omitted Junior Web's chat-session fallback wrapper because an explicitly configured Cosmos backend must fail visibly rather than write to a divergent local store. Blob workspace storage and its fallback/cache implementation are also not ported: AAA only validates and reports the compatible `JUNIOR_WORKSPACE_*` configuration until project-file storage has its own abstraction. Azure provisioning, deployment scripts, and live-service tests remain out of scope.

The current connected demo environment has dedicated `AaaChat` / `AaaChatSessions` resources with `/projectId` partitioning. A live create, read, list, and delete cycle has been verified through the AAA API.

### Agent-loop provenance

The reasoning display, model tool-call loop, bounded execution, workspace tools, and persisted agent-step metadata are being adapted from Junior Web's `JuniorAgentLoop`, `JuniorAgentPlanner`, `workspaceTools`, streaming API route, and message display parts. AAA keeps the first tool surface intentionally narrow and project-root constrained before adding skills, MCP, cloud evidence, or package workflow actions.
