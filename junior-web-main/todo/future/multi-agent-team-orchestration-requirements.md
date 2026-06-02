# Future Multi-Agent Team Orchestration Requirements

## Purpose

This document captures a future longer-term requirement to support a coordinated team of agents working together on a shared task inside Junior Workbench.

The goal is not merely to let a single agent call more tools. The goal is to let multiple specialized agents collaborate through a controlled orchestration layer so they can divide work, contribute evidence, review each other’s outputs, and complete larger tasks more reliably.

This feature should replicate the spirit of the team-based Junior behavior used in the `SecureChatExtension` implementation and adapt it to the web-first architecture in this repository.

## Product Context

Junior Workbench currently runs through a single primary agent loop:

- `server/services/juniorAgentLoop.ts` is the main orchestrator for planning, tool execution, and staged changes
- `server/services/simpleJuniorAgent.ts` wraps that loop for chat sessions and workspace use
- the current runtime already has useful seams such as context providers, middleware, tool registration, grounding, and MCP support

The future gap is that the runtime still assumes one active agent is responsible for the full task. Larger tasks would benefit from specialized sub-agents or agent roles that can coordinate rather than forcing one loop to do everything itself.

## Goals

The future multi-agent layer should make the system able to:

1. Orchestrate a team of specialized agents against one user task.
2. Delegate sub-tasks to the right agent based on role, tools, and context.
3. Aggregate findings, edits, and open questions back into a shared result.
4. Keep multi-agent runs reviewable, auditable, and bounded.
5. Reuse the existing Junior loop and framework seams instead of building a separate runtime from scratch.

## Non-Goals

The following are out of scope for the initial future design unless directly needed by the orchestration model:

- unrestricted autonomous agent swarms
- opaque self-replicating agent creation
- long-running background agents with no user visibility
- replacing the single-agent loop for all tasks immediately
- shipping every possible collaboration pattern in the first version

## Current State Summary

Current implementation strengths:

- the web runtime already has a central loop, planner, middleware, context providers, and tool registry that can act as orchestration seams
- agents already have distinct definitions, tool access, grounding sources, and MCP attachments
- staged changes and review flows already provide a human control boundary

Current limitations:

- only one agent actively plans and executes a task at a time
- there is no agent-to-agent delegation model
- there is no shared team task state across cooperating agent roles
- there is no role-specific orchestration policy for reviewer, researcher, drafter, or verifier behaviors
- there is no UI model for showing how multiple agents contributed to one result

## Requirements

### 1. Team-Orchestrator Model

#### Why it matters

Multi-agent behavior needs a clear control layer. Otherwise it becomes unpredictable, expensive, and hard to review.

#### Requirements

Define a team orchestrator that:

- accepts the user task and overall objective
- selects whether the task should remain single-agent or use a team workflow
- creates a bounded execution plan for participating agents
- delegates sub-tasks to specific agent roles
- aggregates results, unresolved questions, and proposed edits back into one run outcome
- decides when the team is done, blocked, or should hand back to the user

The orchestrator should be implemented as an extension of the existing loop architecture rather than a completely disconnected runtime.

#### Acceptance criteria

- The design defines one coordinating orchestrator for team execution.
- Multi-agent runs remain bounded and do not devolve into uncontrolled loops.
- The orchestrator is explicitly related to the existing `JuniorAgentLoop` architecture.

### 2. Specialized Agent Roles

#### Why it matters

Team-based behavior only helps when agents have distinct responsibilities.

#### Requirements

Support future agent roles such as:

- planner or coordinator
- researcher
- document analyst
- drafter
- reviewer
- verifier or validator
- governance or policy checker
- source-retrieval specialist

Each role should be able to define:

- instructions and persona
- allowed tools
- grounding sources
- MCP attachments
- output contract expected by the orchestrator

The design should support environment-specific agent teams, not one hard-coded universal team.

#### Acceptance criteria

- Team members are modeled as role-specific agents with distinct responsibilities.
- The system can define more than one team composition depending on task type.
- Agent roles remain configurable instead of hard-coded in one place.

### 3. Delegation And Sub-Task Contract

#### Why it matters

Delegation needs structure. Otherwise the orchestrator cannot reliably combine results.

#### Requirements

Define a sub-task contract for agent-to-agent work that includes:

- sub-task objective
- scoped context provided to the sub-agent
- allowed tools and retrieval sources
- expected output format
- completion status
- open questions or blockers
- provenance and evidence references
- resulting governance or marking implications when applicable later

Delegation should support patterns such as:

- investigate then report back
- propose edits then return staged changes
- validate another agent’s draft
- gather evidence from linked systems
- summarize unresolved issues for the coordinator

#### Acceptance criteria

- Delegated work has a structured contract instead of ad hoc prompt passing.
- The coordinator can distinguish completed work, blocked work, and uncertain findings.
- Sub-agent outputs are shaped for aggregation and review.

### 4. Shared Team State And Memory

#### Why it matters

A team needs a common working memory without forcing every agent to re-read the full workspace.

#### Requirements

Define a shared team state that can track:

- top-level objective
- team plan and current progress
- sub-task assignments
- files inspected
- files changed
- evidence collected
- open questions
- agent findings and handoff summaries
- final synthesis inputs

The shared state should support both:

- team-level memory visible to the coordinator
- scoped task packets visible only to the assigned sub-agent when appropriate

#### Acceptance criteria

- Team runs have a documented shared-state model.
- Agents can hand off findings without redoing the same work unnecessarily.
- Shared state remains reviewable and bounded.

### 5. Aggregation, Review, And Conflict Resolution

#### Why it matters

Multiple agents can produce overlapping findings, inconsistent edits, or conflicting recommendations.

#### Requirements

Define how the orchestrator:

- combines findings from multiple agents
- detects contradictory conclusions or duplicate work
- requests rework or validation from a different agent role
- merges or sequences proposed edits
- escalates unresolved conflicts to the user

The system should support patterns such as:

- reviewer rejects drafter output and requests revision
- verifier fails a proposed package because required evidence is missing
- researcher finds source conflict and sends it back to the coordinator

#### Acceptance criteria

- The design includes a conflict-resolution and aggregation model.
- Contradictions between agents are surfaced rather than silently merged.
- The user can understand when the team is aligned versus still in disagreement.

### 6. Tool, MCP, And Source Access By Role

#### Why it matters

Not every agent should have the same tools or source access. Role scoping is part of safety and quality.

#### Requirements

The multi-agent system should support:

- role-specific tool allow-lists
- role-specific MCP server access
- role-specific grounding sources
- role-specific write permissions or staged-change abilities
- optional reviewer-only or validator-only roles that cannot author edits directly

This should build on the existing agent definition and tool registry model rather than inventing a second authorization scheme.

#### Acceptance criteria

- Different team members can have different tool and source capabilities.
- High-risk write behavior can remain limited to selected roles.
- Role access rules are consistent with the broader agent-definition model.

### 7. Human Control And Review Boundaries

#### Why it matters

A team of agents should increase capability without reducing user control.

#### Requirements

Multi-agent execution should preserve human oversight through:

- visible team progress and active role display
- reviewable handoffs and summaries
- staged changes remaining the approval boundary for edits
- clear indication of which agent proposed which change or finding
- ability to stop, continue, or request clarification during a team run

The design should avoid making the user read every internal exchange while still keeping the reasoning and contributions attributable.

#### Acceptance criteria

- Users can tell which agents participated in a task.
- Proposed edits remain reviewable through the existing human approval boundary.
- The system can summarize team activity without exposing raw internal chatter by default.

### 8. UI And UX For Agent Teams

#### Why it matters

If multiple agents are working, the interface must explain who is doing what and what the current state of the task is.

#### Requirements

Define a future UI model that can show:

- which team is active for the task
- which agent role is currently running
- current sub-tasks and statuses
- evidence collected by different agents
- handoff summaries
- final synthesis and outstanding disagreements

The UI should support compact views such as:

- coordinator summary
- team progress timeline
- per-agent contribution panel
- change attribution panel

#### Acceptance criteria

- Multi-agent runs have a future UI model, not only backend orchestration ideas.
- Users can see progress and contributions at the role level.
- Final output can be traced to participating agent roles.

### 9. Cost, Latency, And Bounded Execution

#### Why it matters

Multi-agent systems can become too slow or expensive without explicit controls.

#### Requirements

Define execution controls such as:

- maximum agents per team run
- maximum delegation depth
- maximum iterations per sub-agent
- token and cost budgets by run
- early stop conditions
- fallback to single-agent mode when a team is unnecessary

The orchestrator should optimize for using a team only when the task warrants it.

#### Acceptance criteria

- Multi-agent runs are explicitly budgeted and bounded.
- The system can decide not to use a team when the task is simple.
- Cost and latency controls are part of the design, not an afterthought.

### 10. Replication Strategy From SecureChatExtension

#### Why it matters

This future feature should build on proven Junior concepts rather than start from zero.

#### Requirements

Document a replication strategy that uses lessons from `SecureChatExtension`, especially:

- thin orchestrator design
- middleware pipeline
- context provider model
- tool registry and execution abstraction
- bounded iterative loop patterns

The web implementation should identify what is reusable in principle from the VS Code version and what must be adapted for:

- web UI instead of VS Code webview flows
- server-side session and workspace storage
- browser-safe preview and review surfaces
- web-friendly identity, governance, and permission boundaries

#### Acceptance criteria

- The design explicitly ties the future multi-agent feature back to the SecureChatExtension approach.
- Reuse versus rewrite boundaries are documented.
- The web workbench version remains aligned with the architecture of this repo.

### 11. Validation And Test Coverage

#### Why it matters

Multi-agent orchestration will be fragile unless role delegation, aggregation, and safety boundaries are testable.

#### Requirements

Future validation should cover:

- delegation plan creation
- sub-agent execution contracts
- aggregation of findings and edits
- conflict detection and escalation
- role-based tool restrictions
- bounded execution rules
- attribution of changes and findings back to the correct agent role

#### Acceptance criteria

- The future design identifies executable validation targets for multi-agent behavior.
- Delegation and aggregation logic are testable independently.
- Human-review and attribution boundaries are included in validation planning.

## Recommended Implementation Order

Recommended future sequence for this work:

1. Define the team orchestrator and team-state model.
2. Define role-specific agent contracts and delegation packets.
3. Add aggregation and conflict-resolution behavior.
4. Add role-scoped tools, MCP access, and grounding rules.
5. Add UI support for team progress and contribution visibility.
6. Add cost, latency, and bounded-execution controls.
7. Add validation and test coverage for orchestration behavior.

## Risks And Open Questions

- Too much autonomy could reduce user trust unless review and visibility remain strong.
- Poorly scoped roles could increase cost without improving results.
- Conflict resolution may be difficult if sub-agents produce incompatible edits against the same files.
- Multi-agent orchestration may intersect heavily with future identity, governance, and template-packaging features.
- The system should avoid duplicating the single-agent loop logic in a separate orchestration stack if it can extend the existing framework instead.

## Definition Of Done

This future work is well-defined when:

- a coordinated team-orchestration model is documented
- specialized agent roles and delegation contracts are defined
- aggregation, conflict handling, and attribution are part of the design
- human-review boundaries remain explicit for multi-agent work
- the design is clearly tied back to the SecureChatExtension approach while adapted for the web runtime
- bounded execution, UI visibility, and validation expectations are documented