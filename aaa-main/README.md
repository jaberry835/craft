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

The backend chat route is `POST /api/projects/:projectId/sessions/:sessionId/chat/stream`. It returns newline-delimited JSON events (`assistant_text`, `reasoning`, `completed`, or `error`). Tool execution and retrieval grounding are intentionally not enabled yet.

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
