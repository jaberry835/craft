# Conversation History Production Plan

## Goals

- Reduce repeated input tokens during long agent runs.
- Preserve enough exact recent context for reliable tool use.
- Compact only at complete tool-call boundaries.
- Recover exact older details without keeping them in every prompt.
- Use provider-managed state and compaction only when explicitly supported.
- Keep stateless Chat Completions and privacy-restricted deployments reliable.
- Make token and cache behavior observable before changing defaults.

## Target Prompt Shape

The logical prompt should contain, in order:

1. Stable system and security instructions.
2. Stable workspace and customization snapshot.
3. At most one structured conversation checkpoint.
4. Exact recent user turns and complete tool-call rounds.
5. The current user request and active tool round.

The display transcript, durable raw transcript, and model prompt are separate
representations. Compacting the model prompt must never alter what the user sees.

## Provider Capability Order

Use the highest supported mode for the active endpoint:

1. Responses API native context management and encrypted compaction items.
2. Responses API incremental state with `previous_response_id`.
3. Client-generated checkpoint plus exact recent tail.
4. Deterministic local checkpoint as the no-extra-request fallback.

Capability detection must be explicit. An unsupported or rejected feature falls
back one level for the current session without losing the local transcript.

## Phase 1: Correct Context Accounting

Status: complete.

### Changes

- Include serialized tool definitions in prompt estimates.
- Reserve bounded output headroom.
- Floor local estimates with the latest provider-reported prompt usage.
- Preserve that calibration across user turns.
- Do not independently trim incremental Responses tails.
- Show the complete logical prompt burden in the token indicator.
- Add a tokenizer adapter for supported model families; retain conservative
  character estimation for unknown or custom models.

### Acceptance

- A large tool set can trigger compaction even when messages alone fit.
- Local estimates never fall below the latest authoritative provider count.
- Small context windows retain a useful input budget.
- Incremental tool-result payloads are not treated as orphaned full histories.
- Existing Chat Completions and Responses-state tests pass.

## Phase 2: Turn and Tool-Round History

Status: complete.

### Changes

- Introduce stable turn and round identifiers.
- Represent each tool transaction as assistant calls plus all matching results.
- Store checkpoint metadata on an exact completed round.
- Render a prompt from the newest checkpoint followed by exact rounds after it.
- Preserve the original user objective at high priority.
- Migrate existing flat sessions in memory; keep persisted schema backward compatible.

### Acceptance

- No prompt starts in the middle of a tool transaction.
- Parallel tool calls remain paired with every result.
- Restoring an old session produces the same logical recent tail.
- A checkpoint supersedes only the history through its recorded boundary.

## Phase 3: Durable Raw Transcript

Status: complete.

Implementation: one SHA-256-named JSONL file per session under workspace
extension storage. Files follow the existing 20-session retention cap, are
deleted with pruned or explicitly deleted sessions, and are readable only for
the active session in ranges of at most 200 records.

### Changes

- Write append-only, versioned JSONL records for user messages, assistant output,
  tool calls, tool results, validation, cancellation, and provider usage.
- Store transcript files under workspace-scoped extension storage.
- Strip secrets and base64 payloads using the existing security pipeline.
- Apply file permissions appropriate to the host OS.
- Add a session-scoped read tool supporting bounded line or record ranges.
- Put a stable transcript reference into each newly created checkpoint.
- Define retention, deletion, and session-pruning behavior.

### Acceptance

- Exact pre-compaction tool evidence remains locally recoverable.
- Transcript access cannot escape the current session storage root.
- Deleted sessions remove their transcript artifacts.
- Secret-redaction and path-traversal tests pass.

## Phase 4: Structured Background Checkpoints

Status: complete.

### Changes

- Generate checkpoints near 80% context use after a complete tool round.
- Use a 90% foreground emergency path when no checkpoint is ready.
- Capture objectives, constraints, decisions, files, edits, validations, failures,
  outstanding work, recent operations, and transcript references.
- Keep two to four recent complete rounds exact, based on token budget.
- Validate checkpoint output and fall back to deterministic compaction on failure.
- Discard stale background checkpoints after model or context-window changes.
- Never run more than one checkpoint request per session at a time.

### Acceptance

- Normal background compaction does not block the active tool loop.
- Failed, canceled, or malformed checkpoint calls preserve a valid prompt.
- Switching to a larger-window model does not apply an unnecessary stale summary.
- Long-session task-continuation tests retain decisions and validation state.

## Phase 5: Native Responses Context Management

Status: complete.

Implementation: native compaction is an explicit, off-by-default Responses API
capability. Supported endpoints receive an 80%-of-window compact threshold. The
latest valid opaque compaction item remains memory-only and is chained with exact
post-boundary messages when `previous_response_id` is not active. Rejected or
expired provider state retries once with the full local transcript and disables
native compaction only for the current session.

### Changes

- Add endpoint capability configuration for `context_management`.
- Send a compact threshold with adequate active-turn headroom.
- Parse compaction stream items and retain only the newest valid item.
- Round-trip opaque encrypted content without inspecting or modifying it.
- Keep compaction items aligned with `previous_response_id` state markers.
- Reset provider state when local history, model, endpoint, or checkpoint boundary changes.
- Fall back on unsupported-field, missing-state, and expired-state errors.

### Acceptance

- Supported endpoints stop using client summaries while native compaction is active.
- Compaction items survive multiple tool iterations and session continuation.
- Unsupported Azure or APIM routes fall back without surfacing a failed chat turn.
- No opaque provider content is written to logs.

## Phase 6: Prompt Caching and Tool Lifecycle

Status: complete.

Implementation notes:

- Azure's automatic prefix caching is used across supported models. Explicit cache keys and breakpoints are omitted because this extension also supports pre-5.6 deployments that reject those fields.
- Base and custom instructions plus the first workspace snapshot are frozen for the session and inserted into the leading system-message block. Checkpoint text remains immutable.
- One textual tool result is limited to 12% of the model context window by default, including truncation framing. The setting is configurable from 1% to 50%, and in-budget results remain byte-for-byte unchanged.
- Full top-level and nested-subagent results are synchronously recorded in the raw transcript before model-visible truncation. Truncated results include a recovery reference.
- Aggregate tool-schema token cost is logged once per run. Deferred loading remains disabled because the current registry has no discover-and-activate protocol; enabling it now would violate equivalent-call discoverability.
- Provider cache-hit telemetry remains part of Phase 7; Phase 6 preserves the identical prefix required for automatic cache hits without changing model-visible instructions.

### Changes

- Freeze stable system, workspace, and customization components per session.
- Keep checkpoint text byte-for-byte stable after creation.
- Add provider cache keys or breakpoints only where supported.
- Limit a single textual tool result to a configurable prompt-budget fraction.
- Persist full tool output in the raw transcript before prompt truncation.
- Add deferred tool loading or tool search after measuring schema cost.

### Acceptance

- Repeated tool iterations preserve a stable cacheable prefix.
- Cache-hit usage increases without changing model-visible instructions.
- Oversized tool output cannot consume most of the prompt.
- Deferred tools remain discoverable and produce equivalent calls.

## Phase 7: Usage, Operations, and Default Rollout

Status: in progress.

Implemented:

- Chat Completions and Responses usage payloads now distinguish uncached input, cached input, cache writes, output, and reasoning tokens while preserving provider totals.
- Usage records carry provider or estimated provenance, and session counters expose both request counts without double-counting token subsets.
- Durable provider-request diagnostics record successful, failed, retried, stalled, and canceled attempts with model, iteration, and duration where available.
- Native, background-checkpoint, and foreground compaction diagnostics record source, boundary, duration, and fallback reason.
- Native compaction and model-generated checkpoints have independent rollback settings. Deferred tools remain disabled because no discover-and-activate protocol exists.
- Privacy documentation describes local raw-transcript retention and the provider-storage implications of server-side Responses state.
- Long-session regression fixtures cover sequential and parallel tool rounds, require at least 35% lower repeated input after compaction, and verify exact active-turn and task-completion preservation.
- GitHub Actions now runs compile, tests, lint, and production bundling on Windows, Ubuntu, and macOS with Node 20.
- `summarize_session_telemetry` aggregates the full current-session transcript into cache, token, request-reliability, duration, and compaction metrics without returning transcript content. It distinguishes cumulative input from latest/max request input and reports peak utilization of the native compaction threshold.

Remaining before default rollout:

- Observe a green cross-platform workflow run; Windows is verified locally, while the Ubuntu and macOS jobs require GitHub-hosted runners.
- Collect the implemented session telemetry from real opt-in usage before changing any defaults.

### Changes

- Track uncached input, cached input, cache writes, output, and reasoning tokens.
- Record successful, failed, retried, stalled, and canceled model requests.
- Distinguish estimated usage from provider-reported usage.
- Add diagnostics for compaction source, boundary, duration, and fallback reason.
- Gate native compaction, model checkpoints, and deferred tools independently.
- Roll out to opt-in sessions, then Responses sessions, then broader defaults.

### Release Gates

- Full unit and integration suite passes on Windows, macOS, and Linux.
- Long-session fixtures cover sequential and parallel tool calls.
- Chat Completions remains a tested fallback.
- Token regression fixtures show lower repeated input without lower task completion.
- Privacy documentation describes provider storage and local transcript retention.
- Every feature flag has a session-level fallback and a documented rollback path.

## Non-Goals

- Do not rely on a larger model context window as the only history strategy.
- Do not expose raw transcripts to arbitrary workspace or MCP tools.
- Do not summarize the newest incomplete tool round.
- Do not enable upstream storage where deployment policy prohibits it.
- Do not change defaults until usage and reliability measurements are available.