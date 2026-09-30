# Feature status

**Checkpoint:** 2026-09-28  
**Application version:** `0.1.0`

This inventory is based on the repository implementation, API routes, user interface, automated tests, and the operational statements in the root [README](../README.md). A **Complete** label means the feature is implemented at this checkpoint; it does not by itself establish production readiness or successful operation against every external environment.

## Complete

| Area | Implemented capability | Evidence in the repository |
| --- | --- | --- |
| Project lifecycle | List, create, select, and delete managed projects; register existing project folders; initialize new projects from a configurable template. | Project API routes, project registry tests, and the end-to-end workflow test. |
| Project access | Optional Microsoft Entra sign-in, token validation, role checks, per-project owner/user/role ACLs, and administrative access. Local mode remains intentionally unrestricted. | Authentication, project-access service, API routes, and related tests. |
| File workbench | Browse project trees; show hidden files on demand; create, read, edit, upload, rename, and delete supported files and folders; protect project boundaries and reserved directories. | File APIs, file-service tests, upload tests, and browser regression coverage. |
| Artifact preview | Render Markdown, format JSON, display supported images, expose source editing, and reject unsafe or mismatched upload content. | Preview UI, image/file routes, file-service validation, and tests. |
| Human review control | Track Markdown as Draft or Reviewed, bind review to a SHA-256 content hash, return edited content to Draft, and render only the reviewed revision in the Web preview. | Publication APIs and protected `.aaa/publication.json` behavior documented and tested in the file service. |
| AI chat and agent runs | Stream assistant text, reasoning, tool events, completion, and errors; persist messages and structured run records; stop active work; restore run details. | Chat route, agent loop, session stores, stream tests, and end-to-end chat coverage. |
| Azure OpenAI connection | Support legacy Azure OpenAI, OpenAI v1, and Foundry-project endpoint shapes; Chat Completions and Responses APIs; adaptive compatibility retries; safe status and diagnostics. | Model configuration/client/probe services and their test suites. |
| Context and usage management | Report or estimate token usage, display context utilization, compact sessions manually or automatically, and trim previously seen tool output when a run approaches its configured threshold. | Token, compaction, agent-loop, API, and UI implementations with tests. |
| Project-defined workflows | Discover and use `.github` agents, skills, prompts, Copilot instructions, and scoped instruction files; edit supported customizations in the UI. | Customization and workflow services, built-in `load_skill`, template content, and tests. |
| Built-in agent tools | Project-scoped file listing, reading, searching, writing, editing, copying, deleting, browser capture, downloading, and skill loading with enable/disable controls. | Central built-in tool catalog, agent-loop handlers, and tool workflow tests. |
| HTTP MCP integrations | Connect enabled HTTP MCP servers, list and call tools, test connections, substitute `aaa-file:` content, apply timeouts, continue when a server is unavailable, and handle downloadable results. | MCP client/auth services and the MCP-focused test suites. |
| MCP authentication | None, bearer token, custom header, OAuth client credentials, and Microsoft Entra credentials, including secret masking and token refresh after a `401`. | MCP auth implementation, customization editor, and tests. |
| Microsoft Foundry agents | Delegate a selected agent to an OpenAI-compatible Responses endpoint using API-key or Entra authentication; persist its response, usage, and attribution. | Foundry client, chat integration, and deterministic endpoint tests. |
| Browser evidence | Launch a project-specific Microsoft Edge profile, navigate to HTTP(S) pages, capture bounded PNG evidence with JSON provenance, inspect visible forms, fill non-password values, and attach validated project files. | Browser APIs/service, UI, browser-capture tests, and browser workflow coverage. |
| Session persistence | Use local JSON storage by default or a Cosmos DB container when fully configured; expose credential-safe storage readiness and avoid silent fallback from broken Cosmos configuration. | Session store factory, local/Cosmos stores, storage status, and tests. |
| Operational diagnostics | Structured logging and redaction, explicit API and stream errors, model diagnostics, storage status, and bounded retry behavior for transient model failures. | Logger, model client, HTTP error handling, API behavior, and tests. |
| Air-gapped operation | Build and run without a bundled browser download; support staged dependencies or an offline npm cache; keep normal browser startup local. | Pinned lockfile, engine constraints, runtime scripts, and documented deployment procedure. |

## Partial

| Area | Current state | Remaining work |
| --- | --- | --- |
| External MCP publishing validation | The publishing path is implemented and covered by deterministic end-to-end and MCP tests. | The live publisher test is skipped unless `AAA_MCP_LIVE_URL` is configured, so each target publisher still needs an environment-specific smoke test. |
| Microsoft Foundry deployment validation | Foundry invocation is implemented and tested against a deterministic fake Responses endpoint. | A real target/high-side Foundry endpoint still needs an environment-specific smoke test. |
| Agent-specific tool policy | Tools, skills, and MCP servers can be enabled or disabled for a project. | Availability is project-wide; agent `tools` frontmatter does not narrow the capabilities of an individual agent. |

## Not complete

| Area | Status | Completion criterion |
| --- | --- | --- |
| Lifecycle hooks | The Hooks customization surface is disabled and marked **Coming soon**. | Define the supported hook events, execution model, safety rules, approval behavior, persistence, UI, and automated tests. |
| Approval gates for higher-impact actions | The root README identifies this as remaining work. Current enable/disable controls and human document review do not provide per-action approval. | Define which actions require approval, add a request/approve/deny flow, enforce it server-side, persist an audit record, expose it in the UI, and test bypass resistance. |

## Intentionally out of scope

These are current product constraints, not features represented as complete:

| Capability | Current boundary |
| --- | --- |
| Arbitrary command execution | Agents do not run shell commands or scripts; `execute` directives in skills are ignored. |
| `stdio` MCP execution | `stdio` entries can be preserved and reported, but only HTTP MCP servers are executable. |
| Interactive MCP inputs | `${input:...}` values are unsupported; environment references such as `${env:NAME}` are supported. |
| Unrestricted downloads | HTTP downloads are limited to enabled MCP server origins or explicitly allowed hosts, supported file types, and size/content validation. |
| Autonomous external form submission | Browser assistance may inspect and fill supported fields, but it never fills passwords or submits the form. |
| Foundry-specific custom invocation contracts | Remote agents must expose an OpenAI-compatible Responses endpoint; AAA does not infer custom hosted-agent payloads. |
| Authorization or compliance decisions | AAA produces and organizes material for review; it does not grant an authorization or certify compliance. |

## Keeping this document current

Update this file when a feature changes state. A status promotion should cite observable implementation and the smallest relevant automated validation. Environment-dependent integrations should remain **Partial** until their target-environment check has been performed and documented.
