# AAA Implementation Punch List

This list tracks the path from the visual prototype to a working local A&A demo. Work is ordered around the core user loop first. Agent, skill, and MCP configuration popovers intentionally come later.

High-side requirements are mapped to implementation commits and remaining work in [`HIGH_SIDE_FEATURE_STATUS.md`](./HIGH_SIDE_FEATURE_STATUS.md).

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
- [x] Pin Capabilities and Project customizations to the bottom of the left pane while sessions scroll independently.
- [x] Keep the chat anchored to the newest content during session loads, sends, model streaming, reasoning, and tool-step updates.
- [x] Add a stable non-wrapping `Ctrl K` session-search shortcut that focuses the search field.

## 2. Local project workspace

- [x] Add a local application server.
- [x] Discover configured A&A project directories.
- [x] Return project metadata and the active project.
- [x] Create managed authorization projects from the bundled package and customization template.
- [x] Bundle the reference project template in the repository (`templates/default-project`), replaceable with high-side agents, skills, and MCP configuration.
- [x] Skip configured project roots that do not exist on this machine and create a starter project when none remain.
- [x] Switch projects from the top bar and persist the active selection across restarts.
- [x] Delete AAA-managed projects with confirmation while protecting configured roots and the final project.
- [x] Keep runtime-created projects under ignored local data without rewriting tracked seed configuration.
- [x] Enforce project-root path boundaries for every file operation.
- [x] Persist local application data outside the assessed project files; per-project review and customization state lives in the project's `.aaa/` folder.

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
- [x] Stop an active response, including before any queued tool call runs.
- [x] Run a bounded model-driven agent loop with safe project file list, read, create, replace, and targeted edit tools.
- [x] Bound each run by rounds, tool calls, and wall-clock time with actionable limit errors.
- [x] Load project agents, skills, prompts, and HTTP MCP servers into the harness the same way VS Code agent mode does.
- [x] Refresh the workflow and serialize capability toggles so MCP servers are added to or removed from the next agent run immediately.
- [x] Add search, template copy, and load-skill tools; create missing parent folders on agent writes.
- [x] Connect HTTP MCP servers from `.vscode/mcp.json` with `aaa-file:` references for sending project files.
- [x] Repair double-escaped newlines in model-written Markdown and report output-token truncation instead of saving partial files.
- [x] Detect chat streams that end without a terminal event.
- [x] Refresh the artifact tree and selected file after agent-driven file changes.
- [ ] Add review/approval policy for higher-impact agent actions before expanding beyond project file tools.
- [x] Show actionable errors rather than success-shaped fallback responses.
- [x] Support explicit `api`, `tokenParameter`, temperature, reasoning, and streaming settings with bounded, logged compatibility adaptation across Chat Completions and Responses.
- [x] Add `npm run model:probe` to verify plain chat, tool definitions, and tool-result replay per API and recommend settings for a new environment.
- [x] Add a Model connection diagnostics panel (resolved settings, per-API URLs, check timings, errors, adaptation, copyable recommendation) and list MCP tool parameters in connection tests.
- [x] Retry 429, 408, transient 5xx, and network failures with `Retry-After`-aware, abortable backoff.
- [x] Track input, cached-input, output, and reasoning tokens per request, run, and session, with live usage in the chat, status-bar totals, and a compact session-info/context popover with a manual compaction action.
- [x] Add `/compact [focus]` and automatic threshold-based compaction that keeps the visible transcript and stores structured summaries per session.
- [x] Trim the oldest already-seen tool outputs inside long runs before they overflow the configured context window.
- [ ] Add optional per-deployment pricing (per 1M input, cached-input, and output tokens) to show estimated run and session cost.
- [ ] Send an opt-in `prompt_cache_key` (for example the session id) to improve cache routing where supported.
- [ ] Summarize large tool outputs instead of removing them, and allow reverting the latest compaction.
- [ ] Add per-project or per-session token budgets with warnings before a run starts.
- [ ] Export run usage and timing as OpenTelemetry GenAI spans for Application Insights or an offline collector.
- [x] Keep the model/provider boundary replaceable for an air-gapped runtime.

**Acceptance criteria:** A restored session displays the complete conversation, reasoning, and agent steps; new messages stream without losing history; and a user can ask the agent to inspect or change a project file and see the persisted result in Artifacts.

## 5. Real project files

- [x] Build a real file tree from the selected project directory.
- [x] Expand and collapse directories.
- [x] Refresh the tree.
- [x] Open text, Markdown, formatted JSON, supported raster images, and safety-checked SVG files.
- [x] Render selected Markdown in Preview.
- [x] Show selected text files in Source.
- [x] Add safe file create, rename, save, and delete operations.
- [x] Upload one or more local files into the project root or a selected folder.
- [x] Include an evidence directory in managed projects and default root-level image uploads to `evidence/screenshots/`.
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

## 6a. Browser evidence and generated diagrams

- [x] Add project-scoped persistent Playwright sessions that launch installed Microsoft Edge visibly by default.
- [x] Add optional headless mode and explicit Edge channel/executable configuration.
- [x] Add Web-tab launch, navigation, capture, close, status, and recent-capture controls.
- [x] Add an action beside HTTP(S) links in rendered Markdown that opens Edge, navigates to the target, and prefills a screenshot-evidence path without auto-capturing.
- [x] Inspect visible fields in the active Edge page, fill user-reviewed values, and attach validated project artifacts without auto-submitting forms.
- [x] Restrict navigation to user-entered absolute HTTP and HTTPS addresses.
- [x] Save top-of-page PNG captures capped at two viewport heights, with adjacent JSON source URL, timestamp, browser-mode, viewport, and capture metadata.
- [x] Expose deterministic browser operations to agents through `browser_capture` and a reference capture skill.
- [x] Add a grounded architecture/CONOPS SVG-generation skill.
- [x] Preview SVG only after rejecting active content and external resources.
- [x] Fix formatted identity/JSON preview and dark-mode text contrast in chat, editor, and preview surfaces.
- [ ] Build a dynamic interactive architecture diagram from cloud-scan output using the selected React component (explicitly deferred until after the portable demo move).

**Acceptance criteria:** A user can authenticate in visible Edge, navigate to an HTTP(S) page, save screenshot evidence with provenance, and preview generated safe SVG and JSON artifacts without leaving AAA.

## 7. Security-package workflow

- [ ] Detect package configuration and expected folder structure.
- [ ] Surface control families, control responses, evidence, and validation status.
- [x] Wire package initialization to the offline skill by copying its bundled template (no script execution).
- [~] Show structured progress for analyze and validate workflows (agent steps are shown; no dedicated package view yet).
- [x] Publish package Markdown through the configured MCP publisher.
- [ ] Preserve the human-review and publication boundary.

**Acceptance criteria:** A user can initialize, inspect, build, and validate the demo package while retaining traceable local evidence.

## 8. VS Code-style capability popovers

- [x] Add a dismissible VS Code-inspired project customization window.
- [x] Discover project agents, skills, MCP servers, instructions, and built-in tools.
- [x] Add friendly category navigation, counts, search, status, and enable toggles.
- [x] Persist enabled/disabled customization choices per project and apply them to the agent's tool surface.
- [x] Add friendly create/edit forms for agents, skills, MCP servers, and built-in tool availability.
- [x] Configure project agents to delegate chat to environment-referenced Microsoft Foundry Responses endpoints with Entra or API-key authentication.
- [x] Store agent and skill changes in project Markdown and MCP changes in `.vscode/mcp.json`.
- [x] Keep Hooks visibly disabled as a coming-soon capability until execution and approval policy is implemented.
- [~] Add friendly create/edit forms for Instructions and Hooks (Instructions done: `copilot-instructions.md` and `*.instructions.md` with `applyTo` are discovered, toggleable, editable, and injected into runs; prompt files are toggleable and editable; Hooks remain coming soon).
- [x] Test MCP server connections without exposing endpoint credentials.
- [x] Replace permanent capability navigation with a compact Agent picker.
- [x] Add Skills as a searchable composer popover (`/` prompts and skills).
- [x] Add MCP servers and tools as status/configuration popovers.
- [x] Add an evidence/context attachment popover.
- [x] Keep advanced editing behind secondary configuration views.

**Acceptance criteria:** Agents, skills, MCP servers, tools, and evidence can be selected without navigating away from the conversation.

## 9. Reliability and offline packaging

- [x] Add a hidden-files toggle to the Files tree.
- [x] Add focused API and persistence tests.
- [x] Add path-boundary and invalid-input tests.
- [x] Keep project-partitioned JSON session storage as the default local and air-gap backend.
- [x] Add optional native `/projectId` Cosmos DB session storage with Entra or API-key authentication and an explicit Junior-compatible schema mode.
- [x] Validate the configured Cosmos partition schema and optionally create a dedicated AAA database/container when explicitly enabled.
- [x] Surface configured Cosmos failures without silently falling back to local session files.
- [x] Add a credential-safe storage readiness endpoint for session and workspace-file backends.
- [x] Report Junior-compatible blob settings as configured/ready but inactive until project-file storage is abstracted.
- [x] Add optional, project-scoped Git synchronization as a separate alternative to cloud workspace-file storage, with explicit status, pull, and commit/push actions, project-root repository isolation, and no stored Git credentials or automatic background sync.
- [x] Add browser tests for the core project/session/chat/file flow (Edge-driven tests for first-prompt streaming, Files-tree deletion, the sign-in gate, and the full create → initialize → build → publish workflow; skipped without a client build or Edge).
- [x] Verify light and dark visual contrast for the project and customization milestone.
- [x] Verify a normal browser reload makes no unintended external runtime requests.
- [x] Produce pinned dependency and offline installation guidance.

**Acceptance criteria:** Build, lint, tests, and core browser flow pass; the runtime is demonstrably local-first.

### Storage slice provenance and deliberate omissions

Adapted from these Junior Web source files (paths are in the Junior Web repository, not this one):

- `server/services/chatSessionStore.ts`
- `server/services/localChatSessionStore.ts`
- `server/services/cosmosChatSessionStore.ts`
- `server/services/cosmosContainerFactory.ts`
- `server/services/persistenceFactories.ts`
- `server/services/workspaceStorageFactory.ts`
- `server/test/persistenceFactories.test.ts`
- `server/test/workspaceStorageFactory.test.ts`

The AAA implementations live in `server/chatSessionStore.ts`, `server/sessionStore.ts`, `server/cosmosChatSessionStore.ts`, `server/cosmosContainerFactory.ts`, `server/sessionStoreFactory.ts`, and `server/storageConfig.ts`, with tests in `server/test/`.

Deliberately omitted Junior Web's chat-session fallback wrapper because an explicitly configured Cosmos backend must fail visibly rather than write to a divergent local store. Blob workspace storage and its fallback/cache implementation are also not ported: AAA only validates and reports the compatible `JUNIOR_WORKSPACE_*` configuration until project-file storage has its own abstraction. Azure provisioning, deployment scripts, and live-service tests remain out of scope.

The current connected demo environment has dedicated `AaaChat` / `AaaChatSessions` resources with `/projectId` partitioning. A live create, read, list, and delete cycle has been verified through the AAA API.

### Agent-loop provenance

The reasoning display, model tool-call loop, bounded execution, workspace tools, and persisted agent-step metadata are adapted from Junior Web's `JuniorAgentLoop`, `JuniorAgentPlanner`, `workspaceTools`, streaming API route, and message display parts. `server/projectWorkflowService.ts` adds VS Code-compatible agent, skill, prompt, and MCP loading; `server/services/mcpHttpClient.ts` is a minimal in-repo Streamable HTTP MCP client, so no MCP SDK dependency is required. All tools stay project-root constrained, and the harness never executes commands or scripts.

## 10. Deferred review items

Findings from the air-gap code review that are intentionally postponed. Items already fixed are listed in sections 4, 8, and 9.

Security

- [x] Add authentication, per-project authorization, and CSRF/origin protections before binding beyond `127.0.0.1` (optional Entra sign-in, GET-only SameSite=Strict session cookie, non-loopback protection, external ACL state, filtered project listings, and project-route enforcement).
- [x] Protect `.aaa/` review and customization state from agent writes (write, edit, copy, download, and delete tools refuse `.aaa/` and `.git/`).
- [ ] Add an approval gate for consequential agent edits and treat tool results as untrusted in policy, not only in the prompt.
- [x] Validate uploaded file signatures, not just extensions, before preview or evidence use (uploads, downloads, MCP files, and captures must match their extension's magic bytes or be valid UTF-8 text).
- [x] Render the published Web preview from the exact bytes that were hash-verified (read once, then verified and rendered).

Correctness

- [x] Make Source-editor saves atomic for concurrent AAA requests (same-file saves are serialized, stale versions are rejected, and commits replace through a same-directory temporary file).
- [x] Add concurrency tests for simultaneous saves and review marking (concurrent reviews previously lost updates; publication state is now serialized and written atomically).

Packaging and offline install

- [x] Pin Node.js and npm versions (`engines` `>=22.12.0 <25` / npm `>=10`, `.nvmrc` 24.15.0, and `.npmrc` `engine-strict=true`).
- [x] Move `vite` and `@vitejs/plugin-react` to `devDependencies` and document staging versus runtime installs (`npm ci --omit=dev` runtime install verified to serve the API and built client).
- [~] Rehearse an offline install on the target OS/architecture, including `esbuild`'s platform binary (rehearsed on Windows x64 with `npm ci --offline` from the local cache; repeat on the target machine).
- [ ] Review tracked screenshots and stray files (`image.png`, `aaa-desktop.png`, `aaa-desktop-snapshot.yml`, `aaa-logo-update.png`, `background`) before transfer.

Performance

- [ ] Remove the Cosmos DB 2 MB item-size ceiling on chat sessions (future issue). Each session is one document holding every message and run, so long sessions eventually fail to save. Slimming completed runs roughly halved per-turn growth (about 75 → 150 turns before the limit at typical tool and reasoning output), but the real fix is to store messages and runs as separate items in the session's partition, with a summary/header document, and to keep Junior-compatible mode and legacy documents readable. Also surface a clear error if a save is rejected for size (HTTP 413).
- [ ] Keep very long chats fast. Messages are now memoized, but every message is still mounted and `GET session` returns the full history. Page or virtualize the message list (load the latest N messages and fetch earlier ones on scroll), return only the recent messages plus precomputed usage totals from the server, and evaluate `content-visibility: auto` on message groups without breaking scroll-to-bottom anchoring.

MCP and harness

- [x] Support `stdio` MCP servers and `${input:...}` values, or keep them clearly marked unsupported (kept unsupported because AAA never launches processes; enabled servers that use them are reported as an agent step with the reason instead of being dropped).
- [x] Add an MCP connection test in Project customizations.
- [x] Add MCP authentication (none, bearer, API key header, OAuth client credentials, Microsoft Entra) with env-referenced secrets, masking, token caching, and 401 refresh.
- [x] Save files embedded in MCP results, surface resource links, and add a `download_file` tool for MCP resource URIs and MCP-host (or allow-listed) HTTP files and JSON.
- [x] Delete files and folders from the Files tree, and add a `delete_path` agent tool that protects AAA state and customization folders.
- [x] Add structured, redacted console logging for key failures (startup, runs, model, MCP, tools, compaction, storage, API routes, process) with `AAA_LOG_LEVEL`/`AAA_LOG_FORMAT`, plus browser-console API failure logging.
- [x] Add optional Microsoft Entra sign-in for the web app (`AAA_AUTH_MODE=entra`, off by default) with token validation, app-role checks, sovereign-cloud authority, and run attribution.
- [x] Add a browser end-to-end test for create project → `/initialize-security-package` → `/build-security-package` → publish (`server/test/e2eWorkflow.test.ts`, scripted model and fake MCP publisher).

## 11. Guided assessment workflow and scan-first intake

Captured from low-side planning notes ahead of the high-side move. This section sequences the
authorization workflow (cloud scan → standard documents → architecture diagrams → control-set
responses) and the supporting capabilities that make it demonstrable low side. It extends the
Priority 1 "Guided multi-stage agent workflows" item in [`HIGH_SIDE_FEATURE_STATUS.md`](./HIGH_SIDE_FEATURE_STATUS.md).

**Target workflow order:** Scan → Docs (Markdown/CSV canonical) → Architecture diagrams → Control-set responses → POA&M projection.

- [ ] **(R-A) Guided multi-stage workflow engine.** Add persisted workflow state with ordered stages (scan, standard docs, architecture, control responses), prerequisites, stage gates, checkpoints, and resume semantics. The agent must understand it is guiding the user through this sequence rather than free-form chat. *(Next up.)*
- [ ] **(R-B) Interactive question/answer elicitation.** Let an agent pause mid-workflow to present numbered options (1 / 2 / 3 / provide another answer), capture the choice, and continue. Must be occasional and context-driven, not every turn. *(Next up; companion to R-A.)*
- [ ] **(R-D) Canonical Markdown/CSV document templates.** Build the standard assessment documents as Markdown and CSV first so the target structure is explicit before any Office rendering. These feed the Office automation MCP as canonical sources (see the [Office document automation decision](./docs/office-document-automation.md)).
- [ ] **(R-E) Cloud-scan MCP intake — highest priority.** First workflow stage. Add harness-side support to call a cloud-scan MCP server, ingest its findings as project evidence/JSON, and drive the rest of the workflow from them. The real scan server is high-side and requirement-driven; low side, build the client path plus a fake-scan MCP fixture for tests. *(Blocked on high-side server for live validation; buildable and testable low side now.)*
- [ ] **(R-I) Low-side NIST demo.** Build a self-contained low-side demo project/template that walks the full workflow using the public NIST control set, intentionally incongruent with the high-side package, to show the end-to-end approach without high-side services. Exercises R-A, R-B, and R-D.
- [ ] **(R-H) Assessment rationale and POA&M projection.** After control responses, generate how each control was assessed and the likely POA&Ms (plan of action and milestones). *(Later; depends on R-A control-response output.)*
- [~] **(R-F) Publisher MCP hardening.** The HTTP MCP publisher integration exists (section 7); lower priority, still needs environment-specific work and a live smoke test (`AAA_MCP_LIVE_URL`).
- [ ] **(R-G) Office document transformation/creation MCP.** Word/Excel creation stays in a separate local MCP server per the accepted [Office document automation decision](./docs/office-document-automation.md); AAA consumes it through the authenticated MCP/file pipeline.
- [~] **(R-J) Optional Microsoft Foundry Agent Service runtime.** Implemented low side with the official `@azure/ai-projects` SDK: agent setup can opt into a project endpoint plus agent name, and AAA invokes the active prompt or Responses-compatible hosted agent through the Agent Service agent-reference contract with Entra authentication. The existing direct Responses endpoint and local `AaaAgentLoop` paths remain unchanged. Deterministic tests cover configuration, SDK routing/auth/body shape, text and usage normalization, cancellation, sanitized errors, persisted run events, and operation without a local model connection. Keep it experimental until a real target/high-side agent passes authentication, multi-turn, streaming/event normalization, and persisted-run parity smoke tests.

### Current decision: preserve the harness contract; do not adopt Semantic Kernel yet

AAA currently uses the TypeScript `AaaAgentLoop`, adapted from Junior Web's `JuniorAgentLoop`, as a
bounded model/tool loop. The important compatibility surface is not the loop implementation itself:
it is the existing model-client contract, VS Code/GitHub Copilot-compatible agents, skills, prompts,
and instructions, enabled-tool behavior, MCP routing, NDJSON progress events, session/run records,
usage accounting, cancellation, compaction, and changed-file reporting. Any orchestration runtime
must preserve those observable contracts so AAA continues to behave like Junior and the GitHub
Copilot workflow it is modeled after.

**Decision as of 2026-10-01:** implement R-A and R-B as explicit TypeScript workflow state around
the current loop. Do not replace the loop with Semantic Kernel now. This is a compatibility and
delivery decision, not an attack-surface decision.

#### Semantic Kernel benefits

- Standard model connectors, function/plugin registration, filters/hooks, telemetry, and automatic
	function calling could remove some custom infrastructure.
- Sequential, concurrent, handoff, group-chat, and Magentic orchestration patterns could help if AAA
	later coordinates several specialized agents.
- The Process Framework's event-driven steps, auditability, and reusable processes resemble the
	planned assessment stages.
- A framework may reduce future bespoke work for agent handoff, provider adapters, and observability.

#### Semantic Kernel costs and compatibility risks

- Official Semantic Kernel SDKs support C#, Python, and Java, not TypeScript/Node. AAA would need a
	sidecar or a server rewrite, adding a cross-process protocol and splitting cancellation, streaming,
	credentials, logs, deployment, debugging, and persisted state across runtimes.
- Semantic Kernel Agent Orchestration and Process Framework features relevant to R-A/R-B are marked
	experimental. Adopting them would exchange stable local code for APIs expected to change.
- Microsoft identifies Microsoft Agent Framework as the direct successor to Semantic Kernel and
	publishes an SK migration guide. A new SK integration would likely incur another migration.
- SK does not natively understand AAA's `.github` agents/skills/prompts/instructions, capability
	toggles, `aaa-file:` MCP behavior, protected project writes, browser events, review boundary, or
	session schema. Adapters would still be required, so it does not replace most AAA-specific code.
- Replacing the loop could alter tool-call ordering, parallelism, tool-error recovery, streaming
	event timing, context trimming, usage totals, or enabled-tool semantics and thereby diverge from
	Junior/Copilot behavior.

#### Microsoft Agent Framework implication

Microsoft Agent Framework is the more appropriate framework to evaluate for new Microsoft-based
orchestration because it succeeds SK and includes graph workflows, human-in-the-loop pause/resume,
checkpoints, telemetry, MCP support, and a harness agent. It currently supports .NET and Python,
with Go support emerging, but still has no official TypeScript SDK. It therefore has the same
sidecar/rewrite problem for AAA today.

#### Evaluation path and guardrails

1. Keep `AaaAgentLoop` as the production runtime while implementing the scan → docs → diagrams →
	 controls workflow as a deterministic persisted state machine. This workflow needs explicit order
	 and checkpoints more than multi-agent autonomy.
2. Extract an internal runtime interface only when a second implementation is ready; avoid adding
	 an abstraction with one implementation solely in anticipation of a framework.
3. If framework evaluation resumes, spike Microsoft Agent Framework before SK in an isolated
	 sidecar. Run the same scripted model/tool scenarios against both runtimes.
4. Require parity for streaming text/reasoning/events, cancellation, tool availability and ordering,
	 MCP failure continuation, file protections, context/usage accounting, persisted run shape, and
	 deterministic resume before allowing the optional runtime into a real workflow.
5. Keep the current runtime available as a fallback until the alternate runtime passes the complete
	 compatibility suite and demonstrates a measured reduction in code or operational complexity.

**Revisit when:** AAA requires genuine multi-agent handoff/concurrency, the custom workflow engine
becomes materially difficult to maintain, an official TypeScript SDK becomes available, or a
framework sidecar demonstrates enough checkpointing/observability value to justify its operational
cost. Framework adoption is not required for R-A or R-B.
