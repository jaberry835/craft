# MCP, Azure AI Search, And Document Integration Remaining Requirements

## Status

This file now tracks only the remaining work for MCP, Azure AI Search, repository-linking, and document-preview integration.

The completed provenance foundation was moved to `todo/completed/mcp-ai-search-document-integration-requirements.md`.

## Deconfliction

This document no longer owns core agent-loop workflow improvements that are already tracked in `todo/agent-loop-document-workflow-plan.md`.

That separate plan owns:

- retrieval-pack construction before each turn
- loop memory and plan-step tracking
- staged review ergonomics for multi-file runs
- publish-readiness and document-validation behavior driven by the agent loop

This document now owns the external integration surface around that loop:

- MCP diagnostics and structured result metadata
- Azure AI Search index-shape guidance for external documents
- linked repository and external-content integration modes
- binary-document extraction and preview architecture
- linked-document evidence UX and security boundaries

## Current State Summary

Current implementation strengths:

- shared source-reference and provenance contracts exist on both server and client
- `server/services/groundingService.ts` maps workspace and Azure AI Search grounding into structured source references
- workspace-scoped and admin-scoped MCP configuration already exists
- `server/services/mcpHttpRuntime.ts` already discovers MCP tools and invokes remote MCP servers over HTTP
- the workbench already supports markdown preview and text-document uploads

Current limitations:

- MCP health, discovery, and error diagnostics are still too opaque for document workflows
- Azure AI Search grounding has richer metadata, but the document does not yet define the recommended index schema and review UX around it
- uploads and preview are still text-first and markdown-first rather than document-type-aware
- there is still no defined linked-versus-imported model for external repositories and other systems of record
- binary document extraction, normalization, preview routing, and retention/security behavior remain undefined

## Remaining Requirements

### 1. MCP Connectivity And Runtime Reliability

#### Why it matters

If MCP connectivity is unreliable or opaque, users will not trust external tools as part of the document workflow.

#### Requirements

Strengthen MCP integration so that the system can:

- validate MCP server connectivity before an agent run
- discover available tools and surface clear warnings when discovery fails
- show which workspace agents depend on which MCP servers
- capture timeout, auth, and schema errors in a user-readable way
- distinguish between configuration errors, authorization failures, and remote execution failures

Add a defined diagnostics path for MCP that includes at least:

- server reachability
- auth mode and missing secret detection
- tool discovery status
- last successful tool discovery or call timestamp
- source-system identity, such as repository host, document system, or line-of-business platform

#### Acceptance criteria

- Users can tell whether an MCP server is configured, reachable, and usable before attaching it to an agent.
- MCP discovery failures are actionable instead of generic runtime failures.
- Admin and workspace settings can display MCP health without requiring an agent run first.

### 2. Azure AI Search Index Shape And Evidence UX

#### Why it matters

The grounding contract is richer now, but the product still needs a clear index-shape recommendation and a user-facing evidence flow around that metadata.

#### Requirements

Document a recommended Azure AI Search index shape for document workflows that includes:

- a stable key per chunk or document
- parent document ID
- source URI or deep link
- path within repository or storage container
- title and display label
- text content and chunk text
- file extension or MIME type
- page, section, or chunk ordinal
- source system name
- source version or last indexed timestamp
- access-control filter fields when needed later

Define how the client should use the structured grounding metadata to:

- cite the source in agent output
- open the source document preview within Junior when available
- deep-link out to the original system of record
- show when provenance is weak rather than complete

#### Acceptance criteria

- Azure AI Search index requirements are documented for both retrieval quality and source traceability.
- The product has a clear plan for opening preview or outbound links from grounded evidence.
- Weakly attributable results are surfaced explicitly.

### 3. Integration With Existing Repositories And External Content Sources

#### Why it matters

Many real document sets already live in Git repos, SharePoint-like systems, storage accounts, or other systems of record. Junior needs a defined way to link to them.

#### Requirements

Define integration patterns for existing repositories and source systems, starting with a small supported set such as:

- existing Git repositories
- Azure DevOps repositories if needed by the team
- GitHub repositories where appropriate
- Azure Blob or Data Lake backed document collections
- MCP-backed enterprise content systems

The first slice does not need to clone every repo into the workspace. It must define supported modes such as:

- linked source mode, where Junior stores references and previews but leaves the source authoritative outside the workspace
- imported snapshot mode, where selected files are copied into the workspace for review and editing
- hybrid mode, where source references and imported working copies coexist

For repository integrations, the document should define:

- how a repo or branch is selected
- whether content is read directly, mirrored, or selectively imported
- how source revisions are tracked
- how linked content is refreshed
- how conflicts between imported content and source updates are surfaced

#### Acceptance criteria

- The requirement doc defines at least one supported path for existing repo integration.
- The product model distinguishes linked documents from imported workspace copies.
- Source revision and refresh behavior are documented.

### 4. Rich Document Preview In The Web Client

#### Why it matters

Document-first work requires users to inspect source material directly. Markdown-only preview is not enough.

#### Requirements

Add a document-preview architecture that supports at least:

- Markdown and plain text
- PDF preview
- Word document preview
- common image formats
- fallback preview or metadata display for unsupported file types

Preferred implementation options should be documented, for example:

- PDF.js or an equivalent browser PDF renderer for PDF files
- Mammoth.js or a similar converter for `.docx` to HTML preview when direct preview is acceptable
- Office or Microsoft 365 document viewers only when licensing, embedding, and auth constraints are understood
- server-side text extraction plus client-side fallback rendering when rich preview is unavailable

The preview system should support:

- inline preview in the workbench
- full-document open or expand behavior
- page navigation where applicable
- clear unsupported-file messaging
- preservation of source metadata and outbound links to the original document

#### Acceptance criteria

- PDF and Word documents have a documented preview path.
- Unsupported formats still show useful metadata and source links.
- Preview architecture is explicit about which formats are native, converted, embedded, or fallback-only.

### 5. Document Extraction, Normalization, And Indexing Pipeline

#### Why it matters

Preview and grounding depend on a common understanding of document content, especially for binary formats.

#### Requirements

Define a pipeline for document ingestion that can:

- detect document type
- extract previewable text where possible
- preserve original binary files when needed
- produce searchable text for Azure AI Search or workspace indexing
- track extraction failures and partial extraction states

For important enterprise formats, the requirements should define how to handle:

- PDF text extraction
- `.docx` content extraction
- spreadsheets and tabular docs when relevant
- scanned documents or OCR-dependent files

The pipeline should separate:

- original binary asset
- extracted text or normalized HTML preview
- indexable chunk text
- source metadata and link information

#### Acceptance criteria

- The system has a documented ingestion model for binary documents.
- Extracted text and preview artifacts are distinguishable from the source binary.
- Indexing failures do not silently hide source files from the user.

### 6. UX For Linked Documents And Evidence Review

#### Why it matters

Users need to understand whether they are viewing a local workspace document, a linked external document, or a grounded evidence snippet.

#### Requirements

The UI should distinguish at least:

- editable workspace files
- read-only linked source files
- search results and chunked evidence
- externally hosted source documents opened through preview or outbound links

Document review UX should support:

- seeing document type and source system
- opening previews without losing workbench context
- copying or opening original URLs
- seeing whether a package draft section cites source-backed evidence
- jumping from a grounded snippet to a broader document preview when possible

#### Acceptance criteria

- The workbench can show whether a document is local, linked, or externally hosted.
- Source-backed evidence is reviewable without digging through raw transcripts.
- Users can preview or open the original document from grounded results.

### 7. Security, Permissions, And Access Boundaries

#### Why it matters

External document integrations can easily bypass the intended access model if provenance and auth are not handled carefully.

#### Requirements

Ensure the integration design preserves access boundaries such that:

- MCP calls use only the secrets or identities explicitly configured for the workspace or admin scope
- Azure AI Search results do not expose documents the current user should not see once identity-aware access is added
- preview routes do not bypass authorization for linked documents
- outbound links to original systems do not imply access if the user is not authorized there
- cached previews or extracted text are handled according to the source system’s retention and security expectations

When possible, source systems should remain the authorization authority for externally linked content.

#### Acceptance criteria

- The design documents how linked-document preview respects source-system permissions.
- Search and MCP integrations do not assume unrestricted global access.
- Security implications of cached extracted content are called out.

### 8. Validation And Test Coverage

#### Why it matters

These integrations will fail in subtle ways if preview, provenance, and connector behavior are not covered with executable checks.

#### Requirements

Add focused validation for:

- Azure AI Search connector configuration and retrieval behavior beyond the completed provenance-mapping slice
- MCP server discovery and tool-call diagnostics
- source-reference mapping for MCP-backed results
- linked-repo import or reference behavior
- preview routing for PDF, Word, markdown, and unsupported files
- fallback behavior when preview or extraction is unavailable

Where practical, add smoke tests for:

- structured source references returned from MCP-backed integrations
- document preview selection logic in the client
- degradation behavior when external integrations fail or return incomplete metadata

#### Acceptance criteria

- The remaining feature set has executable coverage for the main integration and preview paths.
- Failures in external integration surfaces degrade clearly rather than silently.
- Provenance behavior is testable as additional source systems are added.

## Recommended Implementation Order

Recommended sequence for the remaining work:

1. Add MCP diagnostics and structured MCP result expectations.
2. Document Azure AI Search index-shape expectations and evidence-review flow.
3. Define linked-versus-imported integration for existing repositories.
4. Add document ingestion and preview architecture for PDF and Word files.
5. Wire UI review and preview flows to show source-backed evidence.
6. Add broader validation and test coverage for connectors, previews, and linked content.

## Risks And Open Questions

- Some source systems may not provide stable deep links, page anchors, or structured provenance without custom MCP tool design.
- PDF and Word preview quality will vary depending on whether the system uses browser-native rendering, client-side conversion, or server-side extraction.
- Search index schema changes may require coordinated reindexing and connector updates.
- External repo integration can blur the line between a linked authoritative source and an editable workspace copy if the product model is not explicit.
- Large binary documents may require preview size limits, caching rules, and asynchronous extraction flows.

## Definition Of Done

This remaining work is complete when:

- MCP integrations have documented, testable reliability and structured source-reference expectations
- Azure AI Search has documented index-shape and evidence-review guidance beyond the completed grounding-contract slice
- at least one supported external-repository integration pattern is defined
- PDF and Word preview paths are specified for the web client
- the workbench can distinguish local workspace files from linked external documents in the review UX
- validation and test requirements cover preview, linked content, and external integration degradation paths
