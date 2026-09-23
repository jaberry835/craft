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

The backend chat route is `POST /api/projects/:projectId/sessions/:sessionId/chat/stream`. It returns newline-delimited JSON events (`assistant_text`, `reasoning`, `tool_event`, `completed`, or `error`). The bounded agent loop can list and read project files, create or replace text files, and perform targeted exact-text edits through the project-root-constrained file service. Reasoning and tool steps are persisted with the assistant turn and restored as expandable chat details.

Each session also stores structured agent runs with `running`, `completed`, `failed`, or `aborted` status; start/completion timestamps; model connection ID; associated user and assistant message IDs; reasoning; tool events; changed files; partial assistant text; and a credential-safe error when applicable.

Cloud evidence tools, retrieval grounding, skills, MCP execution, and higher-impact actions are intentionally not enabled yet. The punch list retains an explicit approval-policy milestone before the agent tool surface expands.

## Session storage

Local JSON session storage is the default and remains suitable for air-gapped use. Set `AAA_SESSION_STORAGE=cosmos` to use Cosmos DB instead. The native AAA schema uses a dedicated container partitioned by `/projectId`; `.env.example` documents the required endpoint, database, container, authentication, schema, and optional auto-create settings. AAA validates the configured partition path and surfaces configuration or service failures instead of silently falling back to a different backend.

`GET /api/storage/status` returns credential-safe readiness metadata. When using Entra authentication, the runtime identity needs Cosmos DB data-plane permissions for session operations. Database and container creation may additionally require management-plane permissions.

## Local document preview

Selecting a Markdown file in the Web tab renders it through AAA's local `published` route in a sandboxed frame. The generated document uses a restrictive content security policy and does not load external resources. The Preview tab remains the in-workbench draft rendering; reviewed publication workflow state will be added with the security-package workflow.

The Source tab is an editor for supported text files. It tracks unsaved changes, supports `Ctrl+S` / `Cmd+S`, uses the file timestamp for optimistic concurrency, and provides create, rename, and delete controls through in-app dialogs. Conflicting external changes are reported without overwriting either version.

## Projects and customizations

Use the project selector in the top bar to switch authorization packages or create a managed local project. New projects are stored under `data\workspaces\`, seeded with the security-package template, and supplied with the reference `.github` agents, skills, prompts, and `.vscode\mcp.json`. Runtime project metadata and the active selection are stored in `data\projects.json`; both locations are excluded from Git. The tracked `config\projects.json` remains the seed configuration.

Open **Project customizations** from the left pane to inspect and configure the selected project's Agents, Skills, MCP Servers, and built-in Tools. Agent and Skill editors update their project Markdown files, MCP editors preserve the project's `.vscode\mcp.json` configuration, and capability availability is persisted in the project's hidden `.aaa\customizations.json` file. Built-in Tool definitions remain protected while their project availability can be changed. Instructions and Hooks are visible as disabled **Coming soon** surfaces.

## Run the built application

```powershell
npm run build
npm start
```

Open `http://127.0.0.1:8787`. The single local server hosts both the built client and API.

## Validate

```powershell
npm run test:server
npm run lint
npm run build
```

The initial configured project is `C:\dev\another-demo`. Project configuration lives in `config\projects.json`; local session data is written under `data\` and is excluded from Git.
