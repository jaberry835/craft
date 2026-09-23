# Azure Deployment Plan

> **Status:** Executing

Generated: 2026-07-30

## 1. Project Overview

**Goal:** Build a TypeScript service that exposes private REST and Streamable HTTP MCP interfaces, accepts one or more Markdown documents, generates React-rendered static HTML with folder-based navigation and a site-level classification bar, publishes many named public sites to Azure Storage, and maintains a public root catalog.

**Path:** New Project

## 2. Requirements

| Attribute | Value |
|-----------|-------|
| Classification | POC |
| Scale | Small |
| Budget | Cost-Optimized |
| Subscription | Jacks-ATU-Sub (`41c60df0-6ec9-4075-b369-c2fa7cbc1a1a`) — confirmed |
| Location | East US 2 — confirmed |
| Runtime constraint | No containers or Container Apps; deploy a complete Node.js package to App Service |
| Target constraint | Portable to an air-gapped Azure region with App Service and Storage |

## 3. Components Detected

The workspace was empty when planning began.

| Component | Type | Technology | Path |
|-----------|------|------------|------|
| Site Builder Service | API, MCP, bounded worker | Node.js LTS, TypeScript, Express, MCP TypeScript SDK v2 | `apps/service` |
| Application Core | Use cases and ports | TypeScript, Zod v4 | `packages/application` |
| Contracts | Input/output schemas | TypeScript, Zod v4 | `packages/contracts` |
| Static Generator | Markdown to HTML | React SSR, unified/remark/rehype | `packages/generator` |
| Storage Adapters | Durable jobs and publication | Azure Blob and Queue Storage SDKs | `packages/azure-adapters` |

## 4. Recipe Selection

**Selected:** AZD with Bicep

**Rationale:** `azd` provides repeatable application packaging and App Service deployment while Bicep declares the smallest portable Azure footprint. The application is deployed as a ZIP/package with production npm dependencies; it does not require Docker, ACR, Container Apps, or runtime package downloads.

## 5. Architecture

**Stack:** Azure App Service plus Azure Storage

The single App Service process hosts REST and MCP and runs a bounded queue consumer. Queue leases and durable Blob operation records make work restart-safe. The POC App Service plan is fixed to one instance so only one embedded worker competes for work.

### Service Mapping

| Component | Azure Service | SKU |
|-----------|---------------|-----|
| API/MCP/worker | Azure App Service for Linux | Basic B1, one always-on instance |
| Public sites and catalog | Azure Blob Storage static website | Standard LRS, StorageV2 |
| Staging, operations, jobs | Blob containers and Queue in the same Storage account | Hot tier |

### Supporting Services

| Service | Purpose |
|---------|---------|
| Log Analytics | Centralized platform logs with short POC retention |
| Application Insights | OpenTelemetry requests, dependencies, traces, and publish metrics |
| Managed Identity | App Service access to Blob and Queue data planes without account keys |

### Publication Flow

1. REST or MCP validates a manifest and Markdown documents.
2. The service stores immutable staged input and an operation record, then enqueues an operation ID.
3. The embedded worker receives the message, renders static HTML in an isolated temporary directory, and uploads an immutable version prefix.
4. The worker switches the stable site entry point and catalog only after all version files validate.
5. Operation status is durable and available through both REST and MCP.

## 6. Provisioning Limit Checklist

Quota checks ran against the confirmed subscription in `eastus2` with the Azure quota CLI on 2026-07-30.

| Resource Type | Number to Deploy | Total After Deployment | Limit/Quota | Notes |
|---------------|------------------|------------------------|-------------|-------|
| Microsoft.Web/serverfarms (B1) | 1 | 2 B1 instances | 32 B1 instances | Azure quota CLI `B1`; current usage 1 |
| Microsoft.Web/sites | 1 | 10 sites | B1 capacity available | Resource Graph current count 9; app runs on the new plan |
| Microsoft.Storage/storageAccounts | 1 | 6 | 250 | Azure quota CLI `StorageAccounts`; current usage 5 |
| Microsoft.Insights/components | 1 | 6 | Not constraining this deployment | Resource Graph current count 5 |
| Microsoft.OperationalInsights/workspaces | 1 | 3 | Not constraining this deployment | Resource Graph current count 2 |

**Status:** ✅ Selected resources are within limits. B1 total is 6.25% of quota; Storage total is 2.4% of quota.

## 7. Execution Checklist

### Phase 1: Planning
- [x] Analyze workspace
- [x] Gather requirements
- [x] Confirm subscription and location
- [x] Prepare resource inventory
- [x] Fetch quotas and validate capacity
- [x] Scan codebase
- [x] Select recipe
- [x] Plan architecture
- [x] User approved implementation and selected the App Service-only architecture

### Phase 2: Execution
- [x] Research MCP, App Service telemetry, Blob, Queue, identity, and Azure guidance
- [ ] Scaffold TypeScript workspace and dependency lockfile
- [ ] Implement contracts, generator, application core, adapters, REST, MCP, and worker
- [ ] Add local and automated tests
- [ ] Generate App Service Bicep, `azure.yaml`, and deployment packaging
- [ ] Apply managed-identity and network hardening
- [ ] Run functional verification
- [ ] Set status to `Ready for Validation`

### Phase 3: Validation
- [ ] Invoke the azure-validate workflow
- [ ] Validate build, tests, Bicep, RBAC, and preflight
- [ ] Populate validation proof and set status to `Validated`

### Phase 4: Deployment
- [ ] Invoke the azure-deploy workflow only after validation
- [ ] Report endpoint URLs and set status to `Deployed`

## 8. Validation Proof

| Check | Command Run | Result | Timestamp |
|-------|-------------|--------|-----------|
| Pending | Pending execution phase | Pending | Pending |

**Validated by:** Pending azure-validate workflow

## 9. Files to Generate

| File | Purpose | Status |
|------|---------|--------|
| `.azure/deployment-plan.md` | Source-of-truth plan | ✅ |
| `package.json` and `package-lock.json` | Reproducible npm workspace | ⏳ |
| `apps/service` | REST, MCP, health, telemetry, and bounded worker | ⏳ |
| `packages/*` | Contracts, generator, application, and adapters | ⏳ |
| `azure.yaml` | Azure Developer CLI deployment definition | ⏳ |
| `infra/main.bicep` | App Service, Storage, monitoring, identity, and RBAC | ⏳ |

## 10. Security and Portability Decisions

- App code uses managed identity in Azure and `DefaultAzureCredential` for local development.
- The public `$web` endpoint contains generated static content only. Staging, operations, and queues remain private.
- REST/MCP supports a private-network deployment posture. POC local development binds to loopback by default.
- Raw HTML, CSS, JavaScript, package names, templates, absolute paths, traversal, symlinks, and oversized input are rejected.
- Dependencies are pinned and packaged before deployment. Publishing never invokes npm or a frontend bundler.
- The implementation avoids Container Apps, ACR, Dapr, and other unavailable air-gap dependencies.

## 11. Next Steps

> Current: Application execution

1. Scaffold the workspace and implement a tested local vertical slice.
2. Add App Service infrastructure and package deployment configuration.
3. Validate locally and then run Azure preflight; do not deploy until validation succeeds.
