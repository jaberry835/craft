# Junior Workbench Configuration

This document covers the configuration surfaces in Junior Workbench and where each kind of state lives in local development versus deployed mode.

## Current Model

Configuration is split into two layers:

- Shared admin configuration: seeded from `config/*.json` and optionally persisted in Cosmos DB.
- Workspace-scoped configuration: saved per workspace and separated from workspace secret values.

Current identity behavior:

- Workspace ownership is already part of the server model.
- Request identity is still stubbed to `admin` in the current vertical slice.

## Local Development Defaults

If you run the app with no extra environment variables:

- Workspace files use the local filesystem under `data/workspaces`.
- Workspace config uses `.junior/workspace-config.json` inside each workspace.
- Workspace connector and MCP secrets use local ignored files inside each workspace.
- Shared admin agent/connector config is seeded from `config/*.json`.
- Chat sessions use the local chat session store.
- Pending changes stay in the in-memory pending change store.

Start locally with:

```bash
npm install
npm run dev
```

## Shared Admin Configuration

These files seed the shared admin catalog:

- `config/agents.json`
- `config/agent-connections.json`
- `config/mcp-servers.json`
- `config/agent-templates.json`
- `config/mcp-catalog.json`
- `config/workspace-templates.json`

`.env.example` includes the baseline Azure OpenAI and optional shared-config Cosmos settings.

To persist the shared admin config in Cosmos DB, set:

```bash
COSMOS_DB_ENDPOINT=https://your-account.documents.azure.com:443/
COSMOS_DB_DATABASE=JuniorWeb
COSMOS_DB_CONFIG_CONTAINER=Agents
COSMOS_DB_AUTH_MODE=entra
```

Use `COSMOS_DB_KEY` only when `COSMOS_DB_AUTH_MODE=api-key`.

## Workspace Configuration

Workspace config now excludes secrets.

It stores:

- workspace-local custom agents
- workspace-local model/search connectors
- workspace-local MCP server definitions
- imported workspace template ids

Persistence options:

- Local: `.junior/workspace-config.json`
- Cosmos DB: `COSMOS_DB_WORKSPACE_CONFIG_CONTAINER`

To turn on Cosmos-backed workspace config:

```bash
COSMOS_DB_ENDPOINT=https://your-account.documents.azure.com:443/
COSMOS_DB_DATABASE=JuniorWeb
COSMOS_DB_AUTH_MODE=entra
COSMOS_DB_WORKSPACE_CONFIG_CONTAINER=WorkspaceConfig
```

## Workspace Secrets

Workspace connector API keys and workspace MCP secrets are stored separately from workspace config.

Local development:

- `.junior/workspace-connector-secrets.local.json`
- `.junior/workspace-mcp-secrets.local.json`

Deployed mode:

- Azure Key Vault via `AZURE_KEY_VAULT_URL`

To turn on Key Vault-backed workspace secrets:

```bash
AZURE_KEY_VAULT_URL=https://your-vault-name.vault.azure.net/
JUNIOR_KEY_VAULT_SECRET_PREFIX=junior
```

The prefix is optional. The default is `junior`.

## Workspace File Storage

Workspace files use the `WorkspaceStorage` abstraction.

Local development:

- local filesystem storage rooted at each workspace path

Deployed blob mode:

- Azure Blob Storage as the source of truth
- local disk cache so file-oriented runtime services still work
- authentication via either a storage connection string or Entra identity

To turn on blob-backed workspaces:

```bash
JUNIOR_WORKSPACE_STORAGE_BACKEND=blob
AZURE_STORAGE_CONNECTION_STRING="DefaultEndpointsProtocol=https;AccountName=..."
AZURE_STORAGE_BLOB_SERVICE_URL=https://your-storage-account.blob.core.windows.net
JUNIOR_WORKSPACE_BLOB_CONTAINER=junior-workspaces
JUNIOR_WORKSPACE_BLOB_PREFIX=workspaces
JUNIOR_WORKSPACE_LOCAL_CACHE_ROOT=/home/site/workspaces-cache
```

`JUNIOR_WORKSPACE_LOCAL_CACHE_ROOT` is recommended in App Service so the cache sits in a predictable writable location.
When keys are disabled on the storage account, omit `AZURE_STORAGE_CONNECTION_STRING` and set `AZURE_STORAGE_BLOB_SERVICE_URL` instead.

## Other Persistence Domains

These persistence domains are already separated from workspace config:

- Workspace metadata: `COSMOS_DB_WORKSPACE_CONTAINER`
- Chat sessions: `COSMOS_DB_CHAT_CONTAINER`
- Pending changes: `COSMOS_DB_PENDING_CHANGE_CONTAINER`

## Azure OpenAI and Azure AI Search

The default shared model connection uses Entra auth.

Common local env vars:

```bash
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
AZURE_OPENAI_DEPLOYMENT=your-chat-deployment
AZURE_OPENAI_API_VERSION=2025-01-01-preview
```

Optional API-key fallback:

```bash
AZURE_OPENAI_API_KEY=
```

Optional Azure AI Search API-key values:

```bash
AZURE_AI_SEARCH_ENDPOINT=https://your-search.search.windows.net
AZURE_AI_SEARCH_INDEX=security-approval-index
AZURE_AI_SEARCH_API_KEY=
```

## Full Azure Deployment Setup

For Azure resource creation, App Service settings, Cosmos container layout, Key Vault roles, and verification steps, use [docs/AZURE-PERSISTENCE-DEPLOYMENT.md](docs/AZURE-PERSISTENCE-DEPLOYMENT.md).