# Office Automation Service (REST API + MCP) — Plan

## 1. Summary

One Python web app on Azure App Service that converts and edits **Word
(`.docx`)** and **Excel (`.xlsx`)** documents. It exposes the same capabilities
through two interfaces:

- **MCP** (`/mcp`, Streamable HTTP) for AI agents.
- **REST API** (`/api/v1`, OpenAPI) for applications and for streaming document
  bytes.

Documents never travel inside MCP messages. Callers upload and download bytes
through the app’s own **streaming file API**. The app proxies those bytes to and
from a **private** Azure Blob Storage account that callers never reach
directly. That works for callers behind firewalls: if they can reach the app,
they can move files. Tools and API calls refer to documents by a **file handle**
(`file_id`), so the MCP client and any LLM see only IDs and compact JSON.
See §4.

Primary use cases:

1. **Markdown → Word**: generate a `.docx` from markdown, optionally using a
   template for styles, headers/footers, and boilerplate.
2. **Word → Markdown**: convert a `.docx` to markdown and extract its images.
3. **Fill a Word template**: read an arbitrary existing document, then apply
   markdown content or values to specific locations in it.
4. **Markdown ↔ Excel**: convert markdown tables to worksheets and worksheets
   back to markdown tables.
5. **Fill an Excel template**: inspect an arbitrary workbook, then write values
   to cells, ranges, tables, or named ranges.

### Division of responsibility

The service is **deterministic** and does not use an LLM. The upstream agent
decides where content should go and calls the service to carry out those
changes:

```text
Upstream agent / app                            This service
──────────────────────────────────────────────  ─────────────────────────────────
"Update this doc with this information"
  0. PUT /api/v1/files/… (template bytes)   ──►  streamed to private Blob → file_id f_1
  1. call docx_inspect(f_1)                 ──►  returns outline + addressable anchors
  2. decide which content goes where
  3. call docx_apply(f_1, operations)       ──►  applies ops, returns new file_id f_2
  4. GET /api/v1/files/f_2/content          ──►  streamed from private Blob to caller
```

## 2. Confirmed Requirements

| Topic | Decision |
|---|---|
| Formats | `.docx` and `.xlsx` only |
| Intelligence | Upstream agent reasons; service is deterministic |
| Word templates | Arbitrary existing documents; no guaranteed markup |
| Excel templates | Arbitrary workbooks; write by cell, range, table, or named range |
| Interfaces | One app, two interfaces: **MCP** tools at `/mcp` and a **REST API** at `/api/v1`, sharing one core service layer |
| Transport | Document bytes are streamed through the app’s file API to a private Blob Storage account; MCP and REST calls use `file_id` handles; callers may be behind firewalls and never contact Storage directly |
| Retention | Each file version expires **1 hour** after it is created, then is deleted |
| Images with markdown | Separate array of named assets, each referencing a `file_id` |
| Markdown scope | Basic markdown plus images and captions (see §6) |
| TOC | **Not generated.** A TOC is added after the document is created; existing TOCs are preserved |
| Size | **100 MB** per document (confirmed; configurable); synchronous tool calls |
| Stack | Python, FastAPI + FastMCP, python-docx, openpyxl |
| Hosting | Azure App Service (Linux) |
| Auth | Microsoft Entra ID in production; API key for dev/test |

## 3. Out of Scope

- File formats other than `.docx` and `.xlsx`, including `.doc`, `.xls`,
  `.xlsm` macros, PDF, and PowerPoint.
- Accessing OneDrive, SharePoint, email, or Microsoft Graph.
- Built-in LLM or natural-language instruction handling.
- TOC generation, page-number layout, and PDF rendering.
- Tracked changes authoring and comments.
- Formula recalculation in Excel. Workbooks are flagged to recalculate when
  opened.
- Long-term document storage. Blob Storage is a temporary workspace only;
  callers must download results within the 1-hour retention window.

## 4. Document Transport and File Handles

### 4.1 Why

Inline base64 in MCP messages would put about 13 MB of text into an LLM context
for a 10 MB file and would run into App Service request limits. Direct-to-Blob
SAS URLs fail for callers behind firewalls. Instead, the app exposes a
**streaming file API** that proxies bytes to and from a private storage account.
MCP and REST calls carry only small handles.

### 4.2 Flow

```text
Caller (may be behind firewall)     App Service (this app)                    Private Blob Storage
───────────────────────────────     ──────────────────────                    ────────────────────
POST /api/v1/files            ───►  reserve file_id, owner, expiry     ───►   metadata + index tags
PUT  …/files/{id}/content     ───►  stream request body in chunks      ───►   stage blocks, commit
  (or chunked: …/blocks/{n} then …/commit for large or slow links)
MCP docx_apply(file_id, ops)  ───►  read → edit → write new version    ◄──►   new blob {file_id_2}
GET  …/files/{id_2}/content   ◄───  stream blob to response (Range OK) ◄───   read
```

- Storage is reachable **only** from the app through VNet integration and a
  private endpoint. Public network access and shared-key access are disabled.
- Bytes are **streamed**, never fully buffered in app memory, in both
  directions. Uploads map directly to Azure block blob `Put Block` and
  `Put Block List` calls.
- The app authenticates to Storage with its **managed identity**. Callers never
  receive storage credentials or SAS URLs.

### 4.3 File model

- A `file_id` is an opaque random identifier, such as `f_` plus 128 random bits.
- **Files are immutable.** Every mutating or converting operation writes a new
  file and returns a new `file_id`. The original remains available until it
  expires. This gives natural versioning and safe retries, and it keeps inspect
  anchors valid for the file they came from.
- Metadata is stored as blob metadata and blob index tags, so no database is
  needed:
  - `owner`
  - `name`
  - `content_type`
  - `size`
  - `sha256`
  - `parent_file_id`
  - `state` (`reserved`, `uploaded`, or `validated`)
  - `created_at`
  - `expires_at`
- Each file version expires **1 hour after creation** (see §4.7).
- Every result that produces a file includes a file reference. MCP results also
  include an MCP `resource_link` content item that points to the download URL:

```json
{
  "file_id": "f_9c1e…",
  "name": "proposal.docx",
  "content_type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "size": 48213877,
  "sha256": "…",
  "parent_file_id": "f_71ab…",
  "expires_at": "2026-09-30T22:04:11Z",
  "content_url": "https://<app>/api/v1/files/f_9c1e…/content"
}
```

### 4.4 REST file API (`/api/v1/files`)

| Method and path | Purpose | Notes |
|---|---|---|
| `POST /files` | Reserve a file | Body: `name`, `content_type`, `size`, optional `sha256`. Returns `file_id`, upload endpoints, `max_block_size`, and `expires_at`. |
| `PUT /files/{id}/content` | Single-request upload | For files up to **32 MB** (configurable). Streams the body to Blob Storage. Accepts `Content-MD5` or an `x-content-sha256` header. |
| `PUT /files/{id}/blocks/{n}` | Chunked upload | Blocks up to **8 MB**. Each block is a short request, which avoids App Service timeouts on slow links. Retrying a block is safe. |
| `POST /files/{id}/commit` | Finish a chunked upload | Body: `block_count` and optional `sha256`. Commits the block list and validates size and hash. |
| `GET /files/{id}` | Get metadata and lineage | Returns the file reference. |
| `GET /files/{id}/content` | Download | Streams bytes and supports `Range` (resume and parallel download), `ETag`, `If-None-Match`, and `Content-Disposition: attachment`. |
| `DELETE /files/{id}` | Delete a file before it expires | |

**Download links for browsers:** `GET /files/{id}/content` requires the normal
bearer token or API key. When a human needs a clickable link, for example in a
chat message, `POST /files/{id}/links` returns a URL with a **signed, short-lived
token** (`?t=…`, default 15 minutes). The token is HMAC-signed with a Key Vault
key and scoped to one `file_id`, read-only access, and an expiry time. It is an
app-issued token, so it works through firewalls. Tokens are never logged.

### 4.5 MCP file tools

MCP tools let an agent manage files without transferring bytes:

| Tool | Purpose | Output |
|---|---|---|
| `files_create_upload` | Reserve a file and get the REST upload endpoints | `file_id`, `upload_url`, `block_upload_url_template`, `commit_url`, `max_block_size`, `expires_at` |
| `files_get_info` | Get metadata and lineage | File reference |
| `files_get_download_link` | Get a signed, short-lived browser download link | `url`, `url_expires_at` |
| `files_delete` | Delete a file before it expires | Confirmation |
| `files_upload_inline` | **Small-file convenience:** upload base64 up to 2 MB; can be disabled by configuration | File reference |

### 4.6 Validation

When an upload is committed, the service checks:

- The caller owns the reserved `file_id`.
- The actual size matches the declared size and is at most 100 MB.
- The hash matches when the caller supplied one.
- The file signature matches `.docx`, `.xlsx`, `.md`, or an allowed image type.
- The Office package passes safety checks (§11).

A file that fails is deleted, and the service returns `INVALID_DOCUMENT` or
`PAYLOAD_TOO_LARGE`. A file that passes is marked `state=validated`, so these
checks are not repeated.

### 4.7 Retention: enforcing 1 hour

Azure Blob lifecycle management runs about once a day, so it **cannot enforce a
1-hour limit** alone. Use three layers:

1. **Read-time enforcement:** Every tool, REST endpoint, and signed link rejects
   files whose `expires_at` has passed and returns `FILE_EXPIRED`.
2. **In-app sweeper:** A background task runs every 5 minutes. It queries blob
   index tags for `expires_at` values in the past and deletes those blobs.
   A blob lease elects one instance, so only one scaled-out instance sweeps at a
   time. No extra infrastructure is needed, and the sweeper runs inside the
   VNet.
3. **Backstop:** A lifecycle policy deletes any blob older than 1 day.

Reserved uploads that are never committed, and their uncommitted blocks, also
expire after 1 hour. Soft delete and blob versioning are **disabled** so deleted
content does not remain.

### 4.8 Markdown inputs and outputs

- Markdown input can be an inline string for normal documents, or a
  `markdown_file_id` for large markdown.
- Markdown output uses `markdown_output: "auto" | "inline" | "file"`. In `auto`
  mode, markdown up to 100 KB is returned inline so the agent can read it
  directly. Larger markdown is returned as a `.md` file reference.
- Images are never returned inline. They are always file references.

### 4.9 App Service considerations for proxying

| Concern | Approach |
|---|---|
| 230-second front-end request timeout | Use chunked 8 MB block uploads and streamed downloads that send bytes continuously. Downloads support `Range` for resume. |
| Request body size limits | Keep single-request uploads at 32 MB or less. Larger files use chunked upload. |
| Memory | Stream all file I/O. Processing engines load one document at a time, with a per-instance concurrency limit. |
| Throughput and cost | All bytes pass through the app. Size the plan, starting with P1v3 or larger; scale out on CPU and network; monitor egress. |
| Large-file upload | Scale out; Blob Storage handles concurrent block staging. |

## 5. Office Operations (MCP Tools and REST Endpoints)

Each operation is implemented once in the core service layer. It is exposed as
an **MCP tool** and as a **REST endpoint** with the same request and response
schema, defined by shared Pydantic models. Parity is enforced by contract tests.

Operations are stateless on the compute side; state exists only in Blob
Storage. Document parameters are `file_id` values. Every produced document is a
new file reference, plus a small JSON summary.

### 5.1 Word

| MCP tool | REST endpoint | Purpose | Key inputs | Output |
|---|---|---|---|---|
| `docx_to_markdown` | `POST /api/v1/docx/to-markdown` | Convert Word to markdown | `file_id`, `markdown_output`, `include_headers_footers` | `markdown` or markdown file reference, `assets[]` as image file references, `warnings[]` |
| `markdown_to_docx` | `POST /api/v1/docx/from-markdown` | Create Word from markdown | `markdown` or `markdown_file_id`, `assets[]`, optional `template_file_id`, `style_map`, `output_name` | New document file reference, `warnings[]` |
| `docx_inspect` | `POST /api/v1/docx/inspect` | Describe structure and addressable anchors | `file_id`, `detail_level` | Outline JSON |
| `docx_apply` | `POST /api/v1/docx/apply` | Apply a batch of edit operations | `file_id`, `operations[]`, `assets[]`, `output_name` | New document file reference, per-operation results, `warnings[]` |

### 5.2 Excel

| MCP tool | REST endpoint | Purpose | Key inputs | Output |
|---|---|---|---|---|
| `xlsx_to_markdown` | `POST /api/v1/xlsx/to-markdown` | Convert sheets or ranges to markdown tables | `file_id`, optional `sheets[]`, `ranges[]`, `values_or_formulas`, `markdown_output` | `markdown` or markdown file reference, `warnings[]` |
| `markdown_to_xlsx` | `POST /api/v1/xlsx/from-markdown` | Create or fill a workbook from markdown tables | `markdown` or `markdown_file_id`, optional `template_file_id`, `sheet_mapping` | New workbook file reference, `warnings[]` |
| `xlsx_inspect` | `POST /api/v1/xlsx/inspect` | Describe workbook structure and anchors | `file_id`, `sample_rows` | Structure JSON |
| `xlsx_apply` | `POST /api/v1/xlsx/apply` | Apply a batch of write operations | `file_id`, `operations[]` | New workbook file reference, per-operation results, `warnings[]` |

### 5.3 Utility

| MCP tool | REST endpoint | Purpose |
|---|---|---|
| `service_info` | `GET /api/v1/info` | Version, limits, retention, supported operations, and markdown features |
| — | `GET /healthz` | App Service health check, unauthenticated, with no details |
| — | `GET /api/v1/openapi.json` | OpenAPI specification for REST clients |

File transfer is REST-only, because byte streaming does not belong in MCP.
File management is available on both interfaces (§4.4, §4.5).

## 6. Markdown Specification

The service accepts CommonMark with GFM tables, plus the conventions below.
Unsupported syntax is rendered as plain text and reported in `warnings`.

| Feature | Markdown syntax | Word mapping |
|---|---|---|
| Headings H1–H6 | `#` … `######` | `Heading 1`–`Heading 6` styles |
| Paragraphs | Plain text | `Normal` style or `style_map` override |
| Inline emphasis* | `**bold**`, `*italic*`, `[text](url)` | Run formatting and hyperlinks |
| Bulleted and numbered lists (nested) | `-`, `1.` | `List Bullet`/`List Number` levels with template numbering |
| Tables | GFM pipe tables | Word table using the template’s table style |
| Images | `![alt](asset:logo.png)` | Inline picture from the `assets[]` entry named `logo.png` |
| Image size (optional) | `![alt](asset:logo.png){width=12cm}` | Picture width; aspect ratio is preserved |
| Figure caption | `![alt](asset:x.png "Caption text")` | `Caption` paragraph: “Figure {SEQ} – Caption text” |
| Table caption | `Table: Caption text` directly before a table | `Caption` paragraph: “Table {SEQ} – Caption text” |
| Page break | `<!-- pagebreak -->` | Page break |

\* The requested scope was basic markdown. Inline bold, italic, and links are
assumed necessary; confirm this.

**Captions:** Captions use Word `SEQ Figure` and `SEQ Table` fields. The service
writes the current field result so the numbers display correctly before a field
refresh and remain compatible with later TOC or table-of-figures generation.

**Word → markdown conventions:**

- Images are extracted as new image files, one file reference per image, with
  stable names such as `image-001.png`. Markdown references them as
  `asset:image-001.png`, and the `assets[]` output maps each name to its
  `file_id`. Passing the same `assets[]` back into `markdown_to_docx`
  round-trips the document.
- Captions are emitted using the conventions above, so conversion round-trips.
- An existing TOC is emitted as `<!-- toc -->` rather than stale text.
- Unsupported content, such as text boxes, SmartArt, charts, equations,
  comments, and tracked changes, produces warnings. Text is extracted when
  possible. Tracked changes are read as accepted unless configured otherwise.

### Assets array

Assets map markdown names to uploaded files. Image bytes are uploaded like any
other file (§4.4):

```json
[
  { "name": "logo.png", "file_id": "f_3d0a…" }
]
```

Allowed image types are PNG, JPEG, GIF, BMP, and TIFF (the formats python-docx can embed). SVG support is an open question (§14).
Asset names must be unique and use a safe character set.

## 7. Word Template Handling

Templates are arbitrary documents, so `docx_inspect` has to expose enough
structure for the upstream agent to choose precise locations.

### 7.1 `docx_inspect` output

```json
{
  "file_id": "f_71ab…",
  "styles": ["Normal", "Heading 1", "Caption", "…"],
  "sections": [{ "index": 0, "headers": ["…"], "footers": ["…"] }],
  "blocks": [
    { "id": "b0", "type": "heading", "level": 1, "text": "Executive Summary" },
    { "id": "b1", "type": "paragraph", "style": "Normal", "text": "Lorem ipsum…" },
    { "id": "b2", "type": "table", "rows": 4, "cols": 3,
      "header": ["Item", "Owner", "Due"], "caption": "Table 1 – Actions" },
    { "id": "b3", "type": "image", "alt": "Logo", "caption": null },
    { "id": "b4", "type": "toc" }
  ],
  "placeholders": [
    { "token": "{{client_name}}", "occurrences": ["b1", "header:0"] }
  ],
  "content_controls": [{ "tag": "ProjectName", "title": "Project", "location": "b5" }],
  "bookmarks": ["Summary"]
}
```

Placeholder detection recognizes `{{name}}`, `[[name]]`, `«name»`, `<<name>>`,
and `[Name]`. Detected patterns are hints; the agent chooses how to use them.
Detection works even when Word splits a token across multiple runs.
Long text is truncated in the outline, and `detail_level` controls whether
headers, footers, and full text are included.

### 7.2 Anchors

Operations target content through anchors:

| Anchor | Example | Notes |
|---|---|---|
| Block ID | `{"block": "b12", "source_file_id": "f_71ab…"}` | `source_file_id` must equal the target `file_id`; otherwise the service returns `ANCHOR_STALE`. Files are immutable, so IDs cannot drift |
| Heading | `{"heading": "Scope", "level": 2, "occurrence": 1}` | Case- and whitespace-insensitive |
| Placeholder | `{"placeholder": "{{client_name}}"}` | Matches all occurrences unless limited |
| Content control | `{"content_control": {"tag": "ProjectName"}}` | Matches tag or title |
| Bookmark | `{"bookmark": "Summary"}` | |
| Text match | `{"text": "TBD", "occurrence": 1}` | Exact match only; no regular expressions |
| Table | `{"table": {"index": 2}}` or `{"table": {"header_contains": "Owner"}}` | |

Every anchor is resolved before any operation runs. If an anchor matches no
location, or matches more than one when exactly one is required, the batch fails
atomically and returns candidate matches in the error.

### 7.3 `docx_apply` operations

| Operation | Effect |
|---|---|
| `replace_placeholder` | Replace a token with plain text or inline markdown while preserving run formatting |
| `set_content_control` | Set content-control text or markdown content |
| `replace_text` | Replace exact text at an anchor |
| `insert_markdown` | Insert rendered markdown `before`/`after` an anchor |
| `replace_section` | Replace the body under a heading until the next heading of the same or higher level |
| `delete_section` / `delete_block` | Remove a section or block |
| `fill_table` | Write rows from a markdown table or 2-D array, adding or removing rows while preserving row formatting |
| `append_table_rows` | Append rows by cloning the formatting of the last data row |
| `insert_image` | Insert an asset at an anchor, with optional width and caption |
| `set_properties` | Set core properties such as title, author, and subject |

Inserted markdown uses the template’s own styles, so new content matches the
document. `style_map` can override the mapping, for example
`{"paragraph": "Body Text", "table": "Grid Table 4"}`.

### 7.4 Optional convenience tool (later phase)

`docx_fill_from_markdown(template_file_id, markdown, assets[])` deterministically:

- Replaces the body of each template heading with the markdown section that has
  the same heading.
- Fills `{{key}}` placeholders from YAML front matter.
- Returns a report of unmatched sections and unused keys.

This supports simple cases without multiple inspect/apply round trips.

## 8. Excel Handling

### 8.1 `xlsx_inspect` output

- Sheets with names, visibility, used range, merged cells, and freeze panes.
- Excel tables (ListObjects) with name, range, headers, and row count.
- Named ranges with their references.
- Cells containing placeholder patterns, as listed in §7.1.
- Formula cells, summarized by count and ranges.
- Features at risk of loss when saved, such as charts, pivots, images, and slicers
  (see §10).
- Sample rows for each sheet or table, limited by `sample_rows`.

### 8.2 `xlsx_apply` operations

| Operation | Effect |
|---|---|
| `set_cells` | Write values to addressed cells such as `Sheet1!B4` |
| `write_range` | Write a 2-D array starting at an anchor cell |
| `write_table` | Replace or append rows in a named table and resize it |
| `set_named_range` | Write a value or array to a named range |
| `replace_placeholders` | Replace placeholder tokens in cells |
| `insert_markdown_table` | Write a markdown table at an anchor, optionally as an Excel table |
| `add_sheet` / `copy_sheet` / `rename_sheet` / `delete_sheet` | Manage sheets |

Rules:

- Values are typed as strings, numbers, booleans, dates, or `null`. ISO 8601
  strings become Excel dates when `parse_dates` is enabled.
- Values beginning with `=` are written as formulas only when
  `allow_formulas: true`. Otherwise, they are stored as text to prevent formula
  injection.
- Existing cell styles and number formats are preserved.
- The workbook is flagged `fullCalcOnLoad` so formulas recalculate on open.

### 8.3 Markdown ↔ Excel

- **Markdown to XLSX:** Each markdown table becomes a sheet. Sheet names come
  from the nearest preceding heading, or `Sheet{n}`. `sheet_mapping` can target
  existing template sheets or tables instead.
- **XLSX to markdown:** Each sheet, or each requested range, becomes a heading
  and a GFM table. Cached values are emitted by default; formulas are optional.
  Merged cells are expanded with warnings, and output is limited by rows and
  columns.

## 9. Architecture

```text
 Caller (agent or app; may be behind a firewall)
   │  HTTPS only to the app — never to Storage
   ▼
┌──────────────────────── Azure App Service (Linux, Python) ─────────────────────────┐
│  FastAPI (ASGI, gunicorn + uvicorn workers)                                         │
│   ├─ Auth middleware: Entra ID JWT | API key (dev/test) | signed link token (GET)    │
│   ├─ /mcp        FastMCP Streamable HTTP (stateless) ── MCP tool adapters ─┐       │
│   ├─ /api/v1     REST routers (files, docx, xlsx, info) ─ REST adapters ───┤       │
│   └─ /healthz                                                             ▼       │
│                                         Core service layer (shared Pydantic models)│
│                        ┌──────────────────┬──────────────┬──────────────────┐      │
│                        ▼                  ▼              ▼                  ▼      │
│                   File store         docx engine     xlsx engine     markdown engine│
│                   (streaming proxy,  (python-docx    (openpyxl)      (markdown-it-py│
│                    ownership,         + lxml)                         → AST)       │
│                    validation,             └── package safety checks ──┘           │
│                    signed links)                                                   │
│                        │                                                           │
│   Background: retention sweeper (every 5 min; blob-lease leader election)          │
└────────────────────────┼───────────────────────────────────────────────────────────┘
                         │ VNet integration + private endpoint, managed identity
                         ▼
             Azure Blob Storage (public access off, shared key off,
             index tags, soft delete off, 1-hour TTL enforced by app)
             Key Vault (signing key for download links, API keys)
             Application Insights (telemetry, no content)
```

- **Single deployable:** One FastAPI app mounts the FastMCP Streamable HTTP app
  at `/mcp` and the REST routers at `/api/v1`. Both interfaces use the same auth
  middleware and core service layer. MCP tools and REST routes are thin adapters,
  with no business logic of their own.
- **Stateless compute:** All file state lives in Blob Storage, so any instance
  can serve any request, and the app scales out without session affinity.
- **Streaming:** File endpoints stream between the HTTP connection and Blob
  Storage in chunks. Engines read a document from Blob Storage into a bounded
  buffer that spills to local temp storage above a threshold, process it, and
  stream the result back. Documents are not logged.

### Proposed project layout

```text
mcp-officeautomation/
  pyproject.toml
  src/officeautomation/
    app.py                 # FastAPI app: mounts /mcp and /api/v1, middleware, lifespan (sweeper)
    auth.py                # Entra ID, API key, and signed-link token validation
    config.py              # pydantic-settings
    api/                   # REST routers: files, docx, xlsx, info
    mcp/                   # FastMCP server and tool adapters
    core/                  # shared operation services, used by both api/ and mcp/
    files/                 # blob store, streaming upload/download, ownership, validation, retention
    models/                # shared request, response, operation, anchor, and file schemas
    markdown/              # parser, AST, and serializer
    docx/                  # inspect, render, apply, to_markdown, anchors, runs
    xlsx/                  # inspect, apply, from_markdown, to_markdown
    safety/                # package validation and limits
  tests/
    fixtures/              # real-world templates and golden outputs
    unit/  integration/  contract/   # contract/ includes MCP-REST parity tests
  infra/                   # Bicep: App Service with VNet integration, Storage with private endpoint, Key Vault, App Insights
```

### Key libraries

| Need | Library | Note |
|---|---|---|
| REST API | `fastapi` | Hosts the REST routers, mounts MCP at `/mcp`, and generates OpenAPI |
| MCP server | `mcp` (FastMCP) | Streamable HTTP, `stateless_http=True`, mounted in FastAPI |
| Word | `python-docx` + `lxml` | lxml handles content controls, fields, captions, and split-run edits |
| Excel | `openpyxl` | See the fidelity risks in §10 |
| Markdown | `markdown-it-py` + `mdit-py-plugins` | CommonMark, tables, and attributes |
| Images | `Pillow` | Validate and size images |
| Blob Storage | `azure-storage-blob` (async) + `azure-identity` | Managed identity, block staging, ranged reads, index tags |
| Hosting | `gunicorn` + `uvicorn` workers | App Service Linux |

**Considered alternative:** Pandoc converts markdown to and from Word well, but
it cannot insert content into an existing arbitrary document. A single
python-docx-based renderer serves both whole-document generation and
template insertion. Pandoc remains a fallback for Word-to-markdown conversion
if fidelity is insufficient.

## 10. Key Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| **All file bytes pass through the app.** | Throughput, egress cost, and App Service timeouts | Use chunked uploads, streamed and range-capable downloads, and a per-instance concurrency limit. Scale out on CPU and network; load-test 100 MB uploads and downloads over slow links. |
| **Two interfaces drift apart** | MCP and REST behave differently | Use one core layer with shared Pydantic schemas, thin adapters, and contract tests that run each operation through both interfaces and compare results. |
| **Short retention window.** A 1-hour TTL can expire mid-workflow or before download. | `FILE_EXPIRED` errors | Return `expires_at` on every reference; each new version gets a fresh hour; document that callers must download promptly. |
| **Memory use on large documents** | Out-of-memory errors or slow responses at 100 MB | Use bounded buffers, per-instance concurrency limits, and an appropriately sized plan such as P1v3 or larger. Load-test at the maximum size. Add an asynchronous job mode only if synchronous calls exceed timeouts. |
| **openpyxl loses features.** Charts, images, pivot caches, slicers, and some drawings in existing workbooks can be lost on save. | Silent template damage | `xlsx_inspect` reports at-risk features; `xlsx_apply` refuses by default when they exist (`allow_feature_loss` overrides). If common, write cell/table changes directly to package XML instead. |
| **Word splits tokens across runs.** | Placeholders are missed or corrupted | Implement a run-normalization helper that matches across runs and keeps the first run’s formatting. Test it with real templates. |
| **Arbitrary templates vary widely.** | Anchors fail or produce poor structure | Provide a rich inspect output, atomic failure with candidate matches, and a corpus of real templates. |
| **Numbering and list continuation** | Lists restart or use wrong styles | Reuse template numbering definitions and add golden tests. |
| **Leaked download links** | Unauthorized access to a document | Signed links are single-file, read-only, HMAC-signed, and valid for 15 minutes by default. They are issued only on request and never logged. The signing key is rotated in Key Vault. |
| **Malicious packages** | Zip bombs, external links, or macros | Enforce limits on entries and expanded size, reject macro-enabled content types, and strip or reject external relationships. |

## 11. Security, Limits, and Operations

- **Auth:** One auth middleware protects both `/mcp` and `/api/v1`. It
  validates Entra ID bearer tokens for issuer, audience, and required role, such
  as `OfficeAutomation.Use`. API keys are enabled only by configuration, stored
  in Key Vault, and compared in constant time. Signed link tokens are accepted
  **only** on `GET /api/v1/files/{id}/content` for the `file_id` they name.
- **File isolation:** Every file is owned by the caller identity that created it.
  Every tool and endpoint checks ownership, and file IDs are unguessable.
- **Storage:**
  - Access is only through the private endpoint from the app’s VNet. Public
    network access and shared-key access are disabled.
  - The App Service managed identity has the Storage Blob Data Owner role on
    the container, which is required for blob index tag queries. Scope the role
    to the container.
  - Data is encrypted at rest, with an option for customer-managed keys.
  - Soft delete and versioning are off.
  - Callers never receive SAS URLs or storage credentials.
- **Browser clients:** CORS is enabled on `/api/v1` only for configured
  origins.
- **No local persistence:** Temporary spill files are deleted when a request
  ends. Documents are never written to logs.
- **Limits:** Configurable limits, with these defaults:
  - 100 MB per document
  - 32 MB for a single-request upload; larger files use 8 MB blocks
  - 2 MB for inline upload
  - A maximum number and total size for assets
  - A maximum number of operations per batch
  - A maximum expanded package size
  - Per-instance limits on concurrent processing and concurrent transfers
  - Tool timeout below the App Service 230-second limit
- **Logging:** Application Insights records the interface (MCP or REST), the
  operation, duration, sizes, operation counts, outcome, correlation ID, and
  hashed `file_id`s. It never records document text, base64 content, or signed
  link tokens.
- **Errors:** Return structured errors with a code, message, and details, using
  these codes: `INVALID_DOCUMENT`, `UNSUPPORTED_FEATURE`, `ANCHOR_NOT_FOUND`,
  `ANCHOR_AMBIGUOUS`, `ANCHOR_STALE`, `FILE_NOT_FOUND`, `FILE_EXPIRED`,
  `FILE_NOT_UPLOADED`, `UPLOAD_INCOMPLETE`, `HASH_MISMATCH`,
  `PAYLOAD_TOO_LARGE`, `FEATURE_LOSS_BLOCKED`, `UNAUTHORIZED`, `FORBIDDEN`, and
  `INTERNAL_ERROR`. REST maps these to HTTP status codes. MCP returns them as
  tool errors with the same body.
- **Health:** A `/healthz` endpoint for App Service health checks.

## 12. Testing Strategy

- **Golden tests:** Convert markdown to DOCX and back to markdown, and compare
  normalized structure. Compare DOCX XML snapshots for rendering.
- **Template corpus:** Test real-world `.docx` and `.xlsx` templates supplied by
  the team. This is critical because templates are arbitrary.
- **Fidelity checks:** Open outputs with LibreOffice headless in CI to confirm
  they are valid, and validate the package against the Open XML schema.
- **Operation tests:** Test every anchor type, ambiguous anchors, atomic
  rollback, and split-run placeholders.
- **Security tests:** Test zip bombs, macro-enabled files, external links,
  oversized payloads, formula injection, cross-owner `file_id` access, expired
  files, and signed links: tampering, expiry, wrong file, and use on non-GET
  endpoints.
- **File lifecycle tests:** Test single and chunked upload, out-of-order and
  retried blocks, commit hash mismatch, abandoned uploads, `Range` downloads,
  retention sweeper deletion with multiple instances, and lineage
  (`parent_file_id`). Integration tests use Azurite locally and a private
  storage account in CI.
- **Contract tests:** Test MCP initialization, tool listing, schemas, and
  `resource_link` outputs through an MCP client over HTTP. Verify that tool
  results never contain document bytes. **Parity tests** run each operation
  through MCP and REST and assert identical results.
- **Load tests:** Test concurrent 100 MB uploads and downloads, including
  throttled slow-client links, to confirm streaming, memory limits, and
  timeout behavior.

## 13. Delivery Phases

| Phase | Scope | Exit criteria |
|---|---|---|
| **0 — Confirm** | Resolve §14 decisions; collect sample templates and markdown | Signed-off tool and API schemas and a template corpus |
| **1 — Foundation** | FastAPI app with FastMCP mounted at `/mcp`, auth for both interfaces, config, limits, error model, `service_info` and `/api/v1/info`, `/healthz`, OpenAPI, CI, and App Service deployment with VNet integration. Includes the **file store**: the streaming REST file API (single and chunked upload, range download, signed links), `files_*` MCP tools, ownership, validation, the retention sweeper, and Bicep for Storage with a private endpoint | A firewalled client can upload 100 MB in chunks and download it through the app; Storage has no public access; expired files are removed within 5 minutes |
| **2 — Word conversion** | Markdown AST, `markdown_to_docx` with template styles, images, captions, and `docx_to_markdown` with asset extraction, on both interfaces | Golden round-trip tests and parity tests pass on the corpus |
| **3 — Word templates** | `docx_inspect`, anchors, `docx_apply` operations, split-run handling, atomic batches | An agent fills the sample templates using only inspect and apply |
| **4 — Excel** | `xlsx_inspect`, `xlsx_apply`, conversion in both directions, feature-loss detection | Sample workbooks are filled without data or feature loss |
| **5 — Hardening** | Security tests, load tests at 100 MB with images over slow links, telemetry dashboards, `docx_fill_from_markdown` | Production readiness review is complete |

## 14. Open Questions

1. **Existing API conventions:** You have built a combined REST and MCP
   service before. Should this one reuse that project’s auth setup, error
   format, URL versioning, or deployment templates?
2. **Signed download links:** Are browser-clickable signed links needed, or will
   every download be an authenticated API call?
3. **Inline formatting:** Is support for bold, italic, and links confirmed?
4. **Caption format:** Is “Figure 1 – text” correct, or should captions use a
   different separator or label, or follow the template’s language?
5. **Excel feature loss:** Do the Excel templates contain charts, pivots, or
   images? This determines whether openpyxl is sufficient.
6. **Headers and footers:** Should placeholders in headers and footers be
   filled by default? The current plan says yes.
7. **SVG images:** Should SVG images be supported? This requires a PNG fallback.
8. **Samples:** Please provide three to five representative Word and Excel
   templates, plus sample markdown inputs, for the test corpus.
