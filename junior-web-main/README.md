# Junior Workbench

Junior Workbench is a web-first vertical slice of Junior for building Azure security approval packages without requiring VS Code.

The app preserves Junior's core working loop: an agent operates over workspace files, reads package documents, stages file edits, shows pending changes, lets a human approve or undo those edits, and publishes the approved package as a static website.

## First Slice

- React + Vite web app with a dense workbench layout.
- File tree backed by pluggable workspace storage: local in development, blob plus local cache in deployed mode.
- Monaco markdown editor and live markdown preview.
- Chat panel with a simple server-side Junior agent loop.
- Pending change review with approve and undo actions.
- Workspace-scoped settings layered on top of shared admin templates and connectors.
- Chat sessions and pending changes persisted behind explicit storage seams.

## Architecture

Architecture diagram: [docs/junior-workbench-architecture.svg](docs/junior-workbench-architecture.svg)

- `src/` contains the browser client.
- `server/` contains the server-side agent service and APIs.
- `server/services/workspaceStorageFactory.ts` selects local or blob-backed workspace file storage.
- `server/services/cachedBlobWorkspaceStorage.ts` keeps blob-backed workspaces compatible with file-oriented runtime code by maintaining a local cache.
- `server/services/persistenceFactories.ts` selects the persistence backend for workspace metadata, workspace config, chat sessions, pending changes, and workspace secrets.
- `server/services/workspaceConfigStore.ts` manages workspace-local agents, connectors, MCP servers, and imported templates.
- `server/services/keyVaultWorkspaceSecretStore.ts` stores workspace connector and MCP secret values in Azure Key Vault when configured.
- `server/services/localWorkspaceManager.ts` and `server/services/workspaceRegistry.ts` enforce owner-scoped workspace resolution behind a request identity middleware with local fallback, Microsoft Entra MSAL bearer-token validation, and optional trusted-header modes.
- `server/services/simpleJuniorAgent.ts` and `server/services/juniorAgentLoop.ts` run the current server-side agent loop.
- `data/workspaces/default` is created at runtime with seed approval-package markdown.

## Run Locally

```bash
npm install
npm run dev
```

Open the Vite URL shown in the terminal. The API listens on `http://localhost:8787`, and Vite proxies `/api` plus `/published` to it.

## Configuration

Use [docs/CONFIGURATION.md](docs/CONFIGURATION.md) for local configuration, environment variables, shared admin config, workspace config, workspace secrets, and storage backend selection.

Use [docs/README-identity.md](docs/README-identity.md) for identity modes, Entra app registration setup, role mapping, and deployment guidance.

Use [docs/FOUNDRY-VS-OPENAI.md](docs/FOUNDRY-VS-OPENAI.md) for the connection model differences between Microsoft Foundry, Azure OpenAI resource endpoints, and the public OpenAI API.

Use [docs/AZURE-PERSISTENCE-DEPLOYMENT.md](docs/AZURE-PERSISTENCE-DEPLOYMENT.md) for Azure App Service, Blob Storage, Cosmos DB, and Key Vault setup.

## What Exists Now

- Microsoft Entra sign-in is handled in the web app through MSAL, with server-side bearer-token validation for API calls.
- Local development can still bypass Entra by switching to explicit local fallback identity mode.
- Shared admin catalogs and templates can be seeded from `config/*.json` or persisted in Cosmos DB.
- Workspace-local config is separated from workspace secret values.
- Workspace secret values can stay local in development or move to Key Vault in deployed mode.
- Workspace metadata, workspace config, chat sessions, and pending changes each have separate persistence seams.
- Blob-backed workspace files can run with a local cache so deployment does not depend on repo-local writable storage.
- Blob-backed workspace files can authenticate with either a storage connection string or Entra identity via the blob service URL.

## Identity And Data Access

- The browser authenticates users with Microsoft Entra when `JUNIOR_IDENTITY_MODE=entra-msal`.
- The API validates bearer tokens and derives the current caller from Entra claims such as `oid`, `tid`, and `roles`.
- Workspace APIs are owner-scoped in the application layer: users only receive workspaces whose `ownerId` matches their resolved identity.
- Workspace-backed Cosmos documents for chat sessions, pending changes, and workspace state are partitioned by `ownerId:workspaceId`, and the API only queries the current owner's partition for those flows.
- Shared admin configuration stored in Cosmos is intentionally tenant-global and remains restricted to admin-only APIs.
- Cosmos DB access is currently mediated by the server's configured credential, not by direct end-user Cosmos credentials from the browser. The security boundary is the app's authorization layer.

## Current Limitations

- `SimpleJuniorAgent` remains the current bridge implementation while the full Junior agent loop is being ported.
- Workspace metadata is still stored in a shared catalog document. Access to it is filtered server-side by `ownerId`, but the metadata container itself is not yet partitioned by end user.

## Next Porting Steps

1. Extract Junior's reusable agent loop, tool registry, permissions, retrieval, session state, and middleware behind web-friendly interfaces.
2. Replace VS Code filesystem, SecretStorage, webview messaging, diagnostics, inline diff, terminal, auth, and settings usage with server adapters.
3. Add semantic indexing with document chunking and embeddings over the package workspace.
4. Add production workspace storage: Blob Storage or Git-backed storage first, Azure Files only when filesystem semantics are required.
5. Extend identity, audit, and session attribution further on the server, and harden persistence boundaries where owner metadata still lives in shared documents.
6. Publish static output to Azure Static Web Apps, Blob static hosting, or App Service.

See `docs/JUNIOR-WORKBENCH-HANDOFF.md` for the portable product handoff and indexing requirements.
See `docs/AGENT-LOOP.md` for the current server-side agent loop design and request lifecycle.
