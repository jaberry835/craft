# MCP Azure Scanner — Build Plan (v2)

## 1. Goal

An MCP server running over HTTP and hosted in Azure App Service. A **custom chat app that authenticates users with Entra ID** calls it. The server reads Azure **as the signed-in user** and returns **JSON** covering:

- the subscriptions the user can access
- a full inventory and configuration of every resource: PaaS, compute, network, Key Vault, VMs, data services, and so on
- the network topology and every network endpoint
- policy assignments and policy compliance
- whether **Defender for Cloud's NIST SP 800-53 Rev. 5** standard is enabled, control-level and resource-level compliance, and portal dashboard links
- a **NIST 800-53 evidence package**, exposed as a tool

The primary scope is **workload subscriptions**. Tenant-level questions (management groups, MG-level policy) are answered **best effort**. The server reports clearly when it has no access, rather than failing.

The server is **read-only**. It never changes Azure resources.

### Build status
- **Phase 1 — complete:** Node/TypeScript scaffold, Streamable HTTP, CORS, cloud profiles and discovery, unauthenticated test credential, health/capability probes, and `list_subscriptions`.
- **Phase 2 — complete:** Resource Graph REST client with paging/retry, resource groups, resource inventory and summaries, resource configuration retrieval, redaction, and generic security findings.
- **Phase 3 — complete:** network topology, public/private/restricted endpoints, NSG exposure analysis, and paged network tools.
- **Phase 4 — complete:** type-specific analyzers across major service categories, safe App Service ARM enrichment, and paged service findings.
- **Phase 5 — complete:** Resource Graph policy assignments/compliance, Defender posture, RBAC assignments, and best-effort tenant/management-group context.
- **Phase 6 — complete:** configurable NIST standard detection, control/assessment/resource detail, evidence mapping, and portal links.
- **Phase 7 — complete and live-verified:** asynchronous bounded-concurrency scan orchestration, isolated TTL memory storage, progress, and paged section results. A Commercial Azure scan completed all 13 sections and returned stable paged inventory, network, and NIST evidence results.
- **Phase 8 — implemented and automated-verified:** single-tenant Entra JWT validation, `azp` allow-list, OAuth protected-resource metadata, caller isolation, and OBO using a client secret or managed-identity federated assertion. Live SPA validation awaits the SPA/API app registration values.
- **Phase 8a — complete and live-verified:** best-effort Key Vault item metadata and Microsoft Graph identity posture, with independent partial/denied/unavailable semantics and directly applicable NIST evidence. Commercial validation returned three accessible Graph checks, explicit permission/service gaps for four checks, and per-vault Key Vault RBAC denials without retrieving values.
- **Phase 9 — prepared:** AZD+Bicep deploys a hardened Node.js 24 App Service, user-assigned managed identity, Log Analytics, Application Insights, optional VNet integration, and air-gap build settings. Federated-credential automation and deployment documentation are included; Azure validation and deployment remain.
- **Phase 10 — locally complete:** request rate limits, defensive HTTP headers, Azure Monitor OpenTelemetry, expanded integration/deployment documentation, and 80 automated tests.
- **Next:** complete interactive AZD authentication, rerun provisioning preview, and deploy only after Azure validation succeeds.

### Confirmed decisions
| Topic | Decision |
|---|---|
| Client | Custom **browser SPA**, Entra-authenticated (MSAL.js + PKCE), calls `/mcp` cross-origin over HTTPS. The server must handle **CORS** (see §4.5) |
| Tenant | Single Entra tenant |
| Test / prod | **Test in Azure Commercial**, production in the **air-gapped cloud**. The same build is used for both; only the cloud profile/config differs |
| Build delivery | An **internal npm mirror** is available in the air gap. Build there with `npm ci` against the mirror |
| Scan storage | **In memory** (per-user, TTL) for now. Blob persistence is a later option |
| Microsoft Graph | **Best effort.** Try to answer identity questions (Conditional Access, MFA, PIM, directory roles). If there's no permission or Graph isn't available, return `unavailable` with the reason |
| Key Vault data plane | **Best effort.** Read secret/key/cert **metadata only** (expiry, enabled, rotation), never values. Report per vault when denied or unreachable |
| Output | Every tool returns JSON (MCP `structuredContent` + `outputSchema`, with the same JSON also in a text block for compatibility) |
| NIST | Detect whether the Defender NIST 800-53 R5 standard is enabled, report compliance, and link to dashboards. The evidence package is a tool |
| Scope | Workload subscription level. Tenant/MG level is best effort, with explicit access status |
| Coverage | All resources. Deep checks for major service types, generic checks for everything else |
| Cloud | **Air-gapped Azure cloud** (similar to Azure Government, most services present). Endpoints, API versions and features must be configurable or discovered. See §1a |

## 1a. Air-gapped cloud requirements

These are first-class design constraints:

| Concern | Approach |
|---|---|
| **No hard-coded endpoints** | Everything comes from config or discovery: Entra authority host, ARM endpoint, ARM token audience/scope, portal URL, Graph endpoint, storage/SQL/Key Vault/web DNS suffixes. Nothing may reference `*.windows.net`, `*.azure.com` or `login.microsoftonline.com` directly. |
| **Cloud endpoint discovery** | At startup, call ARM `GET {ARM_ENDPOINT}/metadata/endpoints?api-version=2022-09-01`. This returns the login endpoint, audiences, portal URL and DNS suffixes. Explicit env vars override it, and a static profile file (`cloud-profile.json`) is the fallback. |
| **SDK wiring** | Every Azure SDK client gets `endpoint`, `credentialScopes` / `audience`, and `@azure/identity` gets `authorityHost`. `OnBehalfOfCredential` and JWT validation (issuer + JWKS from `{authority}/{tenant}/v2.0/.well-known/openid-configuration`) use the configured authority. |
| **API version lag** | API versions are kept in one table (`src/azure/apiVersions.ts`) and can be overridden by config. Enrichers try preferred versions, fall back to older ones, and record which version they used. |
| **Feature availability** | A capability probe at startup, cached per subscription: does Resource Graph exist, and which ARG tables work (`securityresources`, `policyresources`, `patchassessmentresources`, …)? Is Defender regulatory compliance available? Which resource providers are registered? Missing features return `access.status = "unavailable"` with a note, never a crash. |
| **ARG fallback** | If Resource Graph or one of its tables is missing, collectors fall back to ARM list APIs (`/resources`, provider list calls, Policy Insights, Security API). This is slower but still works. |
| **NIST initiative / standard IDs** | Built-in IDs may differ in the air gap. Match by ID **or** display name pattern (`NIST SP 800-53 Rev. 5`) and make both configurable. |
| **Portal links** | Built from the discovered/configured portal URL. The blade path formats are configurable in case they differ. |
| **Build & packaging** | Build inside the air gap from the **internal npm mirror**: `npm ci` with an `.npmrc` registry override, then `npm run build`, then zip deploy. The same zip also works if it's transferred in pre-built. Dependencies are kept small and `package-lock.json` is committed. npm swaps the default registry host in `resolved` URLs for the configured mirror (`replace-registry-host`), so the lockfile works in both places. No runtime downloads, CDNs or telemetry to public endpoints. |
| **Test vs. prod clouds** | `cloud-profiles/azurecloud.json` for the Commercial test environment and `cloud-profiles/airgap.json` for production (endpoints filled in from `az cloud show` inside the air gap). Tests assert that no code path uses a hard-coded endpoint. |
| **Deployment tooling** | Plain **Bicep + Azure CLI** (`az deployment group create`, `az webapp deploy`) with the target cloud registered via `az cloud register`. `azd` is optional, not required. |
| **Runtime** | **Node 24 LTS** is available on App Service in the air gap, and is used in Commercial test too. Set `engines.node: ">=24"`, TypeScript target `ES2024`, module `NodeNext`. App Service `linuxFxVersion: NODE|24-lts`. |
| **Monitoring** | App Insights connection string from config (its ingestion endpoint differs per cloud). Can be disabled. |

## 2. Technology decision: Node.js + TypeScript

| Concern | Choice |
|---|---|
| Runtime | Node 24 LTS, TypeScript, Express |
| MCP | `@modelcontextprotocol/sdk`: Streamable HTTP transport, `outputSchema`/`structuredContent`, bearer-auth and protected-resource-metadata helpers |
| Azure auth | `@azure/identity`: `OnBehalfOfCredential` (prod), `DefaultAzureCredential` (test) |
| Azure data | `@azure/arm-resourcegraph` (primary), `@azure/arm-policyinsights`, `@azure/arm-security`, `@azure/arm-monitor`, `@azure/arm-managementgroups`, plus generic ARM `GET` for child resources |
| Validation | `zod` (tool input/output schemas and config), `jose` (JWT validation) |
| Tests | `vitest` |

**Core design choice:** use **Azure Resource Graph (ARG)** for most reads. It covers a whole subscription in one paged query. These tables are used:

| ARG table | Used for |
|---|---|
| `resources` | Every resource and its configuration properties |
| `resourcecontainers` | Subscriptions, resource groups, management groups |
| `policyresources` | Policy assignments, definitions, initiative membership, compliance states |
| `securityresources` | Defender assessments, secure score, **regulatory compliance standards/controls/assessments**, Defender plan pricing |
| `authorizationresources` | Role assignments and definitions |
| `advisorresources` | Advisor recommendations |
| `patchassessmentresources` | VM patch/update status |
| `guestconfigurationresources` | Machine configuration (OS baseline) compliance |
| `healthresources` | Resource health |

**ARM enrichers** make targeted `GET` calls for configuration ARG doesn't expose. Examples: SQL auditing, TDE, and firewall rules; App Service `config/web` (never `appsettings`, which contains secrets); and diagnostic settings.

## 3. Architecture

```
┌──────────────┐ 1. user signs in (Entra)  ┌───────────────────────────────┐
│  Custom app  │ ────────────────────────▶ │ Entra ID (single tenant)      │
│ (MCP client) │ ◀── token aud=api://mcp ─ │                               │
└──────┬───────┘                           └──────────────▲────────────────┘
       │ 2. POST /mcp  Bearer <token for MCP API>         │ 4. OBO exchange
       ▼                                                  │
┌──────────────────────────────────────────────────────────┴───────────────┐
│ App Service (Linux, Node)                                                │
│  Express                                                                 │
│   ├─ /.well-known/oauth-protected-resource   (RFC 9728)                  │
│   ├─ /healthz                                                            │
│   └─ /mcp ─ 3. validate JWT ─ MCP Streamable HTTP ─ tool handlers        │
│                                  │                                       │
│              CredentialFactory ──┘  obo | none | arm-token               │
│                     │                                                    │
│   Collectors (ARG queries + ARM enrichers) → Analyzers (checks) → JSON   │
│                     │                                                    │
│   ScanStore (per-user, TTL) ── optional Blob persistence                 │
└─────────────────────┼────────────────────────────────────────────────────┘
                      ▼ 5. ARM token as the user → user's own RBAC applies
          Azure Resource Manager / Resource Graph / Policy / Defender
```

## 4. Authentication

### 4.1 Production: Entra On-Behalf-Of (OBO)

The MCP spec forbids forwarding the client's token downstream (token passthrough), so we use OBO:

1. The **custom SPA** signs the user in with MSAL.js (auth code + PKCE) and requests a token for the MCP API: `api://<mcp-app-id>/user_impersonation`.
2. The **MCP server** validates the JWT with `jose` against the single-tenant JWKS, discovered from the configured authority (never hard-coded). It checks the issuer, audience equal to the MCP app ID URI or client ID, expiry, `scp` including `user_impersonation`, `tid` equal to the configured tenant, and `azp` in `ALLOWED_CLIENT_APP_IDS`.
3. The server exchanges that token via **OBO** for downstream tokens, **one per resource**, each cached per user:
   - **ARM** (`{armAudience}/user_impersonation`): the main path. ARM enforces **the user's RBAC**.
   - **Microsoft Graph** (`{graphEndpoint}/.default`): best effort (see §9a).
   - **Key Vault** (`{keyVaultAudience}/user_impersonation`): best effort (see §6.3).
   If an OBO exchange fails (for example consent is missing or the resource isn't available in this cloud), only the tools that need it return `access.status = "unavailable"` with the Entra error code. Everything else keeps working.
4. The **OBO credential** is a **federated identity credential backed by the App Service user-assigned managed identity** (no secrets). A client secret or certificate is allowed for local dev.
5. The server publishes `/.well-known/oauth-protected-resource` and returns `401` with a `WWW-Authenticate` header whose `resource_metadata` parameter points at that URL, to stay spec-compliant. The SPA is simply configured with the scope.

**App registrations (single tenant):**
- **`mcp-scanazure-api`** (the server):
  - Expose API `api://<id>` with scope `user_impersonation`
  - Delegated permission Azure Service Management `user_impersonation`, with admin consent
  - Delegated permission Azure Key Vault `user_impersonation` (for metadata reads)
  - Delegated **Microsoft Graph** read-only permissions (admin consent), all optional: `Policy.Read.All` (Conditional Access), `RoleManagement.Read.Directory` (directory roles and PIM), `AuditLog.Read.All` + `Reports.Read.All` (MFA registration details), `Directory.Read.All`. Each permission that is missing only disables its own Graph check.
  - Custom SPA's client ID added to **authorized client applications**, so users see no extra consent prompt
  - FIC trusting the App Service managed identity
  - `requestedAccessTokenVersion: 2`
- **Custom SPA** (existing, platform type *SPA* with redirect URIs): add delegated permission to `mcp-scanazure-api/user_impersonation`. The SPA **only** ever gets a token for the MCP API. It never gets ARM or Graph tokens for this purpose.

### 4.2 Test mode: unauthenticated (`AUTH_MODE=none`)
- There is no inbound auth. The server uses `DefaultAzureCredential`: `az login` locally, or the managed identity on App Service (the MI needs `Reader` + `Security Reader` on the test subscription).
- **Guardrails:** loud startup warning. Binds to `127.0.0.1` unless `ALLOW_UNAUTHENTICATED_REMOTE=true`. Refuses to run on App Service (`WEBSITE_SITE_NAME` set) without that override. All responses include `"authMode": "none"`.

### 4.3 Dev convenience (`AUTH_MODE=arm-token`)
Accepts a raw ARM token (`az account get-access-token`) for curl and MCP Inspector testing. It is **dev only** and blocked on App Service.

### 4.4 RBAC needed by the end user (documented, not enforced)
- `Reader` on workload subscriptions: inventory, network, policy assignments, and compliance states
- `Security Reader`: Defender assessments, regulatory compliance, secure score (Reader covers most of this, but `Security Reader` is the documented role)
- Optional: `Reader` at management-group scope for tenant-level answers
- ARM enrichers may need specific read permissions, such as `Microsoft.Web/sites/config/read`. Failures are reported per item, not fatal.
- Key Vault metadata: `Key Vault Reader` (RBAC vaults) or a `list` access policy (access-policy vaults)
- Graph: an Entra role that can read the data, such as Global Reader or Security Reader. Otherwise the Graph checks return `unavailable`.

### 4.5 Browser SPA: CORS and HTTP details
The SPA calls `/mcp` cross-origin, so the server handles CORS **in the app** (Express `cors` middleware). **App Service platform CORS stays off**, because it overrides app-level headers.

| Setting | Value |
|---|---|
| Allowed origins | `CORS_ALLOWED_ORIGINS`: an exact list of SPA origins, never `*`. The same list is used for the MCP DNS-rebinding `Origin` check |
| Allowed methods | `GET, POST, DELETE, OPTIONS` |
| Allowed request headers | `Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID` |
| Exposed response headers | `Mcp-Session-Id, Mcp-Protocol-Version, WWW-Authenticate` (the SPA must be able to read `WWW-Authenticate` on a `401`) |
| Credentials | `false`. Auth is a bearer header, not cookies |
| Preflight | `OPTIONS` answered **before** the auth middleware (preflight has no token), with `Access-Control-Max-Age` set to cut round-trips |
| Also on | `/.well-known/oauth-protected-resource` (GET + CORS), so the SPA can discover it |

**Scaling note:** a cross-origin SPA doesn't send App Service's ARR-affinity cookie. So with **in-memory** scans, run **one instance**, or keep the MCP transport stateless and pin scans with a later Blob store. Phase 1 uses **stateless Streamable HTTP**, with scans held in memory on a single instance.

**Local testing of CORS:** a tiny test page (`test/spa-harness/index.html`) uses MSAL.js and the MCP client SDK to call the server from a different origin. It is loaded from the internal mirror or bundled, never from a CDN.

## 5. Common JSON response envelope

Every tool returns this shape as `structuredContent`, with the same JSON as a text block:

```json
{
  "tool": "inventory_network",
  "generatedAt": "2026-09-29T20:10:00Z",
  "tenantId": "…",
  "scope": { "level": "subscription", "subscriptionId": "…" },
  "caller": { "authMode": "obo", "upn": "user@contoso.com", "oid": "…" },
  "access": { "status": "full | partial | denied", "notes": ["No read on MG 'root'…"] },
  "summary": { },
  "data": [ ],
  "page": { "nextPageToken": null, "returned": 250, "total": 1234 },
  "portalLinks": { },
  "errors": [ { "source": "sql/auditingSettings", "resourceId": "…", "code": "AuthorizationFailed" } ]
}
```

- `access` and `errors` make **partial access explicit**, which matters most at tenant level.
- Large results are paged (`pageSize`, `pageToken`). Summaries always come first.

## 6. Resource coverage model

Everything is **inventoried** (all `resources` rows). **Analyzers** add security-relevant fields and findings per type. Each finding has a stable `checkId`, `severity`, `status` (`pass | fail | notApplicable | unknown`), `evidence` (the property values used), and `nistControls[]`.

### 6.1 Generic checks (apply to every resource type)
`publicNetworkAccess`, private endpoint connections, minimum TLS, `disableLocalAuth`/key-based auth, managed identity, CMK/encryption settings, diagnostic settings present, resource locks, tags (owner/env/data classification), region, and SKU.

### 6.2 Type-specific analyzers (initial set)
| Area | Types | Key checks |
|---|---|---|
| **Compute** | VMs, VMSS, disks, availability sets | Encryption at host/ADE/CMK, public IP attached, NSG on NIC/subnet, managed identity, extensions (AMA, MDE, guest config), patch status (`patchassessmentresources`), OS image age, backup protected, boot diagnostics, JIT |
| **Containers** | AKS, ACR, Container Apps, Container Instances | AKS: private cluster/authorized IPs, Entra RBAC, local accounts disabled, network policy, Defender profile, version. ACR: admin user, anonymous pull, public access |
| **App platform** | App Service, Functions, Static Web Apps, APIM, Logic Apps | HTTPS only, min TLS, FTPS state, VNet integration, access restrictions, Easy Auth, managed identity, remote debugging off, client certs. APIM: VNet mode, protocols/ciphers |
| **Key Vault / secrets** | Key Vault, Managed HSM, App Configuration | RBAC mode vs. access policies, soft delete, purge protection, network ACLs, public access, private endpoints. *(Secret/cert expiry needs data-plane access. Optional, see Q&A)* |
| **Storage** | Storage accounts, file shares | Blob public access, shared-key access, min TLS, HTTPS only, network default action, infrastructure encryption, CMK, soft delete/versioning |
| **Databases** | SQL server/DB/MI, PostgreSQL/MySQL flexible, Cosmos DB, Redis | Entra-only auth, TDE, auditing, firewall rules (flags `0.0.0.0`/Azure-services and wide ranges), public access, TLS, Defender for SQL. Cosmos: local auth, IP rules. Redis: non-SSL port |
| **Messaging / integration** | Service Bus, Event Hubs, Event Grid, Data Factory | Local auth, public access, private endpoints, TLS |
| **AI / analytics** | Azure OpenAI/AI Services, AI Search, Synapse, Databricks, Data Explorer | Local auth disabled, public access, private endpoints, CMK, managed VNet |
| **Networking** | See §7 | |
| **Monitoring / backup** | Log Analytics, App Insights, Recovery Services / Backup vaults | Retention, workspace access mode, protected items, soft delete, immutability, redundancy |
| **Identity (ARM-side)** | Role assignments, managed identities | Owner/Contributor/User Access Admin at subscription scope, guest/service-principal privileged roles, custom roles with `*` actions |

Unknown or new types still appear in the inventory, with generic checks and raw properties available through `get_resource_configuration`.

### 6.3 Key Vault data plane (best effort)
`get_keyvault_item_metadata` lists **secrets, keys and certificates metadata only**. It uses the data-plane **list** operations, which return attributes, never values. For each item it returns: name, enabled, `created`/`updated`/`notBefore`/`expires`, days until expiry, content type, tags, and the key rotation policy (keys). For certificates it adds issuer, subject, validity and the auto-renew lifetime action.
- The server calls each vault's `vaultUri` (so it follows the cloud's Key Vault DNS suffix) using the Key Vault OBO token.
- Each vault reports `access.status`:
  - `available`
  - `partial` (item metadata is visible but an auxiliary policy is not)
  - `denied` (RBAC or access policy)
  - `unavailable` (token acquisition, endpoint, network, firewall, or service failure)
- Findings: items without expiry, items expired or expiring within `KV_EXPIRY_WARN_DAYS`, keys without a rotation policy, certificates without auto-renew. These map to **SC-12, SC-17 and IA-5**.
- **Never** calls `getSecret`, `getKey` material export, or `getCertificate` with a private key.

## 7. Network inventory
Collected via ARG, and returned as both **topology** and **flat endpoint list**:
- VNets and address spaces, subnets (NSG, route table, delegations, service endpoints, private endpoint policies), and peerings (state, gateway transit)
- NSGs and rules, with risk flags: inbound `Any`/`Internet`/`0.0.0.0/0` to management ports (22, 3389, 5985/6, 1433, 3306, 5432, 6379, 27017), allow-all rules, and rules that override defaults
- Public IPs (with the associated resource), NAT gateways, load balancers (frontends/rules), Application Gateways (WAF mode/policy, listeners, TLS policy), Front Door / CDN (WAF), Azure Firewall (policy, threat intel mode, SKU), and DDoS protection plans
- VPN / ExpressRoute gateways and connections, Virtual WAN/hubs, Bastion, and route tables (UDRs, 0.0.0.0/0 next hop)
- Private endpoints (target resource, subnet, private IP, connection state) and private DNS zones plus VNet links
- **`list_network_endpoints`**: every reachable address or FQDN with `exposure: public | private | restricted`. This covers public IPs, PaaS default hostnames (`*.azurewebsites.net`, `*.blob.core.windows.net`, `*.database.windows.net`, `*.vault.azure.net`, and so on), the effective public network access for each, and private endpoint IPs.

## 8. Policy, Defender and NIST

### 8.1 Policy
- `list_policy_assignments`: assignments that **apply to** the subscription, including those **inherited from management groups**. These are discoverable from compliance states even without MG read access. Includes parameters, enforcement mode, and exemptions.
- `get_policy_compliance`: per-assignment and per-initiative summaries, per-policy results, and non-compliant resources (paged). Uses ARG `policyresources` (`microsoft.policyinsights/policystates`) and Policy Insights `summarize`.

### 8.2 NIST SP 800-53 R5 detection (`get_nist_status`)
Detection runs through APIs in this order:
1. **Defender for Cloud regulatory compliance**: `securityresources` `microsoft.security/regulatorycompliancestandards` and the Security API `regulatoryComplianceStandards`. Is the NIST SP 800-53 R5 standard present, and what are its state and passed/failed/skipped control counts?
2. **Policy initiative assignment**: is the built-in *NIST SP 800-53 Rev. 5* initiative assigned at the subscription or an inherited MG scope? Initiative ID `179d1daa-458f-4e47-8086-2a68d0d6c38f`, to be verified during build; we match by ID *and* display name.
3. **Defender plans**: which Defender plans are enabled (pricing tiers), since coverage depends on them.

Returns `{ enabled: true|false, source: "defender|policy|both", assignmentScope, lastEvaluated, controlSummary, portalLinks }`.

### 8.3 NIST compliance detail
- `get_nist_controls`: for each control (for example `AC-2`, `SC-7`), returns status, passed/failed assessments, and failed resources. Filterable by family, control, or status.
- Resource-level view: for each resource, the failing NIST controls and their assessments.

### 8.4 Portal links (best effort, verified during build)
`{portal}` is the air-gap portal URL, discovered or configured (see §1a).
- Defender regulatory compliance dashboard: `{portal}/#view/Microsoft_Azure_Security/SecurityMenuBlade/~/22`
- Policy compliance for an assignment: `{portal}/#view/Microsoft_Azure_Policy/PolicyComplianceDetailedBlade/id/<url-encoded assignmentId>`
- Any resource: `{portal}/#@<tenant>/resource<resourceId>`
- Portal links are constructed in `src/links.ts`, and the blade path templates are configurable, so the formats can be corrected in one place.

### 8.5 NIST evidence package (`build_nist_evidence`)
Combines:
- Defender control status (authoritative when enabled)
- Policy compliance for NIST-mapped policies
- Scan evidence from analyzers, mapped via each finding's `nistControls[]`

Output JSON, grouped **by family then control**:
```json
{
  "standard": "NIST SP 800-53 Rev. 5",
  "defenderStandardEnabled": true,
  "families": [{
    "family": "SC", "name": "System and Communications Protection",
    "controls": [{
      "id": "SC-7", "title": "Boundary Protection",
      "defenderStatus": "failed", "failedAssessments": 3,
      "evidence":  [{ "checkId": "net.nsg.no-mgmt-from-internet", "status": "pass", "resourceCount": 14 }],
      "gaps":      [{ "checkId": "storage.public-network-access", "status": "fail", "resources": ["…"] }],
      "portalLinks": { }
    }]
  }],
  "tenantLevelNotes": ["MG policy hierarchy not readable by caller"]
}
```
Filterable by `families[]` / `controls[]` so the client can answer one specific NIST question cheaply.

## 9. Tenant-level (best effort)
`get_tenant_context` returns:
- the management group hierarchy (if readable)
- MG-scope policy assignments (if readable, otherwise inferred from inherited compliance)
- the subscription list and placement in the hierarchy
- role assignments at root or MG scope (if readable)

The response always includes `access.status`, so the client can say *"not visible to your account"* rather than *"not configured"*.

## 9a. Entra / Microsoft Graph identity posture (best effort)
`get_identity_posture` tries each check independently and reports it as `available`, `denied` (with the missing permission or role) or `unavailable` (Graph is not reachable in this cloud, or no OBO token could be obtained):

| Check | Graph API (the endpoint comes from the cloud profile) | NIST |
|---|---|---|
| Conditional Access policies (state, MFA requirement, legacy auth block, device and location conditions) | `/identity/conditionalAccess/policies` | AC-2, AC-7, IA-2 |
| Security defaults on/off | `/policies/identitySecurityDefaultsEnforcementPolicy` | IA-2 |
| MFA registration coverage | `/reports/authenticationMethods/userRegistrationDetails` | IA-2(1)(2) |
| Privileged directory roles and members (Global Admin count, and so on) | `/roleManagement/directory/roleAssignments` | AC-2, AC-6 |
| PIM eligible vs. active assignments | `/roleManagement/directory/roleEligibilitySchedules` | AC-2(7), AC-6 |
| Guest users count and settings | `/users?$filter=userType eq 'Guest'&$count=true`, `/policies/authorizationPolicy` | AC-2 |
| Authentication methods policy | `/policies/authenticationMethodsPolicy` | IA-2, IA-5 |

These results also feed `build_nist_evidence`. When a check is unavailable, the matching NIST controls include `"evidenceGap": "identity data not accessible"` instead of silently omitting it.

## 10. MCP tools (all read-only, all JSON)

| Tool | Purpose |
|---|---|
| `list_subscriptions` | Subscriptions visible to the user |
| `get_tenant_context` | MG hierarchy, MG-level policy and roles (best effort) |
| `get_identity_posture` | Entra identity posture via Graph: CA, MFA, PIM, directory roles (best effort) |
| `get_keyvault_item_metadata` | Secret/key/cert metadata and expiry findings, never values (best effort) |
| `list_resource_groups` | RGs in a subscription |
| `inventory_resources` | Counts by type, category, location, and RG. Paged list with filters |
| `get_resource_configuration` | Full config and analyzer findings for one resource |
| `get_service_findings` | Analyzer findings for a category (compute, storage, keyvault, database, …) |
| `inventory_network` | Network topology and NSG risk flags |
| `list_network_endpoints` | Flat public/private endpoint list |
| `list_role_assignments` | RBAC, with privileged-access flags |
| `list_policy_assignments` | Direct and inherited assignments, and exemptions |
| `get_policy_compliance` | Compliance summaries and non-compliant resources |
| `get_security_posture` | Secure score, Defender plans, and unhealthy assessments |
| `get_nist_status` | Is NIST 800-53 R5 enabled (Defender/Policy)? Control summary and links |
| `get_nist_controls` | Control-level and resource-level NIST compliance |
| `start_scan` | Starts a full subscription scan (async). Returns `scanId` |
| `get_scan_status` | Progress per collector |
| `get_scan_result` | Scan JSON, by section and paged |
| `build_nist_evidence` | NIST evidence package (from a `scanId` or live) |
| `run_resource_graph_query` | Raw read-only KQL (disabled by default) |

**Why the scan is async:** App Service has a ~230-second front-end request timeout, and full scans of large subscriptions can take longer. `start_scan` → `get_scan_status` → `get_scan_result` avoids that limit. MCP progress notifications are also sent when the client keeps the stream open.

**MCP prompts:** `nist_assessment`, `network_exposure_review`, `subscription_overview`.

## 11. Project structure
```
mcp-scanazure/
├─ src/
│  ├─ server.ts                # Express, routes, startup guards
│  ├─ config.ts                # zod-validated env
│  ├─ cloud/                   # cloudProfile.ts (discovery + overrides), capabilities.ts (probe), apiVersions.ts
│  ├─ links.ts                 # portal link builders
│  ├─ envelope.ts              # common JSON response shape
│  ├─ auth/                    # jwt.ts, middleware.ts, protectedResource.ts, credentialFactory.ts
│  ├─ mcp/                     # createServer.ts, tools/*.ts, prompts.ts, schemas/*.ts
│  ├─ azure/
│  │  ├─ resourceGraph.ts      # paging, throttling/backoff, batching by subscription
│  │  ├─ arm.ts                # generic GET with retry for enrichers
│  │  └─ queries/*.ts          # KQL per domain
│  ├─ collectors/              # inventory, network, policy, security, rbac, tenant, identity (Graph), keyvaultData
│  ├─ analyzers/               # generic.ts + per-type (compute, aks, appservice, keyvault, storage, sql, …)
│  ├─ nist/                    # standard detection, control mapping, evidence builder
│  └─ scan/                    # orchestrator.ts, store.ts (memory TTL + optional Blob)
├─ test/                       # vitest, ARG fixtures, analyzer tests, JWT tests, no-hard-coded-endpoint test
│  └─ spa-harness/             # cross-origin MSAL.js + MCP client test page
├─ cloud-profiles/             # azurecloud.json (test), airgap.json (prod, filled in-air-gap)
├─ infra/                      # Bicep: App Service plan/app, UAMI, App Insights, (optional) Storage
├─ scripts/register-entra-app.ps1
├─ azure.yaml                  # azd
├─ .env.example
└─ README.md
```

## 12. Configuration
| Variable | Description |
|---|---|
| `AUTH_MODE` | `obo` (default) \| `none` \| `arm-token` |
| `AZURE_CLOUD_PROFILE` | Path to `cloud-profile.json`, used as the static fallback for endpoints |
| `ARM_ENDPOINT` | Resource Manager URL for the target cloud (used for metadata discovery) |
| `ARM_AUDIENCE` | Overrides the ARM token audience/scope (otherwise discovered) |
| `AUTHORITY_HOST` | Overrides the Entra authority host (otherwise discovered) |
| `PORTAL_URL` | Overrides the portal base URL (otherwise discovered) |
| `API_VERSION_OVERRIDES` | JSON map of `provider/type` to API version |
| `NIST_INITIATIVE_IDS` / `NIST_STANDARD_NAME_PATTERN` | Overrides NIST initiative/standard matching |
| `HOST` / `PORT` | Listen address |
| `AZURE_TENANT_ID` | Single tenant |
| `ENTRA_SERVER_CLIENT_ID` | MCP API app registration, used as the inbound audience and OBO client |
| `ENTRA_RESOURCE_URI` | Public HTTPS resource URI advertised in OAuth protected-resource metadata |
| `ENTRA_ALLOWED_CLIENT_IDS` | Custom app client ID(s), checked against the `azp` claim |
| `ENTRA_CLIENT_SECRET` | Optional local OBO credential; omit on App Service to use its managed-identity FIC |
| `OBO_CREDENTIAL` | `fic` (MI federated) \| `secret` \| `certificate` |
| `MANAGED_IDENTITY_CLIENT_ID` | UAMI used for the FIC |
| `AZURE_CLIENT_SECRET` / `AZURE_CLIENT_CERTIFICATE_PATH` | Dev OBO credential |
| `PUBLIC_BASE_URL` | For protected-resource metadata |
| `ENABLE_RAW_KQL` | Default `false` |
| `SCAN_CACHE_TTL_MINUTES` | Default 60 |
| `SCAN_STORE` | `memory` \| `blob` |
| `ALLOW_UNAUTHENTICATED_REMOTE` | Safety override for `none` mode |
| `CORS_ALLOWED_ORIGINS` | Comma list of SPA origins (also used for `Origin` validation) |
| `GRAPH_ENDPOINT` | Overrides the Microsoft Graph endpoint (otherwise discovered) |
| `ENABLE_GRAPH` | Default `true`. Checks degrade to `unavailable` if Graph isn't reachable |
| `ENABLE_KEYVAULT_DATAPLANE` | Default `true` |
| `KEYVAULT_AUDIENCE` | Overrides the Key Vault token audience (otherwise discovered) |
| `KV_EXPIRY_WARN_DAYS` | Default 30 |

## 13. Security considerations
- Read-only calls only. The downstream scope is ARM `user_impersonation`, so the user's RBAC is the boundary.
- No token passthrough in production. OBO tokens are cached in memory per user and never logged.
- Tokens must come from the custom app: the `azp`/`appid` claim is checked against the allow-list.
- The scan store is isolated per user (`oid`): a user can't read another user's `scanId`.
- The server never reads secrets. There are no `listKeys` calls, no App Service `appsettings`/`connectionstrings`, and no Key Vault secret/key/cert values (Key Vault is **metadata list operations only**).
- Graph is **read-only** permissions only, and the Graph response is trimmed to the fields that are needed (no user PII beyond counts and privileged-role holders).
- CORS uses an exact origin allow-list and never uses credentials mode.
- `Origin` validation on `/mcp`, HTTPS only, per-user rate limits, ARG throttling backoff.
- App Insights telemetry without tokens or full resource payloads.

## 14. Build phases
| Phase | Deliverable | Done when |
|---|---|---|
| **1. Scaffold** | TS + Express + MCP Streamable HTTP (stateless), **CORS**, envelope, config, **cloud profile + endpoint discovery + capability probe**, `AUTH_MODE=none` | MCP Inspector *and* the SPA test harness (other origin) call `list_subscriptions` via `az login` in Azure Commercial |
| **2. Inventory core** | ARG helper (paging/throttling), `list_resource_groups`, `inventory_resources`, `get_resource_configuration`, generic analyzer | Full inventory of test subscription as JSON |
| **3. Network** | `inventory_network`, `list_network_endpoints`, NSG risk rules | Public/private endpoints correct against the portal |
| **4. Service analyzers** | Compute, containers, app platform, Key Vault, storage, databases, messaging, AI, backup. ARM enrichers. `get_service_findings` | Findings for every major type in the test subscription |
| **5. Policy / Defender / RBAC — complete** | `list_policy_assignments`, `get_policy_compliance`, `get_security_posture`, `list_role_assignments`, `get_tenant_context` | Inherited assignments shown, and partial access reported cleanly |
| **6. NIST — complete** | `get_nist_status`, `get_nist_controls`, control mapping, `build_nist_evidence`, portal links | Detects enabled/disabled correctly and evidence completeness limitations are explicit |
| **7. Scan orchestration — complete** | `start_scan` / `get_scan_status` / `get_scan_result`, progress, store | Large subscription scans complete without request timeouts; polling is authoritative |
| **8. Auth (OBO)** | JWT validation, `azp` allow-list, PRM endpoint, OBO + FIC (ARM, Key Vault, Graph tokens), app registration script | SPA works end-to-end in Commercial, and two users with different RBAC get different results |
| **8a. Best-effort data** | `get_keyvault_item_metadata`, `get_identity_posture`, and feeding both into NIST evidence | Denied/unreachable/unavailable are reported per check, and nothing fails hard |
| **9. Deploy** | Bicep + Azure CLI scripts (azd optional), UAMI + FIC, App Insights, HTTPS only, optional VNet integration (to reach private Key Vaults). Build from the internal npm mirror | Deployed and working in Commercial test, then in the air gap using `cloud-profiles/airgap.json` |
| **10. Hardening & docs** | Rate limits, tests, README, custom-app integration guide | Tests pass and docs are complete |

The `CredentialFactory` exists from Phase 1, so all collectors take a `TokenCredential` and OBO slots in without changes.

## 15. Testing
- **Unit:** analyzers and NIST mapping against ARG JSON fixtures, JWT validation with locally generated keys, auth-mode guards, envelope/schema conformance.
- **Local integration:** `AUTH_MODE=none` + `az login`, driven by MCP Inspector over HTTP.
- **Auth integration:** the custom app (or a small test script using MSAL) → OBO, with two users who have different RBAC.
- **Contract:** every tool's output is validated against its `outputSchema`.

## 16. Remaining open questions
These don't block phases 1–7. Answer them when convenient:
1. **Resource Graph in the air gap:** is it available, including `securityresources` and `policyresources`? The capability probe and ARM fallback cover this either way, but it affects scan speed.
2. **Custom SPA details:** client ID and origin URL(s), for the `azp` allow-list and CORS. Placeholders are used until provided.
3. **Air-gap cloud endpoints:** the output of `az cloud show` inside the air gap, to fill in `cloud-profiles/airgap.json` (runtime discovery also works if ARM `/metadata/endpoints` is reachable).

### Answered
- Runtime: Node 24 LTS (App Service, air gap and Commercial)
- Cloud: air-gapped Azure (like Gov). Testing happens in Azure Commercial
- Client: custom browser SPA with Entra, CORS required
- Tenancy: single tenant
- Build delivery: internal npm mirror
- Scan storage: in memory
- Graph identity posture: best effort, report when unavailable
- Key Vault data plane: metadata only, best effort
