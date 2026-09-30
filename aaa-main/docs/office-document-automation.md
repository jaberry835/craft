# Office Document Automation Architecture Decision

- **Status:** Accepted
- **Date:** 2026-09-30
- **Decision owners:** AAA maintainers and high-side document workflow owners

## Decision

Build Word and Excel manipulation as a separate, locally deployable Streamable HTTP MCP server.
Keep orchestration, project access control, knowledge provenance, review state, and file lifecycle in
AAA.

Do not embed Word/Excel libraries or document-format-specific tools directly in the AAA server.
Do not make Markdown and Word two independently edited sources of truth.

For narrative documents:

- Markdown is the canonical, reviewable content source.
- DOCX is a generated or template-filled delivery artifact.
- A document manifest binds the Markdown source, knowledge references, template, generated DOCX,
  hashes, and generator version.

For spreadsheet-centered deliverables:

- Structured JSON, YAML, or CSV is the canonical data source when the workbook is generated.
- XLSX is the presentation, calculation, and interchange artifact.
- When an externally supplied workbook is itself the required template, the original XLSX is an
  immutable input and updates are applied to a new output copy through named tables, named ranges,
  or an explicit mapping.

Human edits made directly in DOCX or XLSX are imported as proposed changes and reconciled into the
canonical source. They are not silently synchronized in both directions.

## Why this is the right boundary

### 1. Office formats are a specialized trust boundary

DOCX and XLSX are ZIP packages containing interrelated XML parts, relationships, embedded objects,
external links, formulas, and potentially active content. Safe handling requires format-specific
validation, resource limits, package traversal protection, and a deliberate policy for macros and
external content.

Putting that parser and renderer inside AAA would expand the core application's dependency,
patching, and attack surface for every deployment, including installations that never automate
Office documents.

### 2. The release cycles are different

AAA's core responsibilities are project isolation, agent orchestration, knowledge-backed content,
human review, and controlled integration. Office fidelity work has a separate lifecycle:

- template-specific mappings;
- Open XML compatibility;
- Word and Excel rendering differences;
- formula and chart preservation;
- optional PDF conversion;
- organization-specific document conventions.

An MCP service can be independently tested, versioned, replaced, and approved without coupling its
release to the AAA server.

### 3. High-side deployment remains supported

The MCP service must run locally or inside the same approved high-side boundary. It does not require
Microsoft Graph, Office Online, or internet access. AAA already supports authenticated Streamable
HTTP MCP servers and can continue unrelated work when a configured MCP service is unavailable.

### 4. The model should request document operations, not manipulate package XML

The MCP service exposes high-level operations such as "fill these content controls" or "update this
named table." The model never edits XML parts, constructs ZIP packages, executes macros, or receives
raw credentials.

### 5. This preserves optionality

The first implementation can use the Open XML SDK in a .NET sidecar on Windows. A future
implementation could use another safe library or platform without changing AAA's document workflow
or canonical-source rules.

## Why not implement it as built-in AAA tools

Embedding Office support in AAA appears convenient because project files are already available to
the agent. It is not the better long-term design:

- Office dependencies would be installed and patched with the core application.
- Format failures could destabilize chat and project operations.
- The core would need Word/Excel-specific APIs, validation, and configuration.
- Optional native dependencies would complicate offline packaging.
- Template-specific operations would accumulate in the general-purpose tool surface.
- Security review could not isolate the higher-risk document parser from the project orchestrator.

AAA may later provide UI actions such as **Generate Word** or **Fill workbook**, but those actions
should invoke the MCP service through the same controlled contract rather than introduce a second
implementation.

## Existing capability and prerequisite gap

AAA already supports the output half of this design:

- HTTP MCP tool discovery and calls;
- authenticated MCP connections;
- embedded binary file results and resource links;
- validated project-file storage without overwriting existing files;
- run records and changed-file reporting.

The missing prerequisite is binary input handoff. The current `aaa-file:` argument expansion reads
UTF-8 text for MCP calls. It cannot safely send an uploaded DOCX or XLSX to a document service.

Before the Office MCP tools are integrated, add a generic binary project-file broker to AAA with
these properties:

1. The model supplies only a project-relative file reference.
2. AAA resolves and validates the path inside the active project.
3. AAA enforces extension, size, access, and symlink/path-boundary rules.
4. AAA calculates the input hash and supplies bytes, name, MIME type, and hash to the MCP call.
5. The MCP service never receives an arbitrary host filesystem path.
6. The model never receives or constructs base64 data.
7. Returned files continue through the existing MCP binary-result pipeline.
8. Every input and output hash is recorded in the run or document manifest.

A portable tool payload can use this shape after AAA resolves the project reference:

```json
{
  "name": "system-security-plan.docx",
  "mimeType": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "sha256": "…",
  "dataBase64": "…"
}
```

The model-facing argument should remain a path-like project reference, not this expanded payload.
Expansion is an AAA harness responsibility.

Do not solve the input gap by giving the MCP service an unrestricted workspace root or by accepting
absolute paths from the model.

## Canonical document model

### Narrative document pair

Recommended layout:

```text
documents/
  system-security-plan/
    system-security-plan.md
    system-security-plan.docx
    document-manifest.json
    templates/
      system-security-plan-template.docx
```

The Markdown source contains the narrative and stable knowledge references. The DOCX contains the
approved presentation and template structure. The manifest records how they relate.

Example manifest:

```json
{
  "schemaVersion": 1,
  "documentId": "system-security-plan",
  "canonicalSource": "system-security-plan.md",
  "template": "templates/system-security-plan-template.docx",
  "outputs": [
    {
      "path": "system-security-plan.docx",
      "format": "docx",
      "sourceSha256": "…",
      "templateSha256": "…",
      "outputSha256": "…",
      "generator": "aaa-office-mcp",
      "generatorVersion": "…",
      "generatedAt": "…"
    }
  ],
  "knowledgeReferences": [
    {
      "id": "KB-AC2-001",
      "source": "knowledge/control-implementation.md",
      "sourceSha256": "…"
    }
  ]
}
```

### Spreadsheet deliverable

Recommended generated-workbook layout:

```text
documents/
  control-matrix/
    control-matrix-data.json
    control-matrix.xlsx
    document-manifest.json
    templates/
      control-matrix-template.xlsx
```

For an externally mandated workbook, retain the uploaded original:

```text
documents/
  poam/
    input/
      agency-poam-template.xlsx
    mappings/
      agency-poam-mapping.json
    output/
      agency-poam-filled.xlsx
    document-manifest.json
```

Never overwrite the uploaded original.

## Knowledge references and provenance

Document text must remain traceable to project knowledge and evidence.

Use stable reference IDs rather than relying only on display text or filenames. A reference should
identify:

- stable reference ID;
- project-relative source path or approved knowledge URI;
- source revision or SHA-256;
- optional section, heading, page, range, or record locator;
- retrieval or verification time when the source is external;
- human-review state where applicable.

Markdown should carry readable citations or reference IDs. The Office MCP service maps them into the
organization's required DOCX representation, such as footnotes, endnotes, a references table, or
content controls. For XLSX, provenance can be represented in dedicated columns, comments, a hidden
metadata sheet, or the external manifest according to policy.

Generation must fail explicitly when a required reference cannot be resolved. It must not emit a
successful-looking document with missing citations.

## MCP service responsibilities

The Office MCP service owns:

- parsing and validating DOCX/XLSX packages;
- inspecting document structure;
- extracting content into a normalized representation;
- filling content controls, bookmarks, named ranges, and named tables;
- creating DOCX from canonical Markdown and an approved template;
- creating XLSX from canonical structured data and an approved template;
- preserving supported styles, headers, footers, numbering, formulas, charts, and relationships;
- producing a new output file rather than overwriting the input;
- calculating hashes and returning structured warnings;
- validating the output package before returning it;
- returning DOCX/XLSX bytes through MCP file content or a resource link;
- reporting unsupported or lossy features explicitly.

AAA owns:

- project and user authorization;
- safe project-relative input resolution;
- knowledge retrieval and grounding;
- binary handoff to the MCP service;
- output storage and collision-safe naming;
- human review and approval workflow;
- run history, changed-file tracking, and error presentation;
- publication or external handoff through separately approved integrations.

## Initial MCP tool contract

Start with a small, high-level tool surface.

### Inspection and extraction

- `inspect_docx`
  - returns content controls, bookmarks, headings, tables, headers/footers, links, embedded objects,
    tracked changes, and warnings;
- `extract_docx`
  - returns normalized Markdown plus a structure/provenance map;
- `inspect_xlsx`
  - returns sheets, named ranges, named tables, dimensions, formulas, external links, and warnings;
- `extract_xlsx`
  - returns selected named ranges/tables as structured JSON or CSV.

### Deterministic updates

- `render_docx`
  - accepts canonical Markdown, template bytes, knowledge-reference metadata, and output options;
- `fill_docx_fields`
  - updates named content controls or bookmarks from a typed value map;
- `fill_xlsx_ranges`
  - updates named ranges or explicitly mapped cells;
- `fill_xlsx_tables`
  - replaces or appends typed rows in a named table;
- `validate_office_document`
  - validates package structure, required fields, links, formulas, references, and policy.

Avoid a general `edit_office_xml` tool. Avoid arbitrary formula execution or VBA execution.

Every mutating tool returns:

- output file;
- input and output hashes;
- operations performed;
- warnings and unsupported features;
- validation result;
- optional normalized extraction for comparison.

## Security and data-handling requirements

The initial implementation must:

- support `.docx` and `.xlsx`;
- reject macro-enabled `.docm`, `.dotm`, `.xlsm`, `.xltm`, and binary `.doc`, `.xls` inputs until a
  separate policy and implementation are approved;
- never execute VBA, DDE, formulas, add-ins, embedded executables, or external data connections;
- inventory external links and block or preserve them according to explicit policy;
- enforce compressed and expanded size limits to prevent ZIP bombs;
- reject package paths that escape the archive;
- reject malformed relationships and duplicate/conflicting package parts;
- treat document text, formulas, links, and metadata as untrusted input;
- preserve the original uploaded file unchanged;
- write output atomically to a new name;
- redact secrets and document content from routine logs;
- require TLS and configured authentication when the MCP service is not loopback-only;
- run with no broader filesystem access than required by its temporary workspace;
- delete temporary files according to high-side retention policy.

Microsoft Office COM automation is not the primary implementation. It requires an installed Office
desktop session, has poor unattended-service behavior, and can execute or resolve active content.
If a future deployment uses Office itself for a final-fidelity conversion, that must be an optional,
isolated, explicitly approved stage after Open XML validation.

## Update and round-trip workflow

### Generate from canonical source

1. Resolve and verify every knowledge reference.
2. Human-review the Markdown or structured data revision.
3. Select an approved DOCX/XLSX template and mapping.
4. Invoke the MCP renderer/filler.
5. Store the output under a new path.
6. Validate and extract the output for comparison.
7. Update the manifest with hashes and generator details.
8. Human-review the Office output before publication or handoff.

### Import an edited Office document

1. Preserve the uploaded Office file as an immutable input.
2. Inspect it and report unsupported/active content.
3. Extract normalized Markdown or structured data.
4. Compare the extraction with the current canonical source.
5. Present proposed canonical-source changes for human review.
6. Update the canonical source only after approval.
7. Regenerate a clean Office output from the approved source and template.

This avoids hidden divergence between Markdown and Office versions.

## Version and drift rules

A document is **in sync** only when its manifest's source hash, template hash, and generator version
match the current files and approved generator.

AAA should show Office outputs as stale when:

- canonical source changed;
- template changed;
- a referenced knowledge source changed;
- mapping changed;
- generator version changed under a policy that requires regeneration;
- the Office file was edited outside the controlled workflow.

Do not update Markdown and DOCX independently to "keep both current." Update the canonical source,
regenerate, and review.

## Delivery phases

### Phase 0: contract and fixtures

- Define the binary project-file broker contract.
- Define manifest schema and knowledge-reference schema.
- Collect representative high-side DOCX/XLSX templates with sanitized test fixtures.
- Define fidelity and policy acceptance tests.

### Phase 1: DOCX minimum viable service

- Inspect and validate DOCX.
- Fill named content controls/bookmarks.
- Render approved Markdown sections into an approved template.
- Preserve required styles, headers/footers, numbering, and reference output.
- Return a validated DOCX and manifest data.

### Phase 2: XLSX minimum viable service

- Inspect and validate XLSX.
- Read/write named ranges and named tables.
- Preserve formulas without evaluating them.
- Reject macros and unsupported external connections.
- Return a validated XLSX and manifest data.

### Phase 3: controlled round trip

- Extract DOCX to normalized Markdown and XLSX tables to structured data.
- Produce semantic diffs against canonical sources.
- Require human approval before canonical-source updates.

### Phase 4: workflow and UI integration

- Add AAA actions for inspect, generate, import, compare, validate, and mark reviewed.
- Surface stale-document status from manifest hashes.
- Add approval gates for publication or external submission.

## Acceptance criteria

The architecture is ready for production implementation when:

- an Office MCP service can run completely inside the high-side boundary;
- AAA can pass validated binary project files without exposing arbitrary filesystem paths;
- source, template, output, knowledge references, and generator are hash-linked;
- original uploads are immutable;
- no macros or active content execute;
- deterministic fixture tests verify content and package structure;
- output validation catches missing required fields and references;
- round-trip extraction produces reviewable proposed changes rather than silently editing both
  formats;
- all consequential output remains subject to human review.

## Consequences

### Positive

- AAA core remains smaller and easier to secure.
- Office support can evolve independently.
- The service is reusable by other approved clients.
- High-side templates and policies can be tested without cloud dependencies.
- Narrative and spreadsheet outputs have explicit lineage and drift detection.
- The design works with AAA's existing MCP file-result pipeline.

### Costs

- A separate service must be packaged, deployed, authenticated, monitored, and versioned.
- AAA needs the generic binary input broker before uploaded Office files can be processed.
- High-fidelity rendering requires a serious fixture suite and template-specific mappings.
- Controlled round-trip is more work than directly editing two files, but it avoids long-term
  divergence and unverifiable changes.

## Explicitly rejected alternatives

### Embed Word/Excel manipulation in AAA

Rejected because it couples a specialized parser, renderer, dependencies, and risk profile to the
core orchestrator.

### Use Microsoft Graph or Office Online as the primary path

Rejected because high-side and air-gapped operation cannot depend on cloud availability. A future
optional connector may be added through MCP.

### Use Office COM automation as the primary path

Rejected because it is unsuitable for a reliable unattended service and increases active-content
risk.

### Maintain Markdown and Word as equal editable masters

Rejected because automatic bidirectional synchronization is ambiguous and eventually loses
formatting, content, or provenance. One canonical source plus controlled import/regeneration is
required.
