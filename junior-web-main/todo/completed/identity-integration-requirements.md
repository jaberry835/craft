# Identity Integration Requirements

## Purpose

This document captures the next implementation slice for integrating user identity into Junior Workbench.

The goal is not just to add authentication headers. The goal is to make workspace access, staged changes, admin actions, and agent activity identity-aware end to end.

## Product Context

Junior Workbench already has some ownership-oriented structure in place:

- `WorkspaceSummary` includes `ownerId` on both the server and client types.
- `WorkspaceRegistry` and `LocalWorkspaceManager` already support owner-scoped list and resolve operations.
- Workspace routes already flow through a central Express app and a small set of runtime seams.

The current gap is that the request layer still behaves as a single hard-coded admin identity, and staged changes do not record who proposed or approved them.

## Goals

The identity integration round should make the system able to:

1. Resolve the current caller from each request instead of forcing all operations through `admin`.
2. Restrict workspace listing, access, creation, and mutation by identity.
3. Record who staged, approved, rejected, or auto-applied pending changes.
4. Separate normal workspace-scoped actions from admin-only actions.
5. Preserve the current local-development flow with a simple fallback identity when real auth is not configured.

## Non-Goals

The following are out of scope for this round unless they are needed to support the core ownership model:

- full RBAC policy authoring UI
- multi-tenant invitation and sharing workflows
- per-file ACLs inside a workspace
- external directory provisioning flows
- replacing the current agent loop or storage architecture

## Current State Summary

Current implementation strengths:

- `server/types.ts` and `src/types/workbench.ts` already model `ownerId` for workspaces.
- `server/services/workspaceRegistry.ts` already filters workspaces by owner and rejects mismatched owner access.
- `server/services/localWorkspaceManager.ts` already creates and updates workspaces with an `ownerId`.

Current limitations:

- `server/app.ts` resolves `requestIdentity()` to a hard-coded `{ userId: 'admin', displayName: 'Admin' }` for every request.
- Admin and workspace routes both rely on that same hard-coded identity and do not enforce authorization boundaries.
- `PendingChange` on both server and client only stores file and summary data, with no proposer, approver, or audit metadata.
- `ChangeManager` stages and approves changes without identity context.
- There is no middleware seam that extracts identity from headers, bearer tokens, or local-dev overrides.
- Tests cover owner-aware workspace summaries, but not authenticated access control behavior.

## Requirements

### 1. Request Identity Resolution Middleware

#### Why it matters

Identity has to enter the system at one well-defined seam. Without that, the rest of the ownership model is not trustworthy.

#### Requirements

Add request-scoped identity resolution in the Express layer that:

- extracts identity from a single middleware before route handlers run
- stores the resolved identity on the request context in a typed way
- supports a development fallback identity when auth is disabled locally
- cleanly distinguishes between unauthenticated and authenticated requests
- can later support Entra or another external identity provider without rewriting route logic

The middleware contract should expose at least:

- stable user ID
- display name
- optional tenant ID
- optional roles or capability flags
- authentication source for diagnostics

#### Acceptance criteria

- Route handlers no longer construct identity inline.
- Workspace and admin routes consume the same resolved request identity.
- Local development can still run without cloud auth by using an explicit fallback mode.

### 2. Workspace Access Enforcement

#### Why it matters

The registry already has owner-aware APIs, but the request path still collapses all callers into the same owner.

#### Requirements

Update workspace resolution and mutation flows so that:

- `GET /api/workspaces` only returns workspaces visible to the current identity
- `POST /api/workspaces` assigns the new workspace to the current identity unless an explicit admin flow says otherwise
- `PATCH /api/workspaces/:workspaceId` requires ownership or admin privileges
- workspace-scoped routes under `/api/workspaces/current/*` and `/api/workspaces/:workspaceId/*` resolve through the current identity
- requests for inaccessible workspaces return authorization-aware failures instead of generic not-found server errors when appropriate

This work should be centered around:

- `server/app.ts`
- `server/services/localWorkspaceManager.ts`
- `server/services/workspaceRegistry.ts`

#### Acceptance criteria

- A non-owner cannot resolve or mutate another user’s workspace through the API.
- Current-workspace resolution selects only from workspaces visible to the caller.
- Owner filtering behavior is covered by API tests, not only lower-level unit behavior.

### 3. Pending Change Ownership And Audit Metadata

#### Why it matters

Staged changes are the main review boundary in the product. They need actor metadata to support approval, audit, and future collaboration flows.

#### Requirements

Extend `PendingChange` so it can record at least:

- `createdByUserId`
- `createdByDisplayName`
- `approvedByUserId`
- `approvedByDisplayName`
- `approvedAt`
- `lastUpdatedAt` if staging the same path again replaces an earlier change
- optional `autoAppliedByUserId` or equivalent applied-by metadata when the loop applies changes directly

Update `ChangeManager` and any pending-change store implementations so that:

- staging requires identity context
- approval requires identity context
- undo or reject actions can record who performed them when an audit seam exists
- existing local and fallback stores remain backward compatible with older serialized data when possible

This work should touch at least:

- `server/types.ts`
- `src/types/workbench.ts`
- `server/services/changeManager.ts`
- pending-change store implementations under `server/services/`

#### Acceptance criteria

- New pending changes record who proposed them.
- Approved changes record who approved them and when.
- The client can display basic actor metadata for review flows.

### 4. Agent And Chat Identity Propagation

#### Why it matters

The agent loop performs writes on behalf of a human user. That identity must travel into the change-staging layer and session history.

#### Requirements

Propagate request identity through agent and chat entry points so that:

- `sendMessage` and related agent actions know which user initiated the run
- staged changes created by agent tools are attributed to that initiating user
- auto-apply mode records the user identity responsible for the action
- chat sessions can be partitioned or filtered by identity if a workspace is later shared

At minimum, introduce an explicit identity parameter through the server-side runtime seams instead of relying on hidden global state.

#### Acceptance criteria

- Agent-created pending changes include actor metadata.
- Auto-applied changes remain attributable to the initiating user.
- Session behavior does not regress for current single-user local development.

### 5. Admin Authorization Boundary

#### Why it matters

Admin surfaces should not automatically be reachable by any authenticated identity once real identity is added.

#### Requirements

Define and enforce an initial authorization rule for admin routes such as:

- only identities with an admin role or capability may access `/api/admin/*`
- only identities with an admin role or capability may mutate global configuration routes such as `/api/agents`, `/api/agent-connections`, and `/api/mcp-servers`
- non-admin identities receive a clear forbidden response
- diagnostics and configuration mutations that affect all workspaces remain separate from workspace-local settings

This can start with a minimal role flag in request identity and expand later.

The route split should be explicit in both implementation and documentation:

- admin-only pages and APIs: `/api/admin/*`, `/api/agents*`, `/api/agent-connections*`, `/api/mcp-servers*`
- regular-user workspace APIs: `/api/workspaces`, `/api/workspaces/current/*`, `/api/workspaces/:workspaceId/*`, `/api/chat/*`, `/api/agent/messages`, `/api/changes/*`
- regular users may manage workspace-local settings under `/api/workspaces/current/settings/*` and `/api/workspaces/:workspaceId/settings/*` for workspaces they can access
- regular users may read workspace-scoped shared catalogs under `/api/workspaces/current/shared/*` and `/api/workspaces/:workspaceId/shared/*`, but may not edit the admin-owned global catalog surfaces

The UI and API should follow the same rule:

- admin identities can view and edit admin pages
- regular users cannot view or edit admin pages
- regular users can view and edit only their allowed workspace pages and workspace-scoped settings

#### Acceptance criteria

- Admin endpoints are explicitly gated.
- Admin-only pages are hidden or blocked for non-admin identities, and direct API calls from regular users return `403`.
- Workspace-scoped settings remain available to normal users for their own workspaces.
- Authorization failures are distinguishable from authentication failures.

### 6. Local Development And Deployment Configuration

#### Why it matters

Identity work often stalls if local development becomes hard to run. The system needs a clear mode split between local fallback and deployed auth.

#### Requirements

Add configuration that makes the active identity mode explicit, such as:

- local fallback identity mode for development
- trusted header mode for reverse-proxy or platform-auth integration
- token-validation mode for direct authenticated requests in deployed environments

Document:

- which environment variables enable each mode
- what claims or headers are required
- what default behavior applies when identity is not configured

#### Acceptance criteria

- Developers can run the app locally without blocking on cloud identity setup.
- Deployed environments can disable fallback identity mode.
- Configuration behavior is documented in repo docs, not only in code.

### 7. Azure Entra Registration And Access Model

#### Why it matters

The application-level identity model needs matching Azure constructs. Without that, there is no reliable way to distinguish admins from regular users in production.

#### Requirements

Document and implement the Azure-side setup needed for deployed identity, including:

- one Microsoft Entra app registration for the Junior Workbench web application
- one corresponding enterprise application / service principal in the tenant
- redirect URIs and logout URIs for the deployed web app hostnames
- token configuration needed for the client and server to receive stable user identifiers, display names, tenant context, and role or group claims

The production identity model should explicitly define two user paths:

- admin users
- regular users

The Azure design should specify how those paths are represented. Preferred options are:

- Entra app roles such as `Junior.Admin` and `Junior.User`
- or Entra security groups mapped into application roles or trusted role claims

The document should state which model is the source of truth for authorization. The default recommendation for this project should be:

- use Entra app roles for application authorization decisions
- optionally use Entra groups for assignment management in larger tenants

The Azure setup spec should cover at least:

- who can sign in to the app
- who is assigned the admin path
- who is assigned the regular-user path
- how the app behaves when a signed-in user has neither assignment
- whether admin rights are tenant-global or limited to a known admin group or app-role assignment

The server-side request identity contract should be able to consume Azure-issued claims for:

- object ID or subject identifier as the stable user ID
- display name
- tenant ID
- app roles
- optional group IDs when group-based authorization is enabled

This work should align with the existing Azure deployment seams already used elsewhere in the repo:

- App Service or equivalent web host
- managed identity for server-to-Azure-resource access
- Entra-authenticated Azure OpenAI, Cosmos DB, Blob Storage, Key Vault, and optional Azure AI Search access where configured

#### Acceptance criteria

- The requirement document names the Azure resources and Entra constructs required for production identity.
- The authorization model clearly explains admin versus regular-user assignment.
- Production deployment guidance covers what Azure registration and tenant setup is required before the app can enforce roles.

### 8. Azure Authorization Mapping In The App

#### Why it matters

Azure can issue claims, but the application still needs deterministic rules for mapping those claims into allowed pages and APIs.

#### Requirements

Define a server-side authorization mapping such that:

- users with the admin app role or approved admin group assignment are treated as admins
- users with the regular-user app role or approved user group assignment are treated as normal workspace users
- users without either valid assignment are authenticated but unauthorized
- admin assignment grants access to admin pages and admin APIs
- regular-user assignment does not grant access to admin pages or admin APIs

The mapping should be explicit for both UI and API surfaces:

- admin access: admin pages plus `/api/admin/*`, `/api/agents*`, `/api/agent-connections*`, `/api/mcp-servers*`
- regular-user access: workspace pages plus `/api/workspaces*`, `/api/chat/*`, `/api/agent/messages`, `/api/changes/*`, and workspace-scoped settings routes for allowed workspaces

The spec should also define whether admins automatically retain regular-user workspace capabilities, which is the recommended default for this project.

#### Acceptance criteria

- The app has one documented claim-to-role mapping used by both server and client.
- A user with only the regular-user assignment cannot access admin pages or admin APIs.
- A user with no valid assignment receives an authorization failure instead of implicit fallback access.

### 9. Test Coverage For Identity Behavior

#### Why it matters

Access-control regressions are expensive and easy to miss if only the happy path is tested.

#### Requirements

Add focused tests for:

- workspace list filtering by identity
- workspace route rejection for non-owners
- admin route rejection for non-admin users
- change staging attribution and approval attribution
- local fallback identity mode versus explicit authenticated identity mode

Prefer behavior-level coverage in server smoke tests for the route layer, with narrower unit coverage only where it reduces setup cost.

#### Acceptance criteria

- Identity-aware behavior is covered by executable tests in `server/test/`.
- The existing build and server smoke suite remain green after the changes.

## Recommended Implementation Order

Recommended sequence for this work:

1. Add request identity middleware and typed request context.
2. Convert workspace route resolution to consume request identity from middleware.
3. Extend pending-change types and store contracts with actor metadata.
4. Thread identity through `ChangeManager`, agent entry points, and auto-apply flows.
5. Gate admin routes with a minimal authorization rule.
6. Add local and deployed configuration docs.
7. Add or expand server tests for the new behavior.

## Risks And Open Questions

- The product currently behaves like a single-owner local app in many flows, so identity changes may expose assumptions in client state and test harness helpers.
- If workspace sharing is planned soon, this round should avoid baking in a strict one-workspace-one-owner model that cannot evolve to collaborator access.
- Existing pending-change persistence formats may need migration or tolerant reads when new audit fields are added.
- The current API error handling returns generic 500 responses for many thrown errors; identity work will likely need explicit 401 and 403 handling to avoid hiding access-control failures.

## Definition Of Done

This work is complete when:

- request identity is resolved centrally instead of being hard-coded in routes
- workspace APIs enforce identity-aware access
- pending changes and approvals are attributable to users
- admin endpoints are gated separately from normal workspace actions
- local development still works with a documented fallback identity mode
- server-side tests cover the identity-sensitive behavior