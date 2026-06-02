# Template Packaging And Catalog Requirements

## Purpose

This document defines the next requirements slice for turning templates into first-class packaged assets with a better admin authoring experience and a better end-user onboarding flow.

The goal is not only to keep a few shared template IDs in config. The goal is to let admins build, save, export, import, catalog, and present complete starter packages for different environments, especially air-gapped deployments.

## Product Context

Junior Workbench already has the early pieces of a template system:

- shared admin agent templates
- shared MCP catalog entries
- shared workspace templates
- workspace attachment and selective import of referenced resources

The current gap is that templates are still modeled more like lightweight references than fully portable packages. The admin workflow is config-heavy, and the user starter experience is still rough, especially at workspace creation time.

## Goals

The next round should make the template system able to:

1. Represent a reusable template as a portable package, not only a record in shared config.
2. Let admins create and edit templates through a dedicated authoring flow instead of piecing them together indirectly.
3. Export and import templates across environments, including air-gapped systems.
4. Support environment-specific template catalogs such as `Security Package Creation Tool` and `Analyst Assistant with Datasources`.
5. Give end users a polished catalog-driven getting-started experience instead of raw prompt-based setup.

## Non-Goals

The following are out of scope unless directly required by the portable-template model:

- a public marketplace
- cross-tenant template sharing service
- real-time synchronization between disconnected environments
- arbitrary execution of untrusted package install scripts
- full no-code workflow design for every template component

## Current State Summary

Current implementation strengths:

- `WorkspaceTemplateDefinition` already groups references to agent templates, MCP catalog entries, and connectors.
- workspace settings already support attaching a shared template and selectively importing referenced resources.
- shared admin config already distinguishes agent templates, MCP catalog, and workspace templates.

Current limitations:

- workspace templates are still thin references, not packaged bundles with complete portable contents.
- there is no first-class template authoring flow for admins.
- workspace creation still relies on `window.prompt` for name, description, and template selection.
- there is no export or import workflow for template bundles.
- there is no environment-aware template packaging story for air-gapped deployments.
- the user-facing catalog and starter experience is functional but rough.

## Requirements

### 1. First-Class Template Package Model

#### Why it matters

Air-gapped and environment-specific deployments require a portable unit that can move between systems without depending on live shared admin state.

#### Requirements

Define a template package model that can include:

- template metadata
- display name and description
- category and tags
- version
- environment compatibility metadata
- folder structure to seed a workspace
- starter files and package documents
- agent definitions or agent-template payloads
- model and search connector definitions
- MCP definitions or references
- workspace settings defaults
- optional preview assets such as screenshots, icons, or readme content

The package should distinguish between:

- package-owned assets that are fully portable
- environment-bound references that must be remapped during import
- secrets that must never be exported inside the package

The package format should support named starter experiences such as:

- `Security Package Creation Tool`
- `Analyst Assistant with Datasources`
- future environment-specific starter kits

#### Acceptance criteria

- Templates are modeled as portable packages rather than only shared config references.
- The package schema explicitly separates portable config from environment-bound values and secrets.
- A template package can represent folder structure, files, connections, MCP, and agents in one logical artifact.

### 2. Admin Template Authoring Experience

#### Why it matters

Admins need a coherent way to build and save templates. Piecing them together from multiple separate config screens is too rough.

#### Requirements

Add a dedicated admin authoring flow for templates that lets an admin:

- create a new template package from scratch
- duplicate an existing template package
- edit metadata, description, icon, and category
- choose included folder structures and starter files
- choose included agents, connections, MCP entries, and workspace defaults
- mark package elements as required, optional, or environment-mapped
- preview what a created workspace will look like before publishing the template

The authoring UX should treat the template as one editable package with sections, not as scattered unrelated admin records.

#### Acceptance criteria

- Admins have a single workflow for authoring and saving a template package.
- Template editing is package-centric rather than config-file-centric.
- Admins can preview package contents before publishing them to the catalog.

### 3. Export And Import For Air-Gapped Environments

#### Why it matters

This system is expected to run in air-gapped environments, so templates must be transferable without relying on a central hosted catalog.

#### Requirements

Support export and import of template packages such that:

- an admin can export a template package to a portable file or bundle
- an admin can import that package into another environment
- package validation runs before import is accepted
- import detects version conflicts, duplicate IDs, and missing dependencies
- secrets are excluded from export and must be re-entered or remapped in the target environment

The import flow should support:

- direct import of a single package
- import of a small curated bundle of packages for a full environment bootstrap
- dependency or compatibility reporting before activation

The export/import story should explicitly support disconnected workflows such as:

- export from a connected build environment
- move package file through approved transfer process
- import into an air-gapped environment

#### Acceptance criteria

- Templates can be exported and imported as portable bundles.
- Imports validate package shape and compatibility before activation.
- Secrets and environment-only values are not silently embedded in exports.

### 4. Environment-Specific Mapping And Rebinding

#### Why it matters

Templates will differ per environment. A package must survive moving between environments even when endpoints, models, or MCP servers differ.

#### Requirements

Define a rebinding model for environment-specific values such as:

- Azure OpenAI endpoints and deployments
- Azure AI Search connectors and indexes
- MCP endpoints and audiences
- repository connectors
- document-system integrations
- branding or environment-specific labels

The import experience should allow admins to:

- keep package-owned defaults when valid
- map imported references to existing environment resources
- create replacement resources during import when needed
- flag unresolved bindings before a package can be published for end users

The package metadata should be able to express:

- required capabilities
- optional integrations
- environment mappings still required
- unsupported target environments

#### Acceptance criteria

- The package model supports portable templates across different environments.
- Environment-specific values can be rebound during import instead of hard-coded into the package.
- Unresolved mappings are visible and block broken template activation.

### 5. Catalog Experience For End Users

#### Why it matters

The current getting-started flow is too rough. Users need a clear catalog experience to choose a starter package quickly.

#### Requirements

Replace prompt-style workspace creation with a catalog-driven experience that includes:

- a modal, drawer, or dedicated catalog page for starter templates
- search and filtering by category, tags, and use case
- curated cards for major starter packages
- clear descriptions of what each package includes
- visual indicators for included agents, datasources, MCP integrations, and starter documents
- a preview of the resulting workspace structure and capabilities

The catalog should prioritize common starter kits such as:

- `Security Package Creation Tool`
- `Analyst Assistant with Datasources`
- other environment-local starter packages

The experience should help the user answer:

- what this template is for
- what content and integrations it includes
- what data sources or prerequisites it depends on
- whether it is editable, linked, or locked down by admin policy

#### Acceptance criteria

- Users can create a workspace from a browsable catalog instead of entering raw template IDs.
- Template cards explain included capabilities before a workspace is created.
- The create-workspace flow is materially better than the current prompt-based flow.

### 6. Template Package Contents And Seeding Behavior

#### Why it matters

A package must produce a predictable workspace, not just attach metadata.

#### Requirements

Define seeding behavior for package contents such that a template can create:

- folders
- starter files
- package-document scaffolds
- workspace-local agents derived from template definitions
- workspace-local connector definitions
- workspace-local MCP definitions or shared references
- starter prompts, instructions, and workflow guides

The model should distinguish:

- items copied into the workspace at creation time
- items linked to shared admin-managed definitions
- items optionally imported later

The seeding flow should support:

- full create-from-template
- selective import into an existing workspace
- re-apply or upgrade flows where supported later

#### Acceptance criteria

- The package model defines what is copied, linked, or optionally imported.
- Workspace creation from a package results in predictable seeded contents.
- Selective import remains available, but it is framed as part of the package lifecycle rather than a one-off checklist.

### 7. Catalog Storage, Versioning, And Lifecycle

#### Why it matters

As templates become portable products, the system needs a lifecycle model beyond static JSON files.

#### Requirements

Define how template packages are stored and versioned, including:

- draft versus published state
- package version numbers
- changelog or release notes metadata
- deprecated or archived state
- active versus hidden catalog visibility
- environment-local catalog membership

The system should support:

- retaining multiple template versions
- choosing which version is currently published in an environment
- showing users when a package has been updated
- keeping older workspaces associated with the template version they were created from

#### Acceptance criteria

- Template packages have a lifecycle beyond a single mutable record.
- Published catalog visibility is distinct from draft authoring state.
- Workspaces can retain knowledge of which template package and version they were created from.

### 8. Admin Governance And Safety

#### Why it matters

Templates can create broad environment impact by seeding agents, connectors, and MCP integrations. Admin controls need to be deliberate.

#### Requirements

Define governance for template packages such that:

- only admins can author, publish, export, import, or retire shared template packages
- template packages can require review before publish if desired later
- imported packages are validated before becoming visible in the catalog
- packages cannot embed secrets or unsafe environment-specific credentials
- admins can mark templates as approved for specific environments or user cohorts

The package model should also support policy markers such as:

- approved for production
- internal only
- requires datasource setup
- requires admin configuration before use

#### Acceptance criteria

- Shared template package lifecycle is admin-controlled.
- Sensitive values are explicitly excluded or scrubbed from portable package exports.
- The catalog can communicate governance or readiness status to users.

### 9. Better Starter Guidance And Onboarding

#### Why it matters

The catalog should not be a bare list. It should help new users understand how to get started successfully.

#### Requirements

Each published template package should support onboarding content such as:

- summary of intended use
- included agents and integrations
- prerequisites
- post-create next steps
- sample tasks or prompts
- support notes for air-gapped or environment-specific limitations

The catalog or starter flow should allow:

- quick start from a recommended template
- deeper review before creation
- a follow-up checklist after workspace creation

#### Acceptance criteria

- Published templates can carry onboarding guidance, not just raw config.
- Users receive useful starter context immediately after choosing a template.
- The getting-started experience is oriented around common tasks, not internal IDs.

### 10. Validation And Test Coverage

#### Why it matters

Portable package import/export and catalog-driven creation will break in subtle ways without validation.

#### Requirements

Add validation coverage for:

- template package schema validation
- export package completeness and secret exclusion
- import conflict detection and environment rebinding
- workspace creation from package contents
- selective import into existing workspaces
- catalog visibility and published-state behavior
- template version tracking

Where practical, add executable tests for:

- packaging and unpackaging flows
- environment mapping behavior
- create-workspace from catalog behavior
- admin authoring state transitions

#### Acceptance criteria

- Portable template package behavior is covered by executable tests.
- Broken imports fail clearly and safely.
- Catalog-driven workspace creation remains testable as the UX improves.

## Recommended Implementation Order

Recommended sequence for this work:

1. Define the first-class template package schema and lifecycle.
2. Define export/import behavior and environment rebinding rules.
3. Add admin authoring flows for package creation and publishing.
4. Add catalog-driven create-workspace UX for users.
5. Add package seeding behavior for files, agents, connectors, and MCP.
6. Add onboarding, versioning, and governance metadata.
7. Add validation and test coverage for packaging and catalog flows.

## Risks And Open Questions

- Environment portability will be limited if templates rely too heavily on live environment-specific resource IDs.
- Importing packages across air-gapped systems may require careful handling of icons, preview assets, and large starter content.
- The system must avoid conflating a published template package with the mutable admin config records that may have helped author it.
- Upgrade behavior for existing workspaces created from older template versions should remain explicit to avoid surprise mutations.
- The UI may need a dedicated catalog surface rather than continuing to stretch the existing config drawer.

## Definition Of Done

This work is complete when:

- templates are modeled as portable packages rather than only lightweight shared references
- admins can author, save, publish, export, and import template packages
- package exports support air-gapped transfer without embedding secrets
- users can choose from a polished starter catalog instead of prompt-based template selection
- package contents can seed folders, files, connections, MCP, and agents predictably
- template versioning, visibility, and validation requirements are documented and testable