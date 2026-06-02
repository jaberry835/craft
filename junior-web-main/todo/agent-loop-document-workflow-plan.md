# Agent Loop Improvement Requirements

## Purpose

This document captures the highest-value improvements to the Junior Workbench agent loop for a document-first workflow. It is intended to guide the next implementation round.

The focus is not code-intelligence parity with SecureChatExtension. The focus is a stronger agent-working-over-documents loop for security approval packages and similar workspace-backed document sets.

## Product Context

Junior Workbench already has:

- a server-side iterative agent loop
- staged file changes with approve and undo behavior
- workspace file tools for reading, searching, and editing
- a basic workspace text index
- package-document loading and grounding hooks

The current gap is that the loop is still optimized for a small vertical slice. It does not yet provide the retrieval quality, run memory, review ergonomics, and document validation needed for larger multi-file document workflows.

## Goals

The next round should improve the loop so that it can:

1. Reliably work across many related package documents without rereading the entire workspace every turn.
2. Retrieve the most relevant document sections for the current task, not just exact keyword matches.
3. Make coordinated multi-file edits that are easy for humans to review and approve.
4. Track run progress and unresolved questions across a document task.
5. Validate document completeness and consistency before publish.

## Non-Goals

The following are explicitly out of scope for this round unless they directly support document workflows:

- code symbol navigation
- rename-symbol tooling
- editor-integrated code actions
- terminal-centric workflows
- language-server parity with VS Code

## Current State Summary

Current implementation strengths:

- `server/services/juniorAgentLoop.ts` provides the run lifecycle, planning loop, tool execution, and staged-change flow.
- `server/services/workspaceIndexer.ts` provides a basic in-memory keyword index over selected document types.
- `server/services/changeManager.ts` keeps file changes reviewable.
- `server/services/juniorAgentLoopContextProviders.ts` injects workspace grounding and package markdown content before a run.

Current limitations:

- workspace indexing is rebuilt eagerly and is not persisted as a richer layered index
- retrieval is keyword-based rather than chunked semantic retrieval
- run memory is shallow and mostly request-scoped
- review is file-based rather than section-based or rationale-aware
- validation is limited relative to document workflow needs

## Priority Improvements

### 1. Persisted Layered Document Index

#### Why it matters

This is the highest-value improvement. Document workflows degrade quickly when the agent must repeatedly rescan the workspace or rely on exact keyword overlap.

#### Requirements

Implement a layered workspace index for document workflows:

- workspace manifest index
- text search index
- semantic chunk index
- package structure index
- change index for pending or recently applied updates

The manifest index should track at least:

- relative path
- file type
- size
- last modified timestamp
- content hash
- indexing status

The semantic layer should:

- chunk markdown, text, JSON, YAML, and CSV files
- store chunk text with source path and line or section boundaries
- support retrieval of top relevant chunks for each turn
- refresh incrementally when files change

The package structure layer should recognize important workspace artifacts such as:

- intake
- architecture
- data classification
- threat model
- controls
- risk register
- approval summary
- evidence
- decisions
- questions

#### Acceptance criteria

- Re-indexing unchanged workspaces reuses cached index state instead of rereading all files.
- Agent grounding can retrieve relevant document chunks, not only whole-file previews.
- Index state is stored outside editable workspace contents.
- Local and blob-backed storage modes both support the index through a dedicated storage seam.

### 2. Stronger Document Retrieval Before Each Turn

#### Why it matters

The loop should begin a turn with the most relevant evidence and package sections already in context. That is more valuable for documents than code-navigation parity.

#### Requirements

Add a retrieval preparation step before planning that:

- combines the current user request with recent conversation context
- queries the package structure index and semantic chunk index
- selects the most relevant document sections
- injects a concise retrieval pack into the run context
- records which files and chunks were used for grounding

This retrieval step should prefer:

- directly relevant package sections
- recently changed files
- unresolved questions or evidence gaps from prior turns

#### Acceptance criteria

- The loop can explain which files or sections informed a response.
- Grounding quality improves for multi-document tasks such as summarization, gap analysis, and coordinated updates.
- Retrieval output remains bounded and token-aware.

### 3. Run Memory And Explicit Plan Tracking

#### Why it matters

Document tasks are often synthesis tasks. The agent needs memory of what it inspected, what it changed, and what remains unresolved.

#### Requirements

Extend loop state so each run can track:

- files inspected
- files changed
- unresolved questions
- assumptions made
- package sections already reviewed
- plan steps and their status

The planner should be able to maintain and revise a simple document-task plan such as:

- inspect intake and architecture
- compare against controls and risk register
- update missing sections
- summarize open questions

This state should be reflected in user-visible progress events.

#### Acceptance criteria

- Multi-step document runs show clear progress rather than opaque tool chatter.
- The planner avoids rereading the same files unnecessarily within a run.
- The loop can surface unresolved assumptions and open questions at the end of a run.

### 4. Richer Review Model For Multi-File Document Edits

#### Why it matters

The current staged-change model is directionally correct, but the next step is to make review easier for document-heavy runs.

#### Requirements

Improve the review model so that pending changes include:

- grouped changes by document or package section
- rationale for each proposed edit
- a short before/after summary
- support for accepting or rejecting changes at finer granularity than the full run

At minimum, the review surface should allow:

- accept one file
- reject one file
- accept all
- reject all

Preferred next-step capabilities:

- section-level diff grouping
- rationale generated from tool events and planner state
- change summaries that explain impact on publish readiness

#### Acceptance criteria

- Users can understand why an edit was proposed without reopening the whole transcript.
- Large multi-file runs remain reviewable.
- Pending changes remain the source of truth for review and approval.

### 5. Document Validation And Publish Readiness

#### Why it matters

A document agent should not only edit files. It should also detect missing, inconsistent, or weak package content before publish.

#### Requirements

Add document-oriented validation checks such as:

- required section missing
- section empty or placeholder-only
- conflicting terminology across package documents
- missing evidence references
- missing decision or approval summary linkage
- unresolved questions still present at publish time

These validators should feed both:

- loop context for agent runs
- user-facing publish readiness status

#### Acceptance criteria

- The agent can cite validation failures as a reason to inspect or update specific documents.
- Publish-readiness checks include document completeness and consistency, not just pending-change state.
- Validation results are available through a server-side seam, not only UI logic.

### 6. Workspace-Specific Editorial Instructions

#### Why it matters

Document quality depends on conventions. The agent should be able to follow workspace-specific writing rules consistently.

#### Requirements

Support a workspace-level instruction source for document workflows, including:

- tone and style rules
- section templates
- compliance-specific constraints
- editing restrictions for approved sections
- preferred structure for evidence, assumptions, and open questions

These instructions should be injected automatically before runs and be easy to replace or extend later.

#### Acceptance criteria

- Agents can follow workspace-specific writing conventions without duplicating rules in every prompt.
- Instruction injection is explicit and isolated behind a context-provider seam.

## Implementation Order

Recommended implementation order for the next round:

1. Persisted layered document index
2. Retrieval preparation using chunked grounding
3. Run memory and explicit plan tracking
4. Richer staged-change review model
5. Document validation and publish-readiness integration
6. Workspace-specific editorial instructions

## Suggested Delivery Slices

### Slice 1: Index Foundation

- introduce a dedicated index storage seam
- persist manifest and text index state
- add incremental refresh based on path plus hash or timestamp
- keep existing workspace API shape stable where possible

### Slice 2: Semantic Retrieval

- add chunking for markdown and related document types
- add semantic retrieval over chunks
- inject retrieved chunks into grounding before each run

### Slice 3: Run-State Quality

- add plan-step state to loop context
- track reviewed sections, assumptions, and unresolved questions
- expose improved progress events to the client

### Slice 4: Review And Validation

- attach rationale and summaries to staged changes
- add document validators
- extend publish-readiness checks with document completeness rules

## Architecture Constraints

The implementation should preserve these constraints:

- keep VS Code-specific APIs out of shared and server code
- keep workspace files as the source of truth
- keep pending changes reviewable before publish
- keep local filesystem development simple
- preserve a storage boundary that can support local, blob-backed, or future Git-backed workspaces

## Open Design Questions

These questions should be resolved before implementation starts:

1. Should semantic indexing start with local token-based ranking or go directly to embeddings?
2. Where should persisted index state live for blob-backed workspaces?
3. How should section boundaries be detected for markdown files: heading-based only, or heading plus fixed-size chunk fallback?
4. What is the minimum review granularity for the next round: file-level only, or section-level for markdown?
5. Which validation failures should block publish versus only warn?

## Definition Of Done For The Next Round

The next round should be considered successful if Junior Workbench can:

- retrieve relevant document sections from a medium-sized package workspace without full rescans each turn
- track multi-step document work with clear progress and unresolved-question memory
- stage and explain coordinated edits across multiple documents
- validate document completeness and consistency before publish
- do all of the above through server-friendly seams that remain compatible with future storage backends