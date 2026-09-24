# MCP Site Builder

A Node.js service that accepts Markdown and plain-text documents through REST or MCP, renders a deterministic static documentation site, and publishes named sites to Azure Storage static website hosting.

## Current capabilities

- JSON REST API and stateless Streamable HTTP MCP endpoint.
- Folder-based recursive navigation and explicit `.html` links.
- React server-rendered static HTML with bundled preset themes.
- Site-level classification bar defaulting to `UNCLASSIFIED`.
- Strict Markdown sanitization, plain-text escaping, and safe path validation.
- Durable Blob/Queue workflow with a bounded worker in the App Service process.
- Atomic version-first publication and stable site entry points.
- Public root catalog of current sites.
- Azure managed identity for Blob and Queue operations.
- In-memory backend for local development and tests.

## Local development

1. Install dependencies with `npm install`.
2. Build with `npm run build`.
3. Set `STORAGE_BACKEND=memory` or copy `.env.example` values into the shell.
4. Start with `npm run dev`.

The REST service listens on `http://127.0.0.1:3000` by default. MCP is mounted at `/mcp`.

Interactive REST documentation is available at `/docs/`, with the OpenAPI 3.1 document at
`/openapi.json`. Swagger UI includes request examples and supports trying the REST operations
against the current service. MCP remains documented by its protocol tool discovery rather than
OpenAPI.

## REST example

Send `POST /api/v1/sites` with JSON containing:

- `siteId`: safe lowercase identifier.
- `displayName`: catalog and site title.
- `description`: optional catalog description.
- `themeId`: `clarity`, `slate`, or `paper`.
- `templateId`: `static-docs` (default) or the trusted `interactive-docs-v1` template.
- `features`: optional `search`, `tableOfContents`, `copyCode`, and `themeToggle` booleans.
- `classification`: controlled marking; omitted means `UNCLASSIFIED`.
- `documents`: array of `{ path, content }` objects where each path is a safe relative `.md` or `.txt` path. Text files render as escaped preformatted text.

The API returns `202 Accepted` and an operation URL. Poll it until the status is `succeeded` or `failed`.

The interactive template remains fully usable without JavaScript. Its repository-owned browser
bundle progressively adds enabled features; publisher-provided JavaScript, CSS, packages, and
template paths are never accepted or executed.

## MCP tools

- `create_site_draft`: create an empty durable draft.
- `upsert_site_files`: add or replace one or many files; nested paths create folders.
- `get_site_draft`: inspect metadata and file paths without returning file content.
- `publish_site_draft`: queue a completed draft; returns an `operationId`.
- `publish_site`: one-shot alternative for a small complete site.
- `get_publish_status`: poll that ID until `succeeded` or `failed`.
- `list_sites`: list current published sites.
- `get_site`: get one site and its stable URL.
- `delete_site`: permanently remove a site; use only when explicitly requested.

Generic agent loop: call `create_site_draft`, call `upsert_site_files` once per file or batch,
optionally verify with `get_site_draft`, then call `publish_site_draft` and poll
`get_publish_status`. On success use `siteUrl`; on failure report `error`. Input and output schemas
are advertised through `tools/list`.

Build once before starting the stdio server configured in `.vscode/mcp.json`.

## Azure deployment posture

The target is one Linux Azure App Service plus one Storage account. There are no containers, Container Apps, ACR, or runtime package installs. A deployment artifact must be assembled on a compatible Linux build agent with compiled JavaScript and production `node_modules` already included before transfer into an air-gapped environment.

Generated sites and the master catalog are anonymous public static content. The API/MCP endpoint must be restricted by App Service networking/IP restrictions appropriate to the target environment. A classification marking does not provide access control.

See `.azure/deployment-plan.md` for architecture, quota evidence, and validation status.
