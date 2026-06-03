# Azure Persistence Deployment

This project now supports a production persistence split with four different storage roles:

- Azure Blob Storage for workspace file trees.
- Azure Cosmos DB for workspace metadata, workspace config, chat sessions, and pending changes.
- Azure Key Vault for workspace-scoped connector and MCP secret values.
- Local disk as an App Service cache for blob-backed workspaces.

The current implementation keeps development mode simple:

- Local files remain the default for workspace files, workspace config, and workspace secrets.
- Cosmos DB turns on when `COSMOS_DB_ENDPOINT` is configured.
- Key Vault turns on when `AZURE_KEY_VAULT_URL` or `KEY_VAULT_URI` is configured.
- Blob-backed workspaces turn on when `JUNIOR_WORKSPACE_STORAGE_BACKEND=blob`.

## Resource Layout

Create these Azure resources:

1. One Azure Storage account.
2. One Azure Cosmos DB for NoSQL account.
3. One Azure Key Vault.
4. One Azure App Service Web App with a system-assigned managed identity.

Recommended logical separation:

- Blob container: `junior-workspaces`
- Cosmos container: `Workspaces`
- Cosmos container: `WorkspaceConfig`
- Cosmos container: `ChatSessions`
- Cosmos container: `PendingChanges`
- Cosmos container: `Agents` if you also want shared admin config in Cosmos

## Cosmos DB Containers

Create the Cosmos database first, for example `JuniorWeb`.

For repeatable setup, you can use the bootstrap script in this repo:

```bash
bash scripts/bootstrap-azure-persistence.sh \
  --resource-group <rg> \
  --cosmos-account <cosmos-account> \
  --storage-account <storage-account>
```

PowerShell version:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/bootstrap-azure-persistence.ps1 \
  -ResourceGroup <rg> \
  -CosmosAccount <cosmos-account> \
  -StorageAccount <storage-account>
```

If Cosmos DB and Storage live in different resource groups, keep the single shared flag out and pass separate values instead:

```bash
bash scripts/bootstrap-azure-persistence.sh \
  --cosmos-resource-group <cosmos-rg> \
  --storage-resource-group <storage-rg> \
  --cosmos-account <cosmos-account> \
  --storage-account <storage-account>
```

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/bootstrap-azure-persistence.ps1 \
  -CosmosResourceGroup <cosmos-rg> \
  -StorageResourceGroup <storage-rg> \
  -CosmosAccount <cosmos-account> \
  -StorageAccount <storage-account>
```

The script creates:

- Cosmos database `JuniorWeb` by default
- Cosmos containers `Workspaces`, `WorkspaceConfig`, `ChatSessions`, `PendingChanges`
- Optional Cosmos container `Agents`
- Blob container `junior-workspaces`

Override names with flags such as `--database`, `--workspace-container`, `--config-container`, `--chat-container`, `--pending-container`, `--agents-container`, and `--blob-container`. The PowerShell script exposes the same options as named parameters.

Container setup:

1. `Workspaces`
2. `WorkspaceConfig`
3. `ChatSessions`
4. `PendingChanges`
5. Optional: `Agents`

Use partition key `/partitionKey` for each container above.

Current document usage:

- `Workspaces` stores a single catalog document with `id = workspaceCatalog` and `partitionKey = workspaceCatalog`.
- `WorkspaceConfig` stores workspace config documents with `partitionKey = <ownerId>:<workspaceId>`.
- `ChatSessions` stores chat session documents with `partitionKey = <ownerId>:<workspaceId>`.
- `PendingChanges` stores pending change documents with `partitionKey = <ownerId>:<workspaceId>`.
- `Agents` is already used separately by the shared admin config store when enabled.

## Blob Storage

Create one private blob container for workspace file contents.

Recommended values:

- Container: `junior-workspaces`
- Prefix: `workspaces`

Each workspace is written under:

```text
workspaces/<workspace-id>/...
```

The server also keeps a local cache directory. In App Service, point that cache at a writable local path such as `/home/site/workspaces-cache`.

Blob authentication options:

- `AZURE_STORAGE_CONNECTION_STRING` for key-based auth
- `AZURE_STORAGE_BLOB_SERVICE_URL` for Entra or managed-identity auth

## Key Vault

Workspace connector API keys and workspace MCP secrets now belong in Key Vault instead of Cosmos or checked-in config.

The app stores one JSON secret per workspace connection or workspace MCP server.

Secret naming shape:

```text
<prefix>-workspace-<ownerId>-<workspaceId>-connection-<connectionId>
<prefix>-workspace-<ownerId>-<workspaceId>-mcp-<serverId>
```

Default prefix:

```text
junior
```

You can override it with `JUNIOR_KEY_VAULT_SECRET_PREFIX`.

## Managed Identity Permissions

Enable the system-assigned managed identity on the App Service.

Grant these permissions:

1. Cosmos DB: `Cosmos DB Built-in Data Contributor` on the Cosmos account or database scope.
2. Key Vault: `Key Vault Secrets Officer` or a narrower custom role with `get` and `set` for secrets.
3. Azure OpenAI: `Cognitive Services OpenAI User` if you are using Entra auth there.
4. Azure AI Search: the appropriate search data/query role if using Entra auth grounding.
5. Blob Storage when using identity auth: `Storage Blob Data Contributor` on the storage account or container scope.

If you deploy from a separate VM by using that VM's system-assigned managed identity, that VM identity also needs deployment RBAC on the target web app. The narrow starting point is `Website Contributor` on the web app resource. This deployment role is separate from the runtime roles above.

Blob storage note:

- Use `AZURE_STORAGE_CONNECTION_STRING` when key auth is allowed.
- Use `AZURE_STORAGE_BLOB_SERVICE_URL` when the account blocks shared keys and you want Entra or managed-identity auth.

## App Service Configuration

Set these application settings on the Web App:

```text
JUNIOR_WORKSPACE_STORAGE_BACKEND=blob
AZURE_STORAGE_CONNECTION_STRING=<storage connection string>
AZURE_STORAGE_BLOB_SERVICE_URL=https://<storage-account>.blob.core.windows.net
JUNIOR_WORKSPACE_BLOB_CONTAINER=junior-workspaces
JUNIOR_WORKSPACE_BLOB_PREFIX=workspaces
JUNIOR_WORKSPACE_LOCAL_CACHE_ROOT=/home/site/workspaces-cache

COSMOS_DB_ENDPOINT=https://<account>.documents.azure.com:443/
COSMOS_DB_DATABASE=JuniorWeb
COSMOS_DB_AUTH_MODE=entra
COSMOS_DB_WORKSPACE_CONTAINER=Workspaces
COSMOS_DB_WORKSPACE_CONFIG_CONTAINER=WorkspaceConfig
COSMOS_DB_CHAT_CONTAINER=ChatSessions
COSMOS_DB_PENDING_CHANGE_CONTAINER=PendingChanges

AZURE_KEY_VAULT_URL=https://<vault-name>.vault.azure.net/
JUNIOR_KEY_VAULT_SECRET_PREFIX=junior
```

Optional shared admin config in Cosmos:

```text
COSMOS_DB_CONFIG_CONTAINER=Agents
```

## Azure CLI Example

Example App Service settings update:

```bash
az webapp config appsettings set \
  --resource-group <rg> \
  --name <app-name> \
  --settings \
    JUNIOR_WORKSPACE_STORAGE_BACKEND=blob \
    AZURE_STORAGE_CONNECTION_STRING="<connection-string>" \
    AZURE_STORAGE_BLOB_SERVICE_URL=https://<storage-account>.blob.core.windows.net \
    JUNIOR_WORKSPACE_BLOB_CONTAINER=junior-workspaces \
    JUNIOR_WORKSPACE_BLOB_PREFIX=workspaces \
    JUNIOR_WORKSPACE_LOCAL_CACHE_ROOT=/home/site/workspaces-cache \
    COSMOS_DB_ENDPOINT=https://<cosmos-account>.documents.azure.com:443/ \
    COSMOS_DB_DATABASE=JuniorWeb \
    COSMOS_DB_AUTH_MODE=entra \
    COSMOS_DB_WORKSPACE_CONTAINER=Workspaces \
    COSMOS_DB_WORKSPACE_CONFIG_CONTAINER=WorkspaceConfig \
    COSMOS_DB_CHAT_CONTAINER=ChatSessions \
    COSMOS_DB_PENDING_CHANGE_CONTAINER=PendingChanges \
    AZURE_KEY_VAULT_URL=https://<vault-name>.vault.azure.net/ \
    JUNIOR_KEY_VAULT_SECRET_PREFIX=junior
```

## Verification Checklist

After deployment, verify these behaviors:

1. Creating a workspace writes metadata to Cosmos and files to Blob.
2. Editing workspace settings writes config to `WorkspaceConfig`.
3. Saving a workspace connector API key or MCP secret writes a secret into Key Vault.
4. Chat sessions appear in `ChatSessions`.
5. Pending changes appear in `PendingChanges` and disappear after approval or undo.
6. Restarting the App Service preserves files, chat history, config, and pending changes.

If your storage account blocks shared keys, leave `AZURE_STORAGE_CONNECTION_STRING` unset and verify the app can still create and read workspace files using `AZURE_STORAGE_BLOB_SERVICE_URL` plus the managed identity role assignment.

## Local Development Parity

Default local behavior remains:

- Workspace files: local filesystem.
- Workspace config: local `.junior/workspace-config.json`.
- Workspace secrets: local `.junior/workspace-connector-secrets.local.json` and `.junior/workspace-mcp-secrets.local.json`.

To test production-style behavior locally, set the same environment variables against real Azure resources and run:

```bash
npm run dev
```