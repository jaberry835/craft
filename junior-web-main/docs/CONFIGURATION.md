# Junior Workbench Configuration

This document covers the configuration surfaces in Junior Workbench and where each kind of state lives in local development versus deployed mode.

## Current Model

Configuration is split into two layers:

- Shared admin configuration: seeded from `config/*.json` and optionally persisted in Cosmos DB.
- Workspace-scoped configuration: saved per workspace and separated from workspace secret values.

Current identity behavior:

- Workspace ownership is already part of the server model.
- Request identity is resolved centrally in the Express layer.
- Local development defaults to an explicit fallback identity unless you switch to Microsoft Entra MSAL mode or the optional trusted-header mode.

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

Identity mode defaults:

```bash
JUNIOR_IDENTITY_MODE=local-fallback
JUNIOR_IDENTITY_FALLBACK_USER_ID=admin
JUNIOR_IDENTITY_FALLBACK_DISPLAY_NAME=Admin
JUNIOR_IDENTITY_FALLBACK_ROLES=Junior.Admin,Junior.User
JUNIOR_ADMIN_ROLES=admin,Junior.Admin
JUNIOR_USER_ROLES=Junior.User,Junior.Admin,admin
```

Preferred deployed Microsoft Entra + MSAL settings:

```bash
JUNIOR_IDENTITY_MODE=entra-msal
JUNIOR_ENTRA_TENANT_ID=<entra-tenant-id>
JUNIOR_ENTRA_CLIENT_ID=<entra-app-client-id>
JUNIOR_ENTRA_API_AUDIENCE=api://<entra-app-client-id>
JUNIOR_ENTRA_SCOPES=api://<entra-app-client-id>/Junior.Workbench.Access
JUNIOR_ENTRA_AUTHORITY=https://login.microsoftonline.com/<entra-tenant-id>
```

Optional alternate trusted-header mode expects these request headers:

- `x-junior-user-id`
- `x-junior-display-name`
- optional `x-junior-tenant-id`
- `x-junior-roles` as a comma-separated role list

Current server-side data-access boundary:

- The browser authenticates with Entra or uses local fallback, but it does not talk directly to Cosmos DB.
- The API enforces workspace ownership and role checks before serving workspace-scoped data.
- Cosmos-backed chat sessions, pending changes, and workspace state use owner-scoped partition keys of `ownerId:workspaceId`.
- Shared admin catalogs remain global and are intentionally restricted to admin-only APIs.
- Workspace metadata is still stored in a shared catalog document, so that specific container relies on app-layer authorization rather than Cosmos-native per-user partitioning.

Use [docs/README-identity.md](docs/README-identity.md) for the Entra app registration steps and the admin versus regular-user authorization model.

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

For a side-by-side explanation of Microsoft Foundry versus public OpenAI connectivity, identity, and permission differences, use [docs/FOUNDRY-VS-OPENAI.md](docs/FOUNDRY-VS-OPENAI.md).

Azure OpenAI connectors now support an explicit endpoint type so air-gapped, private DNS, sovereign, or custom-hosted environments do not have to rely on hostname heuristics alone.

Use these endpoint types for Azure OpenAI connectors:

- `foundry-project` for Foundry project endpoints such as `.../api/projects/.../openai/v1/responses`
- `openai-v1` for OpenAI-compatible `v1` endpoints such as `.../openai/v1/`
- `azure-openai-legacy` for legacy Azure OpenAI deployment endpoints where the runtime builds `/openai/deployments/{deployment}/chat/completions?api-version=...`
- `auto` only when the endpoint shape is standard and hostname or path detection is trustworthy in your environment

For air-gapped or custom DNS environments, prefer setting endpoint type explicitly. If the token audience in your environment differs from the public cloud default, also set `credentialScope` explicitly in the connector configuration.

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