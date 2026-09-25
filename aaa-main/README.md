# AAA — A&A Accelerator

AAA is a local-first authorization workbench derived from the Junior Web architecture and tailored to security package workflows.

## Run locally

Install dependencies once:

```powershell
npm install
```

Start the complete development workbench:

```powershell
npm run dev
```

Open `http://localhost:5173`. This command starts both the React client and the local API. Do not use `npm run dev:client` by itself unless an API is already running on port `8787`.

## Model connection

Copy `.env.example` to `.env` and set the Azure OpenAI endpoint, deployment, and API version. `.env` is loaded by the server at startup and is excluded from Git. The connection definition in `config\agent-connections.json` contains environment-variable references only.

The default connection uses `DefaultAzureCredential`. To use an API key instead, change `authMode` to `api-key` in the connection definition and set `AZURE_OPENAI_API_KEY`. `GET /api/model/status` reports only safe connection metadata, readiness, and missing environment-variable names.

`maxTokens` in the connection definition is the per-response output budget (default `16000`). Reasoning models spend part of it on reasoning, so a low value truncates large file writes; when the model hits the limit AAA reports an actionable error instead of saving a partial result.

### Endpoint and API compatibility

Deployments differ in URL style, wire protocol, and accepted parameters, so the connection definition states them explicitly:

| Setting | Values | Meaning |
| --- | --- | --- |
| `endpointKind` | `auto`, `azure-openai-legacy`, `openai-v1`, `foundry-project` | URL style. `auto` infers it: `/api/projects/` → Foundry project, `/openai/v1` → v1, otherwise legacy `/openai/deployments/...?api-version=`. |
| `api` | `auto`, `chat-completions`, `responses` | Wire protocol. `auto` uses Responses for Foundry project or `/responses` endpoints, otherwise Chat Completions. |
| `tokenParameter` | `auto`, `max_tokens`, `max_completion_tokens`, `max_output_tokens`, `omit` | Output-limit parameter. `auto` uses `max_tokens` for legacy Chat Completions, `max_completion_tokens` for v1, and `max_output_tokens` for Responses. |
| `temperature` | number or `null` | `null` omits it for models that accept only the default. |
| `reasoningEffort`, `reasoningSummary` | optional | Sent only when set (`reasoning_effort`, or `reasoning.effort`/`reasoning.summary` for Responses). |
| `adaptive` | `true` (default) or `false` | Allows bounded compatibility retries; `false` sends exactly the configured shape. |
| `stream` | `true` (default) or `false` | Requests SSE streaming. Complete JSON responses, for example from buffering gateways, are handled either way. |

An explicit `api` or `tokenParameter` is never overridden. With `auto` values and `adaptive` enabled, AAA retries up to three times, only for recognized compatibility failures: a 404 route switches API; a rejected `max_tokens`, `max_completion_tokens`, `temperature`, `tool_choice`, or reasoning parameter is swapped or omitted; and a 400 on a request that replays tool results (the second round of every skill, prompt, or file-editing run) tries the other API. Each retry is logged and the working shape is remembered until restart. Content-filter, context-length, authentication, and quota errors are never retried; their Azure error code, message, and filtered categories are shown with the API key redacted.

When moving to a new environment, run the probe after configuring `.env`:

```powershell
npm run model:probe
```

It sends three small requests for each API (plain chat, tool definitions, and a replayed tool result, which is what skills need) and prints the `api` / `tokenParameter` / `temperature` settings to pin in `config\agent-connections.json`.

Throttling (`429`), request timeouts (`408`), transient `5xx` responses, and network failures are retried up to `maxRetries` times (default `3`, maximum `10`), honoring `retry-after-ms`, `x-ms-retry-after-ms`, or `Retry-After` and otherwise backing off exponentially. Waiting stops immediately when you press **Stop**.

### Token usage and context management

Every model request reports input, cached-input, output, and reasoning tokens (Chat Completions streams request `stream_options.include_usage`; set `includeUsage` to `false`, or let adaptation drop it, for deployments that reject it). Each run stores cumulative usage, the first request's prompt size, and its peak request size. The chat shows a per-reply usage line, the composer shows a context meter, and the status bar shows session totals with the cached share. When a provider does not report usage, AAA estimates it and marks the numbers with `~`.

| Setting | Default | Meaning |
| --- | --- | --- |
| `contextWindow` | none | The deployment's context window in tokens. Required for the meter percentage, auto-compaction, and the in-run guard; set it to the model's real limit. |
| `compaction.auto` | `true` | Compact automatically before a turn when the estimated prompt crosses the threshold. |
| `compaction.threshold` | `0.8` | Fraction of `contextWindow` (0.3–0.95) that triggers compaction and tool-output trimming. |
| `compaction.summaryMaxTokens` | `min(maxTokens, 8000)` | Output budget for the summary request. |

**Compaction** summarizes earlier turns, plus any previous summary, into a structured Markdown record: goals, decisions, files changed, key facts such as control IDs, open items, and dead ends. The model then receives that summary in its system prompt, followed only by the turns after the boundary. The visible transcript is never rewritten: a divider marks the boundary and expands to show the summary. Run it manually with `/compact [what to focus on]` or by clicking the context meter. Automatic compaction runs only when `contextWindow` is set. A failed compaction leaves the conversation unchanged; for automatic runs it is reported as a status line and the turn continues.

**In-run guard:** tool results are replayed within a single run (prior turns carry only their final text), so long skill runs are what fill the window. When the next request would cross the threshold, AAA replaces the oldest tool outputs the model has already seen with a short placeholder until the estimate falls to 70% of the budget, and records a "Trimmed earlier tool output" step. Results the model has not yet seen are never trimmed. Estimates use a conservative 3.5 characters per token, calibrated against the provider's actual count from the previous request.

The backend chat route is `POST /api/projects/:projectId/sessions/:sessionId/chat/stream`. It accepts `{ content, agentId? }` and returns newline-delimited JSON events (`assistant_text`, `reasoning`, `tool_event`, `completed`, or `error`). Every stream ends with exactly one `completed` or `error` event; the client reports a dropped connection if neither arrives. Reasoning and tool steps are persisted with the assistant turn and restored as expandable chat details.

Each session also stores structured agent runs with `running`, `completed`, `failed`, or `aborted` status; start/completion timestamps; model connection ID; associated user and assistant message IDs; reasoning; tool events; changed files; partial assistant text; and a credential-safe error when applicable.

## Agent workflow harness

AAA runs a project's GitHub Copilot-style customizations the same way VS Code agent mode does, so a workflow built as agents and skills works here without code changes:

| Project file | What AAA does with it |
| --- | --- |
| `.github/agents/*.agent.md` | Selectable in the composer's agent picker. The body becomes the agent's instructions. The `tools` frontmatter is kept for VS Code compatibility but never removes tools: every enabled tool is available to every agent. |
| `.github/skills/<id>/SKILL.md` | Listed to the model by id and description. The model calls `load_skill` to read the full procedure and its bundled file list when a request matches. |
| `.github/prompts/*.prompt.md` | Runs as a slash command, for example `/build-security-package AU-2`. A prompt's `agent` frontmatter selects the agent. |
| `.vscode/mcp.json` | HTTP (Streamable HTTP) MCP servers are connected per run; their tools appear as `mcp_<server>_<tool>`. |

Type `/` in the composer (or use **Skills**) to pick a prompt or skill. `/skill-id args` asks the agent to load and follow that skill.

Built-in tools are `list_files`, `read_file`, `search_files`, `write_file`, `edit_file`, `copy_path`, `browser_capture`, and `load_skill`, all registered in `server/builtInTools.ts`; a tool added there is listed in **Project customizations**, enabled by default, and exposed to every agent. Tool availability has one control: the enable toggles in **Project customizations**. If a tool, skill, or MCP server is on, every agent gets it, including ones created after the agent; only an explicit disable removes it from the next run. Agent `tools` frontmatter does not narrow anything. An enabled MCP server whose configuration cannot be used (for example `stdio`) is reported as an agent step instead of being dropped silently. `execute` is ignored: AAA never runs commands or scripts, so skills should copy bundled template files with `copy_path` rather than calling a script. `write_file` creates missing parent folders, and `copy_path` never overwrites existing files.

The composer Agent picker is the primary agent-selection surface and links to advanced project settings. **Project customizations** shows every built-in tool, provides safe availability tests, and can test HTTP MCP connections while listing the tools they expose without returning endpoint credentials. The composer’s **Add evidence** menu attaches project-file references as explicitly untrusted context. When the selected agent inspects a reference through its project tools, that file content may be sent to the configured model provider.

MCP tool calls may pass `aaa-file:<project-relative-path>` as any string argument; AAA substitutes that file's text before calling the server, so the model can publish many Markdown files without re-typing them. Only `http` MCP servers are supported (not `stdio`); header values may use `${env:NAME}`, but `${input:...}` prompts are not supported.

A down MCP server never blocks the chat. Servers are contacted in parallel with a short connect timeout (`AAA_MCP_CONNECT_TIMEOUT_MS`, default 8 s); one that fails is shown as an "MCP server unavailable" step, logged to the server console, and the run continues with the remaining tools. A failed server is skipped without waiting for `AAA_MCP_RETRY_AFTER_MS` (default 60 s), and a successful **Test connection** in Project customizations clears that immediately. Tool calls use a longer timeout (`AAA_MCP_TOOL_TIMEOUT_MS`, default 120 s); a failed call is returned to the model as an error so it can continue.

Each run is bounded by `AAA_AGENT_MAX_ROUNDS` (default 30 model rounds), `AAA_AGENT_MAX_TOOL_CALLS` (default 120), and `AAA_AGENT_TIMEOUT_MS` (default 15 minutes). **Stop** is checked before every tool call, so queued file edits do not run after you stop a response. Some models double-escape tool arguments so a whole file arrives as one line full of literal `\n`; for Markdown, text, CSV, and YAML files AAA converts those escapes back into real line breaks before writing.

An approval gate for higher-impact actions remains on the punch list.

## Session storage

Local JSON session storage is the default when no Cosmos variables are set. Setting any of `COSMOS_DB_ENDPOINT`, `COSMOS_DB_DATABASE`, `COSMOS_DB_CHAT_CONTAINER`, `COSMOS_DB_AUTH_MODE`, or `COSMOS_DB_KEY` selects Cosmos DB; incomplete Cosmos settings are reported as not ready rather than falling back to local files. The native AAA schema uses a dedicated container partitioned by `/projectId`; `.env.example` documents the required endpoint, database, container, authentication, schema, and optional auto-create settings. AAA validates the configured partition path and surfaces configuration or service failures instead of silently falling back to a different backend.

`GET /api/storage/status` returns credential-safe readiness metadata. When using Entra authentication, the runtime identity needs Cosmos DB data-plane permissions for session operations. Database and container creation may additionally require management-plane permissions.

## Local document preview

Selecting a Markdown file renders its current draft in Preview. Saved Markdown starts in **Draft** state and must be marked **Reviewed** before the Web tab or published-preview route will render it. AAA stores a SHA-256 hash of the reviewed content in the project's local `.aaa\publication.json`; any subsequent saved edit automatically returns the document to Draft. The generated Web document runs in a sandboxed frame, uses a restrictive content security policy, and does not load external resources.

Supported BMP, GIF, JPEG, PNG, SVG, and WebP files open directly in Preview through a project-boundary-checked image route. SVG preview rejects scripts, event handlers, embedded HTML, stylesheets, external links/resources, entity declarations, and CSS URLs; the response is also sandboxed with a deny-by-default content security policy. JSON files open as formatted, readable Preview content, and malformed JSON produces an explicit parse error instead of a misleading raw preview.

The Source tab is an editor for supported text files. It tracks unsaved changes, supports `Ctrl+S` / `Cmd+S`, uses the file timestamp for optimistic concurrency, and provides create, rename, and delete controls through in-app dialogs. Saves issued by AAA for the same file are serialized and committed by atomic same-directory replacement; a concurrent stale AAA save is rejected, and the timestamp is rechecked immediately before replacement to detect external edits.

Dotfiles and dot-folders such as `.github`, `.vscode`, and `.aaa` are hidden in the Files tree by default. Use the eye button in the Files toolbar to show or hide them; the choice is remembered in the browser.

The Files tab also accepts local uploads. Select a folder to make it the Upload-button destination, drop files on a folder to import them there, or drop files on the Files pane to import them at the project root. Uploads are limited to supported document, image, and text formats up to 10 MB per file. Existing paths are never overwritten, and the backend applies the same project-root, excluded-directory, and symbolic-link protections used by the editor.

## Projects and customizations

Use the project selector in the top bar to switch authorization packages or create a managed local project. New projects are stored under `data\workspaces\` and seeded by copying everything in the project template, `templates\default-project\` (its `.github` agents, skills, and prompts, and its `.vscode\mcp.json`). If the template has no `security-package\` folder, the skeleton bundled with its `initialize-security-package` skill is copied instead. Runtime project metadata and the active selection are stored in `data\projects.json`; both locations are excluded from Git.

The bundled template is a reference example. To use your own tuned agents, skills, and MCP configuration, replace the contents of `templates\default-project\`, or set `AAA_PROJECT_TEMPLATE` to another template folder. Existing projects keep their own copies; only newly created projects use the new template.

`config\projects.json` can also register existing project folders by absolute path. A configured folder that does not exist on this machine is skipped with a warning. If no project is available at all, AAA creates a starter **Demo Project** from the template on first start.

Open **Project customizations** from the left pane to inspect and configure the selected project's Agents, Skills, MCP Servers, and built-in Tools. Agent and Skill editors update their project Markdown files, MCP editors preserve the project's `.vscode\mcp.json` configuration, and capability availability is persisted in the project's hidden `.aaa\customizations.json` file. Built-in Tool definitions remain protected while their project availability can be changed. Instructions and Hooks are visible as disabled **Coming soon** surfaces.

## Microsoft Edge evidence capture

The Web tab can launch an installed Microsoft Edge through `playwright-core`. Edge is visible by default so the user can complete interactive authentication; **Headless** is optional. Each project gets a persistent browser profile under `data\browser-profiles\<project-id>\`, outside the assessed package. The Web tab shows session state, navigation and capture controls, and the most recent capture rather than embedding authenticated external sites.

Navigation accepts user-entered absolute HTTP and HTTPS addresses and rejects other schemes. Captures are PNG files under `evidence\screenshots\` by default. To avoid unwieldy long-page images, a capture always starts at the top of the page and is capped at two viewport heights. Every PNG has an adjacent JSON provenance record containing the source URL, capture time, Edge mode, viewport dimensions, captured height, and screenshot path. The `capture-web-evidence` skill guides the model, while the deterministic `browser_capture` tool owns launch, navigation, capture, and close behavior.

AAA uses Edge channel `msedge` by default. Set `AAA_EDGE_CHANNEL` to another installed Playwright channel, or set `AAA_EDGE_EXECUTABLE_PATH` to the approved Edge executable. The latter takes precedence. Browser profiles can contain authenticated session state and must be protected and handled according to the target environment's data policy.

## Run the built application

```powershell
npm run build
npm start
```

Open `http://127.0.0.1:8787`. The single local server hosts both the built client and API.

## Air-gapped installation

Dependencies are pinned by `package-lock.json`. On a connected staging machine with the same Node.js and npm versions, run `npm ci` and preserve either the resulting `node_modules` directory or npm's populated cache with the source bundle. `playwright-core` is included without a bundled Chromium download; install or stage the approved Microsoft Edge build separately. In the air-gapped environment, use the transferred `node_modules` directly or run:

```powershell
npm ci --offline
npm run build
npm start
```

`npm ci --offline` succeeds only when every package tarball referenced by the lock file is already present in the transferred npm cache. Build the cache or `node_modules` on the same OS and CPU architecture as the target, because native build tools such as `esbuild` install a platform-specific binary. The MCP client is implemented in this repository and adds no packages. Normal browser startup has been audited to request only the local AAA origin; configured model and Cosmos connections are made by the backend and remain optional for local JSON operation.

## Validate

```powershell
npm run test:server
npm run lint
npm run build
```

To check a running MCP publisher end to end, which sends every Markdown file in the bundled package template and publishes a site:

```powershell
$env:AAA_MCP_LIVE_URL = 'http://localhost:3000/mcp'
npm run test:mcp-live
```

Set `AAA_MCP_LIVE_SOURCE` to publish a different folder. Project configuration lives in `config\projects.json`; local session data is written under `data\` and is excluded from Git.
