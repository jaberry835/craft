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

## 2. Local project workspace

- [x] Add a local application server.
- [x] Discover configured A&A project directories.
- [x] Return project metadata and the active project.
- [x] Enforce project-root path boundaries for every file operation.
- [x] Persist local application data outside the assessed project files.

**Acceptance criteria:** AAA starts locally with one command, lists configured projects, and cannot read outside an allowed project root.

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
- [~] Persist assistant messages and structured run events.
- [ ] Stream assistant output to the UI.
- [ ] Stop an active response.
- [x] Show actionable errors rather than success-shaped fallback responses.
- [x] Keep the model/provider boundary replaceable for an air-gapped runtime.

**Acceptance criteria:** A restored session displays the complete conversation, and new messages stream without losing history.

## 5. Real project files

- [x] Build a real file tree from the selected project directory.
- [x] Expand and collapse directories.
- [x] Refresh the tree.
- [~] Open text, Markdown, JSON, and supported image files.
- [x] Render selected Markdown in Preview.
- [x] Show selected text files in Source.
- [x] Add safe file create, rename, save, and delete operations.
- [ ] Indicate unsaved changes and file-operation failures.

**Acceptance criteria:** The right pane reflects files on disk, previews real content, and blocks traversal outside the project.

## 6. Published Web preview

- [x] Serve reviewed Markdown through a local preview route.
- [ ] Display the selected document in the Web tab.
- [x] Keep navigation local and air-gap compatible.
- [ ] Distinguish draft preview from reviewed/published output.

**Acceptance criteria:** A selected Markdown file has a locally served browser-style view without an external network dependency.

## 7. Security-package workflow

- [ ] Detect package configuration and expected folder structure.
- [ ] Surface control families, control responses, evidence, and validation status.
- [ ] Wire package initialization to the existing offline skill/script.
- [ ] Show structured progress for analyze and validate workflows.
- [ ] Preserve the human-review and publication boundary.

**Acceptance criteria:** A user can initialize, inspect, build, and validate the demo package while retaining traceable local evidence.

## 8. VS Code-style capability popovers

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
- [x] Add optional project-partitioned Cosmos DB session storage with Entra or API-key authentication.
- [x] Surface configured Cosmos failures without silently falling back to local session files.
- [x] Add a credential-safe storage readiness endpoint for session and workspace-file backends.
- [x] Report Junior-compatible blob settings as configured/ready but inactive until project-file storage is abstracted.
- [ ] Add browser tests for the core project/session/chat/file flow.
- [ ] Verify light and dark visual contrast.
- [ ] Verify no unintended external runtime requests.
- [~] Produce pinned dependency and offline installation guidance.

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
