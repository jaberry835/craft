# High-Side Feature Status

Last updated: 2026-09-25  
Status baseline: `9ce5ec9`

This document maps the requests in [`features_needed_from_high_side`](./features_needed_from_high_side) to implemented behavior and Git history. [`PUNCHLIST.md`](./PUNCHLIST.md) remains the broader engineering backlog.

## Status summary

| Status | Count |
| --- | ---: |
| Complete | 19 |
| Partial | 1 |
| Not started | 0 |
| Deferred to a separate MCP server | 1 |
| **Total requirements** | **21** |

Status meanings:

- **Complete**: implemented, validated, committed, and pushed.
- **Partial**: useful supporting behavior exists, but the requested workflow is not complete.
- **Not started**: no complete implementation exists in this repository.
- **Deferred**: intentionally assigned to another component.

## Requirements from the high-side list

| # | Requirement | Status | Implementation evidence |
| ---: | --- | --- | --- |
| 1 | Handle files, JSON, resource links, and authenticated downloads returned by HTTP MCP tools | **Complete** | `f6fef75`; MCP results are normalized and files can be saved through the agent loop. |
| 2 | Delete files and folders | **Complete** | `c34e2c0`; Files-tree deletion and the protected `delete_path` agent tool. |
| 3 | Diagnose Foundry/OpenAI endpoint and Responses-versus-Chat-Completions differences | **Complete** | `26cfa62`, `0a16b80`, `6119cf3`; model probe, bounded API adaptation, resolved URLs, timings, errors, and copyable recommendations. |
| 4 | Show MCP tools and their parameters in configuration diagnostics | **Complete** | `6119cf3`; connection tests expose discovered tool schemas without exposing credentials. |
| 5 | Add MCP authentication options | **Complete** | `5d1ee5b`; none, bearer, API-key header, OAuth client credentials, and Microsoft Entra with environment-referenced secrets. |
| 6 | Add optional Microsoft Entra authentication to AAA | **Complete** | `f4a29b0`; optional sign-in, sovereign-cloud authority support, app roles, token verification, safe browser sessions, and run attribution. |
| 7 | Never silently filter enabled tools, skills, prompts, or MCP servers | **Complete** | `06cb2ca`, `139b636`; enabled capabilities remain available, unsupported MCP transports are reported explicitly, and serialized toggles refresh the workflow used by the next agent run. |
| 8 | Show the initial prompt and live response immediately | **Complete** | `5a7ebb9`; first-turn chat transitions immediately and streams prompt, reasoning, and steps. |
| 9 | Continue chat when an MCP server is unavailable | **Complete** | `1fbd01a`; unavailable servers produce warnings/agent steps without blocking unrelated chat. |
| 10 | Continue adding regression and workflow tests | **Complete / ongoing practice** | `a6d55bf`, `db68670`, and focused tests across auth, project ACLs, MCP, Foundry agents, files, compaction, publication, browser capture, evidence links, and capability refresh. Current full-suite checkpoint: 137 server tests, 136 passing and one live-MCP test skipped without a real publisher. |
| 11 | Add useful, error-focused logging | **Complete** | `29b4a1f`; structured redacted server and browser API failure logging with configurable level and format. |
| 12 | Open a target knowledge-base site beside chat and fill forms/upload artifacts through Playwright | **Complete** | `e96c2ee`; the project-scoped visible Edge session can inspect visible form fields, fill explicitly reviewed values, and attach validated project artifacts. AAA never auto-submits the target form, so final submission remains a user action in Edge. |
| 13 | Automate Word and Excel templates | **Deferred to a separate MCP server** | Intentionally excluded from AAA so Office automation remains independently deployable and replaceable. |
| 14 | Support an agent-led, multi-stage workflow that asks for scans and architecture inputs before CONOPS and control work | **Partial** | Persistent multi-turn sessions, project agents, instructions, skills, prompts, reasoning steps, and tool use exist. Explicit workflow state, stage gates, required-input tracking, resume semantics, and a dedicated progress view do not. |
| 15 | Make browser capture launch visible Microsoft Edge by default and navigate to the requested site | **Complete** | `11ad28d` and browser-capture tests; visible Edge is the default, with URL launch/navigation controls and optional headless mode. |
| 16 | Offer screenshot-evidence capture from HTTP links in project documentation | **Complete** | `b74ff13`; rendered project Markdown places a Capture action beside absolute HTTP(S) links. The action launches or navigates the project Edge session and prefills a safe timestamped path under `evidence/screenshots/`; capture remains a separate user-confirmed action. |
| 17 | Delete a project | **Complete** | `31764b2`; confirmed deletion for AAA-managed projects, configured-root protection, final-project protection, active-project fallback, and local session/profile cleanup. |
| 18 | Show projects only to identities authorized for them | **Complete** | `bcb9ac0`; Entra mode stores project ACLs outside agent-writable content, restricts new projects to their creator, filters project listings, enforces every project-scoped route, and supports owner/admin-managed user and role grants. Local mode remains unrestricted; ACL-less legacy projects remain readable during migration, but only administrators can establish their first ACL or delete them. |
| 19 | Include an evidence directory in new project templates | **Complete** | `77feeca`; managed projects contain `evidence/` and `evidence/screenshots/` with provenance guidance. |
| 20 | Connect to Microsoft Foundry agents from agent setup | **Complete** | `9ce5ec9`; Agent setup can select a Microsoft Foundry runtime, reference a full Responses endpoint and credentials through environment-variable names, validate readiness, and invoke the remote agent with Entra or API-key authentication. Remote text, usage, steps, and errors flow through normal AAA run persistence. Custom `invocations` contracts are not guessed. |
| 21 | Default collected images to an evidence directory | **Complete** | `77feeca`; root image uploads and browser captures default to `evidence/screenshots/`, while explicit destination folders are respected. |

## Remaining high-side work

### Priority 0: authorization and safe autonomy

1. **Approval gates for consequential agent actions**
   - Classify read-only, reversible, and consequential tools.
   - Require explicit approval before destructive changes, publication, browser submission, or future external-system writes.
   - Treat model and tool output as untrusted data in policy enforcement.

### Priority 1: requested workflows

2. **Guided multi-stage agent workflows**
   - Add persisted workflow state, stages, prerequisites, checkpoints, and resume behavior.
   - Surface missing inputs and progress independently from free-form chat.
3. **Security-package dashboard**
   - Detect package structure and show control families, responses, evidence coverage, validation state, and review/publication readiness.

### Priority 2: broader punch-list items

- Hooks configuration and execution policy.
- Optional token pricing and run/session cost.
- Opt-in prompt cache keys.
- Large-tool-output summaries and compaction undo.
- Per-project or per-session token budgets.
- OpenTelemetry GenAI spans for Application Insights or an offline collector.
- Dynamic interactive architecture diagrams from cloud-scan output.
- Final offline installation rehearsal on the actual high-side OS and architecture.
- Decision and cleanup for tracked screenshots and stray assets listed in the punch list.

## Intentionally separate work

Word and Excel template generation remains assigned to a separate MCP server. AAA should consume its tools and returned files through the existing authenticated MCP/file-result pipeline rather than embedding Office automation in this repository.

## Autopilot update procedure

For each completed feature or fix:

1. Update the applicable requirement row in this document and the detailed item in [`PUNCHLIST.md`](./PUNCHLIST.md).
2. Add or update focused regression tests.
3. Run the focused tests, full relevant suite, lint, and production build.
4. Commit only that cohesive feature or fix, including the required co-author trailer.
5. Push the commit to `origin/main`.
6. Record the commit hash and any remaining limitation in this document.
