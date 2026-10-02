# MCP Azure Scanner

Read-only MCP and REST service that inventories Azure and builds policy, security,
and NIST evidence. MCP and REST use the same authenticated tool handlers and
return the same structured JSON.

## Service endpoints

For a deployment at `https://scanner.example.com`, the public endpoints are:

| Endpoint | Purpose |
|---|---|
| `POST https://scanner.example.com/mcp` | MCP Streamable HTTP endpoint |
| `POST https://scanner.example.com/api/tools/{toolName}` | Invoke any MCP tool through REST using its arguments as the JSON request body |
| `GET https://scanner.example.com/api/tools` | List tools and their input/output JSON schemas |
| `GET https://scanner.example.com/swagger/` | Interactive Swagger UI for the REST API |
| `GET https://scanner.example.com/openapi.json` | OpenAPI 3.1 document |
| `GET https://scanner.example.com/` | Landing page with MCP connection details, REST documentation links, and available tools |
| `GET https://scanner.example.com/healthz` | Service health and cloud capabilities |

The MCP endpoint is always hosted at **`/mcp`** on the same origin as the app.
Configure MCP clients with the full URL, such as
`https://scanner.example.com/mcp`, and select the **Streamable HTTP** transport.
In production, MCP and REST tool calls require the same Entra bearer token and
enforce the same caller isolation. The landing page, tool catalog, OpenAPI
document, Swagger UI, health check, and OAuth metadata are public documentation
or discovery endpoints.

The implementation covers **phases 1 through 8a**, with phase 9 deployment
artifacts prepared and phase 10 local hardening in place:

- Node 24 and TypeScript
- stateless MCP Streamable HTTP at `POST /mcp`
- REST access to every MCP tool at `POST /api/tools/{toolName}`
- generated OpenAPI 3.1, locally hosted Swagger UI, and a service landing page
- exact-origin CORS for a browser SPA
- Commercial and air-gapped cloud profiles with endpoint discovery and overrides
- `DefaultAzureCredential` test mode
- startup ARM and Resource Graph provider capability probe
- `list_subscriptions` using the configured ARM endpoint
- Azure Resource Graph REST client with:
  - configurable air-gap endpoint and API version
  - `$skipToken` paging and stable ordering
  - exponential retry for throttling, transient HTTP failures, and network errors
  - explicit reporting when Azure truncates a query without a continuation token
- `list_resource_groups`
- `inventory_resources`, with filters and complete counts by type, location, and resource group
- `get_resource_configuration`, with sensitive-looking fields redacted
- generic findings for public access, TLS, HTTPS-only, local authentication, managed identity, encryption, private endpoints, and governance tags
- `inventory_network`, covering VNets, subnets, peerings, NSGs, public IPs, private endpoints, route tables, load balancers, gateways, Azure Firewall, WAF/Application Gateway, Bastion, private DNS, Front Door/CDN, and related network resources
- NSG findings for inbound internet allow-all rules and exposed management/data-service ports
- `list_network_endpoints`, with public, restricted, private, and unknown exposure classification for IP and FQDN endpoints
- `get_service_findings` with category-specific checks for compute, AKS/containers, App Service, Key Vault, Storage, SQL and other databases, messaging, AI services, monitoring, and backup
- safe ARM enrichment for App Service TLS, FTP/FTPS, and remote-debugging settings
- direct and inherited policy assignments (including assignments inferred from visible compliance data) and visible exemptions
- policy compliance summaries and paged noncompliant-resource detail
- Defender for Cloud plan tiers, secure scores, and unhealthy assessments from `securityresources`
- Azure RBAC assignments with privileged built-in and wildcard-role flags
- best-effort tenant and management-group context with explicit partial, denied, or unavailable access status
- NIST SP 800-53 Rev. 5 detection through Defender regulatory compliance and policy initiative assignments
- configurable NIST initiative IDs and display-name patterns for air-gapped clouds
- paged NIST control, assessment, and affected-resource detail
- live NIST evidence packages combining Defender, policy, generic, network, and service findings
- configurable resource, Policy, Defender, and regulatory-compliance portal blade paths
- asynchronous full-subscription scans with bounded collector concurrency
- in-memory, TTL-bound scan storage with per-caller isolation, count and memory limits, and eviction
- section-level scan progress, partial failure reporting, and stable paged result retrieval
- single-tenant Entra JWT validation with issuer, audience, tenant, signature,
  expiration, token-version, object-ID, and authorized-client checks
- OBO token exchange using either a local client secret or an App Service
  managed-identity federated client assertion
- OAuth protected-resource metadata and standards-based Bearer challenges
- per-request delegated Azure credentials and per-caller scan isolation
- bounded per-IP MCP request rates with standards-based rate-limit headers
- defensive HTTP response headers and Azure proxy awareness
- best-effort Key Vault secret, key, and certificate metadata, expiry, and key
  rotation-policy visibility without item values or key material
- independent Microsoft Graph checks for Conditional Access, security defaults,
  MFA registration, directory roles, PIM eligibility, guests, and authentication methods
- explicit per-vault and per-identity-check denied/unavailable status
- directly applicable Key Vault and identity posture evidence in NIST packages
- a deny-list that prevents ARM enrichment from calling secret-bearing endpoints such as `listKeys`, App Service app settings, connection strings, and secrets
- health endpoint at `GET /healthz`

See [PLAN.md](./PLAN.md) for the complete roadmap.

## Prerequisites

- Node.js 24 or newer
- Azure CLI
- Access to at least one Azure subscription

## Local setup

```powershell
npm ci
az login
$env:AUTH_MODE = "none"
$env:CORS_ALLOWED_ORIGINS = "http://127.0.0.1:5173"
npm run dev
```

The unauthenticated mode binds to `127.0.0.1` by default and uses the Azure CLI identity through `DefaultAzureCredential`. It refuses a non-loopback binding unless `ALLOW_UNAUTHENTICATED_REMOTE=true`.

Check health:

```powershell
Invoke-RestMethod http://127.0.0.1:3001/healthz
```

Open the landing page and Swagger UI:

```text
http://127.0.0.1:3001/
http://127.0.0.1:3001/swagger/
```

Use MCP Inspector:

```powershell
npx @modelcontextprotocol/inspector
```

Connect the Inspector to `http://127.0.0.1:3001/mcp` using Streamable HTTP, then call `list_subscriptions`.

Call the same tool through REST:

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri http://127.0.0.1:3001/api/tools/list_subscriptions `
  -ContentType "application/json" `
  -Body "{}"
```

For a tool with arguments:

```powershell
$body = @{
  subscriptionId = "00000000-0000-0000-0000-000000000000"
  resourceType = "Microsoft.Storage/storageAccounts"
  pageSize = 200
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri http://127.0.0.1:3001/api/tools/inventory_resources `
  -ContentType "application/json" `
  -Body $body
```

With `AUTH_MODE=obo` or `AUTH_MODE=arm-token`, add
`-Headers @{ Authorization = "Bearer <access-token>" }`. Swagger's
**Authorize** button accepts the same bearer token. Invalid tool arguments
return HTTP `400`; downstream Azure tool failures return HTTP `502`.

## Implemented tools

| Tool | Inputs | Result |
|---|---|---|
| `list_subscriptions` | none | Subscriptions visible to the active Azure identity |
| `list_resource_groups` | `subscriptionId`, optional `pageSize` and `pageToken` | Paged resource groups |
| `inventory_resources` | `subscriptionId`; optional `resourceGroup`, `resourceType`, `location`, `nameContains`, `pageSize`, `pageToken` | Paged inventory plus complete summary counts |
| `get_resource_configuration` | `resourceId` | Full Resource Graph configuration, generic findings, and a portal link |
| `inventory_network` | `subscriptionId`; optional resource type/group/severity and paging | Network topology summary, resources, and exposure findings |
| `list_network_endpoints` | `subscriptionId`; optional exposure/endpoint/resource type and paging | Flat public/private/restricted IP and FQDN inventory |
| `get_service_findings` | `subscriptionId`; optional categories/status/severity and paging | Generic plus type-specific findings with Resource Graph and safe ARM evidence |
| `list_policy_assignments` | `subscriptionId`; optional inherited/scope/definition filters and paging | Direct, inherited, and compliance-inferred policy assignments with visible exemptions |
| `get_policy_compliance` | `subscriptionId`; optional assignment/state/resource filters and paging | Per-state and per-assignment summaries plus matching resources (noncompliant by default) |
| `get_security_posture` | `subscriptionId`; optional severity/resource filters and paging | Defender plans, secure scores, and unhealthy assessments |
| `list_role_assignments` | `subscriptionId`; optional scope/principal/role/privileged filters and paging | RBAC assignments with privileged-role flags |
| `get_tenant_context` | optional item-kind filter and paging | Best-effort visible subscriptions, management groups, MG policy assignments, and MG role assignments |
| `get_identity_posture` | optional check filters and paging | Best-effort Microsoft Graph identity posture with independent status per check |
| `get_keyvault_item_metadata` | `subscriptionId`; optional vault/item type/expiry filters and paging | Secret, key, and certificate metadata plus per-vault access status; never values or key material |
| `get_nist_status` | `subscriptionId` | NIST standard detection through Defender and Policy, distinguishing disabled from unavailable |
| `get_nist_controls` | `subscriptionId`; optional detail level, family/control/status/resource filters and paging | Control, Defender assessment, or affected-resource compliance detail |
| `build_nist_evidence` | `subscriptionId`; optional family/control filters and paging | Evidence grouped by NIST family and control, with explicit source gaps |
| `start_scan` | `subscriptionId` | Starts a bounded-concurrency background scan and immediately returns a caller-owned `scanId` |
| `get_scan_status` | `scanId` | Overall state, percentage, expiry, and status/errors for every scan section |
| `get_scan_result` | `scanId`, `section`; optional collection/resource/finding/NIST filters and paging | Stable paged retrieval from a completed or partially completed section |

Every tool is read-only. MCP returns both text content and `structuredContent`;
REST returns that `structuredContent` directly as JSON. Large lists use
`page.nextPageToken`; pass that value back as `pageToken` without modifying it.

### Phase 8a permissions and failure semantics

Key Vault access uses the cloud profile's `keyVaultAudience`, vault URI, and Key
Vault DNS suffix. Only collection-list, key rotation-policy, and certificate
policy endpoints are called; versioned item retrieval endpoints are never
called. `KEYVAULT_API_VERSION` is configurable for air-gapped clouds, and
`KEYVAULT_EXPIRY_WARN_DAYS` controls the default evidence warning window.

Graph checks use `graphEndpoint` and run independently. Responses identify the
relevant least-privileged permission. HTTP `401`/`403` is `denied`; token,
endpoint, network, and service failures are `unavailable`. Successful primary
data with an unavailable auxiliary policy is `partial`; mixed checks also make
the envelope `partial`.

Example inventory arguments:

```json
{
  "subscriptionId": "00000000-0000-0000-0000-000000000000",
  "resourceType": "Microsoft.Storage/storageAccounts",
  "pageSize": 200
}
```

## Configuration

Copy [.env.example](./.env.example) and provide variables through the process environment. The service deliberately does not load `.env` itself in production.

`AZURE_CLOUD_PROFILE` defaults to [cloud-profiles/azurecloud.json](./cloud-profiles/azurecloud.json). For the air gap:

1. Copy [cloud-profiles/airgap.example.json](./cloud-profiles/airgap.example.json) to `cloud-profiles/airgap.json`.
2. Populate it from the target cloud's `az cloud show` output.
3. Set `AZURE_CLOUD_PROFILE=cloud-profiles/airgap.json`.
4. Override any individual value with the corresponding environment variable.

Keep `graphEndpoint`, `keyVaultAudience`, and `dnsSuffixes.keyVault` accurate.
If Graph is absent, omit `graphEndpoint`; identity checks report `unavailable`
without affecting other collectors.

Startup tries ARM's `/metadata/endpoints` endpoint. If discovery is unavailable, the configured profile remains authoritative and startup continues.

`RESOURCE_GRAPH_API_VERSION` defaults to `2022-10-01`. `RESOURCE_GRAPH_MAX_RETRIES` defaults to `3`. Both are configurable for an air-gapped cloud that exposes an older API.

NIST detection is also cloud-configurable:

- `NIST_INITIATIVE_IDS` is a comma-separated set of policy initiative IDs.
- `NIST_NAME_PATTERNS` is a comma-separated set of standard or initiative display-name patterns.
- `PORTAL_RESOURCE_PATH_TEMPLATE`, `PORTAL_POLICY_COMPLIANCE_PATH_TEMPLATE`,
  `PORTAL_POLICY_OVERVIEW_PATH`, `PORTAL_DEFENDER_PATH`, and
  `PORTAL_DEFENDER_REGULATORY_PATH` configure cloud-specific portal blades.

An empty result is reported as disabled only when both relevant Resource Graph
queries completed. Missing or inaccessible tables produce `enabled: null`,
`availability: "partial" | "unavailable"`, and explanatory access notes.

Asynchronous scans are held in process memory. The defaults are a 60-minute
TTL, 20 scans globally, 5 scans per caller, 128 MiB total stored scan data, and
3 concurrent section collectors. Configure these with
`SCAN_CACHE_TTL_MINUTES`, `SCAN_MAX_SCANS`,
`SCAN_MAX_SCANS_PER_CALLER`, `SCAN_MAX_MEMORY_MB`, and `SCAN_CONCURRENCY`.
Expired scans are aborted and removed. Old finished scans are evicted before
admitting new scans or exceeding the memory budget.

Polling is authoritative. The current stateless Streamable HTTP transport is
closed after `start_scan` returns, so background MCP progress notifications are
not emitted on that closed transport; the orchestrator exposes a progress
callback for a future sessionful transport.

In `AUTH_MODE=none`, scans are isolated under the single local Azure CLI
caller. The store uses an opaque caller partition key derived from validated
Entra `tid` and `oid`, so a scan ID from one
caller cannot be read by another.

## Internal npm mirror

Copy [.npmrc.example](./.npmrc.example) to `.npmrc`, set the internal registry, and run:

```powershell
npm ci
npm run build
npm test
```

The lock file is committed, and `replace-registry-host=always` lets npm resolve packages through the configured internal mirror.

## CORS

`CORS_ALLOWED_ORIGINS` is a comma-separated list of exact SPA origins. `*` is not supported. Preflight requests are handled before authentication, bearer tokens are sent in the `Authorization` header, and cookies are not used.

## Authentication

`AUTH_MODE=none` remains available for loopback-only Commercial testing and
uses `DefaultAzureCredential`. Production uses `AUTH_MODE=obo` and requires:

- `AZURE_TENANT_ID`
- `ENTRA_SERVER_CLIENT_ID`
- `ENTRA_ALLOWED_CLIENT_IDS`, matched against the validated `azp` claim
- `ENTRA_RESOURCE_URI`, the public HTTPS origin used in OAuth metadata
- either `ENTRA_CLIENT_SECRET` for local development or an App Service managed
  identity with a federated identity credential

The SPA requests `api://<ENTRA_SERVER_CLIENT_ID>/access_as_user`. The server
validates the v2 access token through the configured cloud authority, then
exchanges it for downstream tokens through OBO. It publishes
`GET /.well-known/oauth-protected-resource`; unauthenticated MCP requests
receive a `401` Bearer challenge pointing to that metadata.

`AUTH_MODE=arm-token` accepts an ARM-audience token for local MCP Inspector
testing and cannot request Graph or Key Vault tokens. Both development modes
are guarded: unauthenticated mode is loopback-only by default, and
`arm-token` is blocked on App Service.

## Azure deployment preparation

Phase 9 provides [azure.yaml](./azure.yaml), subscription-scoped
[infra/main.bicep](./infra/main.bicep), and the resource module in
[infra/modules/resources.bicep](./infra/modules/resources.bicep). The template
creates:

- a Linux Node.js 24 App Service on an S1 plan
- a user-assigned managed identity used for OBO client assertions and
  Application Insights ingestion
- a Log Analytics workspace and workspace-based Application Insights
- HTTPS/TLS hardening, disabled FTP/remote debugging, health checks, diagnostic
  logs, and optional existing-subnet VNet integration

Direct Bicep resources are used instead of public-registry modules so the same
templates can compile in the air gap. Cloud endpoints, App Service DNS suffix,
internal npm registry, and subnet integration remain parameters.

Install Azure Developer CLI 1.20 or newer, then configure an environment:

```powershell
azd env new dev
azd env set AZURE_SUBSCRIPTION_ID 41c60df0-6ec9-4075-b369-c2fa7cbc1a1a
azd env set AZURE_LOCATION eastus2
azd env set ENTRA_SERVER_CLIENT_ID <api-app-client-id>
azd env set ENTRA_ALLOWED_CLIENT_IDS <spa-client-id>
azd env set CORS_ALLOWED_ORIGINS https://your-spa.example
```

For an air-gapped cloud, also set `APP_SERVICE_DNS_SUFFIX`,
`AZURE_CLOUD_PROFILE`, and `NPM_CONFIG_REGISTRY`. Set
`APP_SERVICE_SUBNET_RESOURCE_ID` and `APP_SERVICE_ROUTE_ALL=true` when the app
must reach private endpoints through an existing subnet delegated to
`Microsoft.Web/serverFarms`.

After provisioning, configure the API app registration to trust the
user-assigned managed identity:

```powershell
.\scripts\configure-federated-credential.ps1 `
  -ApplicationObjectId <api-app-object-id> `
  -ManagedIdentityPrincipalId <MANAGED_IDENTITY_PRINCIPAL_ID-output> `
  -TenantId <tenant-id>
```

The API app registration must expose `access_as_user`, use v2 access tokens,
authorize the SPA client, and have admin-consented delegated permissions for
Azure Service Management plus any optional Graph and Key Vault checks. The SPA
requests only `api://<api-client-id>/access_as_user`.

The authoritative deployment workflow and validation evidence are tracked in
[.azure/deployment-plan.md](./.azure/deployment-plan.md). Infrastructure must
pass `azure-validate` before any `azd up` or Azure deployment command is run.

## Validation

```powershell
npm run typecheck
npm test
npm run build
az bicep build --file infra/main.bicep
```

Phase 7 validation includes a live Commercial Azure
scan through the compiled server on port 3001. The live scan completed all 13
sections, and `get_scan_result` returned stable paged inventory, network, and
NIST evidence data.
