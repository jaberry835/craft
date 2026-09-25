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

The backend chat route is `POST /api/projects/:projectId/sessions/:sessionId/chat/stream`. It accepts `{ content, agentId? }` and returns newline-delimited JSON events (`assistant_text`, `reasoning`, `tool_event`, `completed`, or `error`). Every stream ends with exactly one `completed` or `error` event; the client reports a dropped connection if neither arrives. Reasoning and tool steps are persisted with the assistant turn and restored as expandable chat details.

Each session also stores structured agent runs with `running`, `completed`, `failed`, or `aborted` status; start/completion timestamps; model connection ID; associated user and assistant message IDs; reasoning; tool events; changed files; partial assistant text; and a credential-safe error when applicable.

## Agent workflow harness

AAA runs a project's GitHub Copilot-style customizations the same way VS Code agent mode does, so a workflow built as agents and skills works here without code changes:

| Project file | What AAA does with it |
| --- | --- |
| `.github/agents/*.agent.md` | Selectable in the composer's agent picker. The body becomes the agent's instructions; the `tools` frontmatter limits which tools it gets. |
| `.github/skills/<id>/SKILL.md` | Listed to the model by id and description. The model calls `load_skill` to read the full procedure and its bundled file list when a request matches. |
| `.github/prompts/*.prompt.md` | Runs as a slash command, for example `/build-security-package AU-2`. A prompt's `agent` frontmatter selects the agent. |
| `.vscode/mcp.json` | HTTP (Streamable HTTP) MCP servers are connected per run; their tools appear as `mcp_<server>_<tool>`. |

Type `/` in the composer (or use **Skills**) to pick a prompt or skill. `/skill-id args` asks the agent to load and follow that skill.

Built-in tools are `list_files`, `read_file`, `search_files`, `write_file`, `edit_file`, `copy_path`, `browser_capture`, and `load_skill`. Agent `tools` tokens map as follows: `read` → list/read, `search` → list/search, `edit` → write/edit/copy, `browser` or `screenshot` → Edge evidence capture, and `<server>/*` or `<server>/<tool>` → optional MCP tool narrowing. Every enabled, available project MCP server is exposed automatically, including servers added after an agent was created; disabling an MCP server in **Project customizations** removes it from the next run. `execute` is ignored: AAA never runs commands or scripts, so skills should copy bundled template files with `copy_path` rather than calling a script. `write_file` creates missing parent folders, and `copy_path` never overwrites existing files. Disabling an agent, skill, or built-in tool also removes it from the next run.

MCP tool calls may pass `aaa-file:<project-relative-path>` as any string argument; AAA substitutes that file's text before calling the server, so the model can publish many Markdown files without re-typing them. Only `http` MCP servers are supported (not `stdio`); header values may use `${env:NAME}`, but `${input:...}` prompts are not supported.

Each run is bounded by `AAA_AGENT_MAX_ROUNDS` (default 30 model rounds), `AAA_AGENT_MAX_TOOL_CALLS` (default 120), and `AAA_AGENT_TIMEOUT_MS` (default 15 minutes). **Stop** is checked before every tool call, so queued file edits do not run after you stop a response. Some models double-escape tool arguments so a whole file arrives as one line full of literal `\n`; for Markdown, text, CSV, and YAML files AAA converts those escapes back into real line breaks before writing.

An approval gate for higher-impact actions remains on the punch list.

## Session storage

Local JSON session storage is the default when no Cosmos variables are set. Setting any of `COSMOS_DB_ENDPOINT`, `COSMOS_DB_DATABASE`, `COSMOS_DB_CHAT_CONTAINER`, `COSMOS_DB_AUTH_MODE`, or `COSMOS_DB_KEY` selects Cosmos DB; incomplete Cosmos settings are reported as not ready rather than falling back to local files. The native AAA schema uses a dedicated container partitioned by `/projectId`; `.env.example` documents the required endpoint, database, container, authentication, schema, and optional auto-create settings. AAA validates the configured partition path and surfaces configuration or service failures instead of silently falling back to a different backend.

`GET /api/storage/status` returns credential-safe readiness metadata. When using Entra authentication, the runtime identity needs Cosmos DB data-plane permissions for session operations. Database and container creation may additionally require management-plane permissions.

## Local document preview

Selecting a Markdown file renders its current draft in Preview. Saved Markdown starts in **Draft** state and must be marked **Reviewed** before the Web tab or published-preview route will render it. AAA stores a SHA-256 hash of the reviewed content in the project's local `.aaa\publication.json`; any subsequent saved edit automatically returns the document to Draft. The generated Web document runs in a sandboxed frame, uses a restrictive content security policy, and does not load external resources.

Supported BMP, GIF, JPEG, PNG, SVG, and WebP files open directly in Preview through a project-boundary-checked image route. SVG preview rejects scripts, event handlers, embedded HTML, stylesheets, external links/resources, entity declarations, and CSS URLs; the response is also sandboxed with a deny-by-default content security policy. JSON files open as formatted, readable Preview content, and malformed JSON produces an explicit parse error instead of a misleading raw preview.

The Source tab is an editor for supported text files. It tracks unsaved changes, supports `Ctrl+S` / `Cmd+S`, uses the file timestamp for optimistic concurrency, and provides create, rename, and delete controls through in-app dialogs. Conflicting external changes are reported without overwriting either version.

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
