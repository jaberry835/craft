# Junior Workbench Agent Loop

This document describes how the current server-side agent loop works in Junior Workbench, how it maps to the SecureChatExtension architecture, and where the main web-specific adaptations live.

## Purpose

Junior Workbench is not a plain chat app. The agent loop is the runtime that lets an agent work over a file-backed workspace, inspect and change documents, ground itself in indexed content, and return a result that can be reviewed or auto-applied.

The loop is designed to stay close to the SecureChatExtension model while moving VS Code-specific behavior behind server-friendly seams.

## Main Components

- `server/services/juniorAgentLoop.ts`: owns the run lifecycle and iteration loop.
- `server/services/agentLoopFramework.ts`: provides agent, tool, and chat middleware pipelines plus the tool registry and executor.
- `server/services/juniorAgentPlanner.ts`: decides the next tool step, primarily through model-selected tool calls.
- `server/services/juniorChatRuntime.ts`: shared wrapper for model calls so planner and other model-backed steps go through the same chat middleware pipeline.
- `server/services/juniorChatMiddleware.ts`: recovery middleware for model calls.
- `server/services/juniorLoopContextManager.ts`: normalizes assistant/tool transcripts and trims older context when needed.
- `server/services/juniorAgentLoopContextProviders.ts`: injects grounding and package-document context before the loop runs.
- `server/services/juniorAgentLoopMiddleware.ts`: tracks completed tool steps and optionally auto-applies staged changes.
- `server/services/tools/`: file, package, and publish tools available to the loop.

## High-Level Flow

```mermaid
sequenceDiagram
	participant UI as Web UI
	participant Agent as SimpleJuniorAgent
	participant Loop as JuniorAgentLoop
	participant Providers as Context Providers
	participant Planner as JuniorAgentPlanner
	participant Chat as JuniorChatRuntime
	participant Tools as Tool Registry/Executor
	participant Changes as ChangeManager

	UI->>Agent: send user prompt
	Agent->>Loop: run(prompt, agentId, options)
	Loop->>Providers: beforeRun(context)
	Providers-->>Loop: grounding + package files

	loop up to 8 iterations
		Loop->>Planner: nextStep(context)
		Planner->>Chat: completeWithTools(messages, tools)
		Chat-->>Planner: assistant text or tool call
		Planner-->>Loop: next step decision

		alt tool selected
			Loop->>Tools: execute(tool, args)
			Tools->>Changes: stage edits when needed
			Tools-->>Loop: tool result + tool events
		else final assistant response
			Planner-->>Loop: stop
		end
	end

	Loop->>Changes: auto-apply if enabled
	Loop-->>Agent: assistant message + events + pending changes
	Agent-->>UI: response payload
```

Each user prompt sent to the server follows this path:

1. `SimpleJuniorAgent` receives the request and appends the user message to chat history.
2. `JuniorAgentLoop.run()` creates a fresh `LoopContext` for the turn.
3. Context providers load workspace grounding and package files before the first iteration.
4. The loop normalizes the running assistant/tool transcript.
5. The planner chooses the next tool step or stops with final assistant content.
6. If a tool is chosen, the loop appends the assistant tool-call message, executes the tool, and records the tool observation.
7. The next iteration sees the updated transcript, state bag, tool events, and staged changes.
8. After the loop stops, agent middleware can auto-apply staged changes.
9. The server returns the assistant message, tool events, grounding used, and any remaining pending changes.

The loop currently caps itself at 8 iterations per request.

## Loop Context

`LoopContext` is the runtime state shared across planning, tools, middleware, and context providers.

Important fields:

- `content`: the current user request.
- `loopMessages`: the running assistant, user, and tool transcript used for planning.
- `toolEvents`: user-visible read/search/edit activity emitted by tools and middleware.
- `grounding`: relevant snippets collected before the run.
- `packageFiles`: currently loaded package markdown files.
- `staged`: staged file changes collected during the run.
- `state`: internal per-run state bag for middleware and planner bookkeeping.
- `options.autoApproveChanges`: whether staged writes should be applied automatically after the run.

This keeps the loop state explicit and request-scoped rather than hidden in global process state.

## Planning Model

The planner is intentionally close to the extension's tool-driven agent model.

### Step selection

`JuniorAgentPlanner` works in two layers:

- It keeps a small heuristic guardrail layer for basic first-step behavior and fallback behavior.
- Its primary path asks Azure OpenAI to select from the currently available tools using tool-call output.

The planner builds a short planning prompt containing:

- the user request
- the list of still-available steps
- a recent transcript slice
- the normalized loop message history

If the model returns a tool call, that tool becomes the next loop step. If the model returns plain text without a tool call, the loop can stop with that assistant content.

## Chat Middleware And Recovery

The extension wraps model calls with chat middleware. Junior Workbench now follows the same pattern.

`JuniorChatRuntime` is the shared entry point for model calls, and `RecoveryChatMiddleware` wraps those calls with a recovery strategy. That means the same recovery behavior is used by:

- planner model calls
- package-drafting model calls

The current recovery sequence is:

1. Emergency trim: aggressively condense older context.
2. Reasoning mode: retry with reasoning-compatible options and convert system messages to developer role.
3. Fallback step: use a deployment override when one is available, otherwise retry with an even more aggressively trimmed context.

Recovery attempts are recorded in run state so the planner can surface when recovery was needed.

## Context Normalization And Trimming

The loop keeps a running transcript of assistant tool-call messages and tool results. That transcript must stay structurally valid or later model calls become fragile.

`JuniorLoopContextManager` handles two related jobs:

### Sequence normalization

It repairs or drops malformed assistant/tool sequences so tool result messages remain adjacent to the assistant tool call that created them.

### Context compaction

When the transcript grows too large, it condenses older middle sections into a system summary while preserving the newest tail of the run. This keeps the recent working set intact while reducing token pressure.

This is the web analog of the extension's context manager behavior.

## Context Providers

Before the first planning step, context providers prepare the run.

### Grounding provider

`GroundingContextProvider` refreshes the workspace index and loads grounding snippets through `GroundingService`.

### Workspace skills provider

`WorkspaceSkillsContextProvider` loads reusable workspace instructions from `SKILL.md`, `skills/<name>/SKILL.md`, `.junior/skills/<name>/SKILL.md`, and `.junior/skills/<name>.md`. Skill content is inserted as system context for the current run. Skills do not grant capabilities by themselves; the agent can only use tools exposed by its runtime configuration.

### MCP runtime context

Each run resolves the MCP servers attached to the active agent, performs live tool discovery, and supplies the discovered names, descriptions, and input schemas to the planner. Discovery results are also persisted with the MCP server configuration so the UI and runtime retain the tool inventory across restarts. A later live discovery refreshes that inventory. If refresh temporarily fails, the loop can retain the persisted schemas and reports the connection warning in its tool events.

### Package documents provider

`PackageDocumentsContextProvider` loads the workspace package markdown files into the run context.

This makes the agent start each request with fresh workspace knowledge instead of relying only on past chat.

## Tool Execution Model

Tools are registered in the shared registry and executed through the shared executor.

### Tool definition

Each tool declares:

- name and description
- read-only vs mutating behavior
- confirmation requirement and confirmation category
- parameter schema
- execution handler

### Tool validation

The executor validates required fields and basic parameter types before calling the tool.

### Tool middleware

`LoopStepTrackingMiddleware` wraps each tool execution. It:

- increments the loop iteration
- records the current tool and arguments
- marks the tool as completed
- appends a tool observation back into the loop transcript

This is how the planner gets structured memory of what just happened.

## Workspace And Package Tools

The current tool set is intentionally centered on documents and workspace files rather than code-intelligence features.

### Workspace tools

Current workspace-facing tools include:

- `inspect-workspace`
- `inspect-pending-changes`
- `list_directory`
- `search_files`
- `grep_search`
- `read_file`
- `read_files`
- `search_workspace`
- `write_file`
- `edit_file`
- `replace_lines`

These tools let the agent inspect the workspace tree, find documents, search exact text, read files with line ranges, and make either exact-string or line-range edits.

For MCP operations that accept workspace files, `call_mcp_tool` also accepts generic `workspaceFileBindings`. A binding selects workspace files with include/exclude globs and injects path/content objects at a JSON Pointer in the MCP arguments. This keeps bulk file content out of model planning context without coupling Junior to a specific MCP server or publishing tool.

### Package tools

Package-specific tools currently include:

- `identify-open-questions`
- `draft-package-updates`

The drafting tool can use Azure OpenAI through the shared chat runtime to produce candidate package content.

### Publish tool

`check-publish-readiness` checks whether remaining staged changes would block publish behavior.

## Change Handling

Mutating tools do not write directly to the workspace filesystem. They stage changes through `ChangeManager`.

That keeps a record of:

- original content
- proposed content
- path
- summary
- creation time

After the loop finishes, `AutoApplyChangesMiddleware` can automatically approve and write those staged changes when `autoApproveChanges` is enabled.

This gives the app two modes:

- review mode: changes remain staged for human approval or undo
- auto-apply mode: changes are written at the end of the run and the workspace index is refreshed

## Storage And Index Refresh

The development storage boundary is `LocalWorkspaceStorage`, which reads and writes files under the current workspace root.

`WorkspaceIndexer` maintains:

- file manifest data
- package-section detection
- a basic text index for keyword search

The index is refreshed before grounding runs and after auto-applied edits. That keeps the next agent turn aligned with the current file state.

## Relationship To SecureChatExtension

The goal is a close facsimile of the SecureChatExtension loop, with only the minimum changes needed for a web/server runtime.

Concepts intentionally preserved:

- iterative agent loop
- middleware layers
- tool registry and validation
- grounded work over files
- transcript-aware planning
- context normalization and recovery
- staged change tracking

Concepts intentionally adapted:

- VS Code APIs are replaced by server-side storage, indexing, and model-call adapters
- file writes are mediated through `ChangeManager`
- model calls run on the server through Azure OpenAI
- workspace refresh/index maintenance is explicit server behavior

## Current Limitations

The current loop is functional but still a vertical slice.

Known limits include:

- iteration cap is fixed and small
- workspace search is strong for documents and files, but not yet a full semantic/code-navigation surface
- fallback deployment recovery exists as a seam, but this repo does not yet supply multiple production deployment choices automatically
- change approval still exists in the model even when auto-apply is enabled

## Practical Mental Model

The easiest way to think about the runtime is:

- `JuniorAgentLoop` owns the run
- providers prepare context
- planner chooses the next tool
- tools read or stage changes
- middleware records what happened and can apply changes
- chat middleware keeps model calls resilient
- the workspace files remain the source of truth

See [README.md](../README.md) for the product-level overview and [JUNIOR-WORKBENCH-HANDOFF.md](./JUNIOR-WORKBENCH-HANDOFF.md) for the broader web-port architecture notes.

That is the core agent-working-over-files loop in the current web implementation.