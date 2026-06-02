# Junior Workbench Identity Setup

This document covers the current identity model for Junior Workbench, the Microsoft Entra application setup needed for deployed environments, and the environment variables that control local fallback versus deployed authorization.

## Current Implementation Slice

The current implementation supports three explicit identity modes:

- `entra-msal`: the preferred deployed mode. The browser signs in with Microsoft Entra through MSAL and calls the API with bearer tokens.
- `local-fallback`: local development mode that injects a configured fallback identity into every request.
- `trusted-header`: optional deployed integration mode where an upstream auth layer or reverse proxy passes user claims to the app in trusted headers.

Current authorization behavior:

- workspace APIs resolve the current caller from middleware and only return or mutate workspaces owned by that caller
- admin APIs require an admin role
- requests without a resolved identity receive `401`
- authenticated users without the required role or workspace ownership receive `403`

<<<<<<< HEAD
The preferred deployed path is Microsoft Entra sign-in in the browser with MSAL, plus bearer-token validation in the Node API. Trusted-header mode remains available for environments that already centralize auth at the hosting edge.

## Local Development

Local development stays unblocked by using fallback identity mode.

Default environment variables:

```bash
JUNIOR_IDENTITY_MODE=local-fallback
JUNIOR_IDENTITY_FALLBACK_USER_ID=admin
JUNIOR_IDENTITY_FALLBACK_DISPLAY_NAME=Admin
JUNIOR_IDENTITY_FALLBACK_ROLES=Junior.Admin,Junior.User
JUNIOR_ADMIN_ROLES=admin,Junior.Admin
```

Recommended local flows:

- keep the default admin fallback while building the app end to end
- switch the fallback roles to `Junior.User` when testing non-admin UI and API behavior
- switch to `entra-msal` when you want to exercise the real Microsoft Entra sign-in flow
- switch to `trusted-header` only when you intentionally want to test an upstream-auth deployment shape

Example non-admin local session:

```bash
JUNIOR_IDENTITY_MODE=local-fallback
JUNIOR_IDENTITY_FALLBACK_USER_ID=alice
JUNIOR_IDENTITY_FALLBACK_DISPLAY_NAME=Alice Example
JUNIOR_IDENTITY_FALLBACK_ROLES=Junior.User
```

## Entra MSAL Mode

When `JUNIOR_IDENTITY_MODE=entra-msal`, the browser signs in with Microsoft Entra and the API validates bearer tokens on every request.

Required environment variables:

- `JUNIOR_ENTRA_TENANT_ID`
- `JUNIOR_ENTRA_CLIENT_ID`
- `JUNIOR_ENTRA_API_AUDIENCE`
- `JUNIOR_ENTRA_SCOPES`
- optional `JUNIOR_ENTRA_AUTHORITY`
- optional `JUNIOR_ENTRA_REDIRECT_URI`
- optional `JUNIOR_ENTRA_POST_LOGOUT_REDIRECT_URI`

Recommended values:

- `JUNIOR_ENTRA_API_AUDIENCE=api://<entra-app-client-id>`
- `JUNIOR_ENTRA_SCOPES=api://<entra-app-client-id>/Junior.Workbench.Access`
- `JUNIOR_ENTRA_AUTHORITY=https://login.microsoftonline.com/<tenant-id>`

The Entra app registration should expose a delegated scope named `Junior.Workbench.Access` and app roles named `Junior.Admin` and `Junior.User`.
## Trusted Header Mode

When `JUNIOR_IDENTITY_MODE=trusted-header`, the app requires an upstream component to pass these headers on every authenticated request:

- `x-junior-user-id`: stable user identifier, preferably Entra object ID or app-specific subject ID
- `x-junior-display-name`: display name for diagnostics and review UI
- `x-junior-tenant-id`: optional tenant ID
- `x-junior-roles`: comma-separated application roles such as `Junior.Admin,Junior.User`

Only enable this mode when the app is behind a trusted proxy, App Service auth layer, or gateway that strips any client-supplied versions of these headers before forwarding the request.

## Microsoft Entra App Setup

The recommended production model is a single Microsoft Entra app registration for Junior Workbench, with one delegated API scope for the SPA-to-API call path and app roles used as the source of truth for authorization.

For a narrated PowerShell walkthrough that creates or updates the registration and enterprise application for you, use:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/bootstrap-azure-identity.ps1 \
	-DisplayName 'Junior Workbench' \
	-RedirectUris 'http://localhost:5173','https://your-app.azurewebsites.net/' \
	-LogoutUrls 'https://your-app.azurewebsites.net/.auth/logout' \
	-IdentifierUris 'api://<your-app-client-id>' \
	-AdminPrincipalObjectIds '00000000-0000-0000-0000-000000000001' \
	-UserPrincipalObjectIds '00000000-0000-0000-0000-000000000002'
```

Or through npm:

```powershell
npm run azure:bootstrap-identity:pwsh -- \
  -DisplayName 'Junior Workbench' \
  -RedirectUris 'http://localhost:5173','https://your-app.azurewebsites.net/.auth/login/aad/callback'
```

The script prints each step as it runs, including:

- checking Azure CLI login context
- creating or reusing the app registration
- configuring redirect URIs and logout URL
- creating the `Junior.Workbench.Access` delegated API scope
- creating the `Junior.Admin` and `Junior.User` app roles
- creating the enterprise application in the tenant
- optionally assigning known Entra principal object IDs to those roles
- starting `az login --use-device-code` automatically when there is no active Azure CLI session
- printing the client ID and tenant ID you need for the remaining Azure setup

Important scope note:

- the script creates and updates the `Junior.Workbench.Access` delegated API scope on the Entra application
- the script creates and updates app roles on the Entra application
- the script can assign existing users or existing groups to those roles when you pass their Entra object IDs
- the script does not create Entra groups; group creation stays separate by design

Optional role assignment parameters:

- `-AdminPrincipalObjectIds <id1>,<id2>`
- `-UserPrincipalObjectIds <id1>,<id2>`

Those object IDs can be users or groups in Entra. If you omit them, the script still completes the registration work and then tells you which manual assignment step is left.

Create these Azure resources:

1. One app registration for Junior Workbench.
2. One enterprise application created from that app registration in the target tenant.
3. One browser client flow that signs users in with MSAL and requests the `Junior.Workbench.Access` delegated scope.
4. Optionally, one App Service, reverse proxy, or gateway integration if you prefer trusted-header mode instead of bearer-token validation.
3. One browser client flow that signs users in with MSAL and requests the `Junior.Workbench.Access` delegated scope.
4. Optionally, one App Service, reverse proxy, or gateway integration if you prefer trusted-header mode instead of bearer-token validation.

### App Registration Configuration

Configure the app registration with these basics:

- Supported account type: the tenant scope you intend to support, usually single-tenant for internal deployments.
- Redirect URIs: the deployed web hostnames and any local dev hostname you use for interactive sign-in at the edge.
- Logout URL: the deployed site logout return URL if your auth layer supports front-channel sign-out.

Recommended redirect URIs:

- `http://localhost:5173`
- `https://<your-app-host>/`
- any auth callback path required by your edge auth product if it differs from the site root

### Token And Claim Configuration

Make sure the token or trusted-edge integration can provide these claims:

- stable user ID: Entra object ID (`oid`) or another stable subject identifier
- display name: `name`
- tenant ID: `tid`
- application roles: `roles`
- optional group IDs: `groups` only if you choose a group-based admin overlay

### App Roles

Define these app roles on the app registration:

- `Junior.Admin`
- `Junior.User`

Recommended behavior:

- assign `Junior.User` to every normal user who should access workspaces
- assign `Junior.Admin` to administrators
- let admins keep normal workspace capabilities as well
- deny access when an authenticated user has neither role

App roles should be the primary authorization source in the application. If a tenant prefers managing access through Entra groups, use groups only as an assignment convenience layer and map them into the same app-role outcome before the request reaches Junior Workbench.

## Authorization Mapping In Junior Workbench

The current application rule set is:

- `Junior.Admin` or `admin`: may access admin pages and admin APIs
- `Junior.User`: may access workspace pages and workspace APIs for owned workspaces
- no valid role: authenticated but unauthorized

Admin-protected APIs currently include:

- `/api/admin/*`
- `/api/agents*`
- `/api/agent-connections*`
- `/api/mcp-servers*`

Workspace APIs remain identity-scoped:

- `/api/workspaces*`
- `/api/chat/*`
- `/api/agent/messages`
- `/api/changes/*`

## Cosmos Access Boundary

The current Cosmos access model is server-mediated, not direct end-user Cosmos data-plane authorization.

- The browser never talks directly to Cosmos DB.
- The API uses its configured server-side credential to read and write Cosmos-backed state.
- Authorization is enforced in the application layer by resolved request identity plus workspace ownership checks.
- Chat sessions, pending changes, and workspace state documents are partitioned by `ownerId:workspaceId`, so the API only queries the signed-in user's partition for those workspace-scoped stores.
- Shared admin catalogs are intentionally global and are exposed only through admin-protected APIs.
- Workspace metadata is still stored in a shared catalog document, so metadata isolation is currently enforced by application filtering rather than by Cosmos-native per-user partitions for that container.

## Deployment Notes

For deployed environments, keep these constraints in mind:

- disable fallback mode by setting `JUNIOR_IDENTITY_MODE=entra-msal`
- configure the browser client with the Entra app registration values and delegated scope
- keep `trusted-header` only for deployments that intentionally want hosting-edge auth instead of API bearer-token validation
- if you use trusted-header mode, configure the upstream auth layer to strip client-supplied identity headers and inject trusted values from Entra claims
- keep admin role assignment tenant-global unless you intentionally scope it through a dedicated admin group or explicit app-role assignment process
- combine this with the existing Azure resource permissions already documented for Blob Storage, Cosmos DB, Key Vault, Azure OpenAI, and Azure AI Search

## Next Identity Steps

The next round after this setup should add:

- pending-change proposer and approver attribution
- identity propagation through chat sessions and agent-created change records
- client-side identity-aware page gating that mirrors the server-side authorization rules