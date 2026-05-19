# Junior Workbench

Junior Workbench is a web-first vertical slice of Junior for building Azure security approval packages without requiring VS Code.

The app preserves Junior's core working loop: an agent operates over workspace files, reads package documents, stages file edits, shows pending changes, lets a human approve or undo those edits, and publishes the approved package as a static website.

## First Slice

- React + Vite web app with a dense workbench layout.
- File tree backed by a local filesystem workspace.
- Monaco markdown editor and live markdown preview.
- Chat panel with a simple server-side Junior agent loop.
- Pending change review with approve and undo actions.
- Static package publisher that emits local HTML.

## Architecture

- `src/` contains the browser client.
- `server/` contains the server-side agent service and APIs.
- `server/services/localWorkspaceStorage.ts` is the development storage adapter.
- `server/services/workspaceIndexer.ts` builds the first workspace manifest and text index so agent turns are grounded in files.
- `server/services/agentConfigStore.ts` loads custom-agent style definitions and Azure OpenAI connection metadata.
- `server/services/azureOpenAiChatClient.ts` calls Azure OpenAI chat completions for configured agents.
- `server/services/groundingService.ts` resolves local workspace and optional Azure AI Search grounding snippets.
- `server/services/changeManager.ts` tracks staged file edits before approval.
- `server/services/simpleJuniorAgent.ts` is the temporary tool loop shaped to be replaced by Junior's real `AgentLoop` from `C:\Users\SystemAdministrator\source\repos\SecureChatExtension`.
- `data/workspaces/default` is created at runtime with seed approval-package markdown.
- `data/published/default/index.html` is created by the publish flow.

## Run Locally

```bash
npm install
npm run dev
```

Open the Vite URL shown in the terminal. The API listens on `http://localhost:8787`, and Vite proxies `/api` plus `/published` to it.

## Configure Agents

Agents are configured like custom agents: definitions describe behavior, tools, model connection, and grounding sources while secrets stay in environment variables or ignored local secret files.

- `config/agents.json` defines available agents, instructions, tools, and grounding sources.
- `config/agent-connections.json` seeds Azure OpenAI and Azure AI Search connectors.
- `.env.example` lists the environment variables needed for Azure OpenAI and optional Azure AI Search grounding.
- The gear menu in the web UI opens configuration for Connectors and Custom Agents.

By default, the server reads and writes local JSON files under `config/`. To use Azure Cosmos DB for these JSON configuration items, set:

```bash
COSMOS_DB_ENDPOINT=https://your-account.documents.azure.com:443/
COSMOS_DB_DATABASE=JuniorWeb
COSMOS_DB_CONFIG_CONTAINER=Agents
COSMOS_DB_AUTH_MODE=entra
```

The `Agents` container should use partition key `/id`. On first run, the server writes two documents, `agents` and `connections`, seeded from the local JSON files. Entra ID is the default Cosmos auth mode through `DefaultAzureCredential`; set `COSMOS_DB_AUTH_MODE=api-key` and `COSMOS_DB_KEY` only when key auth is required.

Default Azure OpenAI variables for Entra auth:

```bash
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
AZURE_OPENAI_DEPLOYMENT=your-chat-deployment
AZURE_OPENAI_API_VERSION=2025-01-01-preview
```

The default Azure OpenAI connection uses `authMode: "entra"` and `DefaultAzureCredential`, so local development can use Azure CLI sign-in and Azure hosting can use managed identity. The identity needs access to call the Azure OpenAI resource, for example the Cognitive Services OpenAI User role.

API-key auth is still available as a fallback by setting a connection to `authMode: "api-key"` in `config/agent-connections.json` and providing `AZURE_OPENAI_API_KEY`.

Azure AI Search grounding is configured by creating an Azure AI Search connector, then choosing that connector and index on a custom agent. The server uses Entra ID by default through `DefaultAzureCredential`; API keys entered in the UI are stored in `config/connector-secrets.local.json`, which is ignored by git.

The current server supports Entra ID and optional API-key Azure OpenAI, Azure AI Search, and Cosmos DB connections behind configuration boundaries.

## Next Porting Steps

1. Extract Junior's reusable agent loop, tool registry, permissions, retrieval, session state, and middleware behind web-friendly interfaces.
2. Replace VS Code filesystem, SecretStorage, webview messaging, diagnostics, inline diff, terminal, auth, and settings usage with server adapters.
3. Add semantic indexing with document chunking and embeddings over the package workspace.
4. Add production workspace storage: Blob Storage or Git-backed storage first, Azure Files only when filesystem semantics are required.
5. Add identity, session permissions, audit records, and model access on the server.
6. Publish static output to Azure Static Web Apps, Blob static hosting, or App Service.

See `docs/JUNIOR-WORKBENCH-HANDOFF.md` for the portable product handoff and indexing requirements.
