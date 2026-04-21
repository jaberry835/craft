# Junior — Architecture & Design

This document is for developers who want to understand how Junior is built. It covers the high-level design, the framework abstractions, the agent loop, and how the pieces compose.

## Design Philosophy

Junior is a VS Code extension that brings agentic AI coding assistance to environments where GitHub Copilot can't reach — air-gapped networks, restricted endpoints, self-hosted models. It connects to Azure OpenAI, OpenAI, or any compatible API and provides two capabilities:

1. **Agentic chat** — an iterative model→tool→result loop that can read, write, search, and run commands in the workspace
2. **Inline completions** — ghost-text code suggestions in the editor

The architecture is influenced by [Microsoft Agent Framework](https://github.com/microsoft/agents) (the .NET agent SDK), adapted for TypeScript and the constraints of a VS Code extension. Key principles:

- **Protocol-oriented design** — core abstractions are TypeScript interfaces (`IChatClient`, `IFunctionTool`, `IContextProvider`), not concrete classes. Implementations are swappable.
- **Middleware pipelines** — cross-cutting concerns (retry, recovery, memory, context trimming) are composed as middleware rather than hardcoded into the loop.
- **Adapter pattern** — the existing `AzureOpenAIClient` (raw HTTPS, no SDK) is wrapped by `AoaiChatClientAdapter` to conform to the framework's `IChatClient` protocol. The original class is unchanged.
- **Zero external AI SDK dependency** — the AOAI client makes raw HTTPS calls with manual SSE parsing. This keeps the extension deployable in environments where npm registries are unavailable.

## Module Map

```
src/
├── extension.ts              Entry point — wires everything together
├── agentLoop.ts              Core orchestrator (model→tool loop)
├── agentPrompt.ts            System prompt (single source of truth)
├── aoaiClient.ts             Azure OpenAI HTTP client (streaming SSE)
├── builtinTools.ts           Tool definitions + handlers (20+ tools)
├── chatViewProvider.ts       Webview panel — UI ↔ agent loop bridge
├── agentRuntime.ts           AgentRuntime interface (shared by both runtimes)
├── copilotCliSupport.ts      Copilot CLI detection, BYOK config, launch helpers
├── copilotSdkRuntime.ts      AgentRuntime impl using @github/copilot-sdk
├── permissions.ts            Permission level logic (local + Copilot CLI)
├── mcpClient.ts              MCP server integration (stdio + HTTP)
├── sessionManager.ts         Chat history persistence (JSON on disk)
├── config.ts                 Settings access (dual-namespace fallback)
├── types.ts                  Shared wire-format types
│
├── contextManager.ts         Context window management + trimming
├── tokenTracker.ts           Session token/request usage tracking
├── toolValidator.ts          JSON Schema argument validation
├── diffUtils.ts              LCS-based line diff computation
├── inlineDiffDecorator.ts    Inline diff rendering + Accept/Reject CodeLens
├── inlineCompletionProvider.ts  Ghost-text completions (FIM-style)
├── commandRegistrar.ts       VS Code command registration
│
├── workspaceIndexer.ts       File tree indexing
├── symbolIndexer.ts          Document symbol indexing (LSP)
├── semanticIndexer.ts        TF-IDF semantic search (offline, no embeddings)
├── retrievalRanker.ts        Multi-signal file relevance ranking
├── repoPatternStore.ts       Learned repo patterns (frequent files, commands)
├── taskMemory.ts             Intra-task working memory
│
├── framework/                Agent framework abstractions
│   ├── types.ts              Framework-level types (decoupled from wire format)
│   ├── chatClient.ts         IChatClient protocol + ChatClientWithMiddleware wrapper
│   ├── middleware.ts          Three middleware layer interfaces + MiddlewarePipeline
│   ├── tools.ts              IFunctionTool, ToolRegistry, ToolExecutor
│   ├── toolAdapter.ts        Bridges BuiltinTools/MCP → IFunctionTool
│   ├── contextProvider.ts    IContextProvider (before/after run hooks)
│   ├── aoaiAdapter.ts        AzureOpenAIClient → IChatClient adapter
│   └── index.ts              Barrel re-export
│
└── middleware/                Concrete middleware implementations
    ├── retryMiddleware.ts          Tool call retry (FunctionMiddleware)
    ├── autofixMiddleware.ts        Post-edit diagnostic fix cycles (AgentMiddleware)
    ├── contextTrimMiddleware.ts    Context window fitting (ChatMiddleware)
    ├── recoveryMiddleware.ts       3-tier API error recovery (ChatMiddleware)
    ├── memoryMiddleware.ts         Task memory + repo pattern injection (AgentMiddleware)
    ├── streamBufferMiddleware.ts   Text buffering + narration logic
    ├── contextProviders.ts         Custom instructions, workspace context, investigation
    └── index.ts                    Barrel re-export
```

## The Agent Loop

`agentLoop.ts` is the core orchestrator. It runs an iterative loop:

```
User message
    → build system prompt + context
    → stream LLM response
    → if tool calls: execute tools, append results, loop
    → if no tool calls: emit final text, stop
```

Each iteration is one API request. A typical task (read files, make edits, verify) runs 8–25 iterations. The loop has a configurable ceiling (`agent.maxIterations`, default 25) with a user-controlled continuation prompt at the limit.

### Iteration anatomy

1. **Context trimming** — `ContextManager.trimIfNeeded()` compresses older messages when estimated tokens exceed 70% of the context window. Older tool-call/result groups are collapsed into one-line summaries.
2. **Memory injection** — Task memory and repo patterns are spliced in as system messages (version-gated to avoid redundant injection).
3. **LLM streaming** — `aoaiClient.streamChat()` opens a streaming SSE connection. Chunks are dispatched to a `StreamBufferMiddleware` that manages text buffering, narration display timing, and the transition from "working" UI to message bubbles.
4. **Tool execution** — Read-only tools run in parallel; write tools run sequentially. Each call goes through `ToolExecutor` → `RetryMiddleware` → handler.
5. **Post-edit validation** — After the model stops generating tool calls, `AutofixMiddleware` checks VS Code diagnostics on edited files. If errors exist, it injects them and continues the loop (up to 3 cycles).

### Error recovery

The loop has a 3-tier recovery strategy for API failures:

| Attempt | Strategy |
|---------|----------|
| 1 | Emergency context trim (35% of window) |
| 2 | Reasoning-compatible parameters (`system`→`developer` role, drop temperature) |
| 3 | Fail over to a different deployment from the configured list |

Rate-limit retries (HTTP 429) are handled at the HTTP layer with `Retry-After`-aware exponential backoff and a live countdown in the UI.

## The Framework Layer

The `framework/` directory provides reusable abstractions inspired by Microsoft Agent Framework. These are intentionally decoupled from Junior-specific code — they define protocols, not policies.

### IChatClient

```typescript
interface IChatClient {
    getResponse(messages, options?): Promise<ChatResponse>;
    getResponseStream(messages, options?): AsyncGenerator<ChatStreamChunk>;
    readonly modelId: string;
}
```

The LLM provider abstraction. `AoaiChatClientAdapter` wraps the existing `AzureOpenAIClient` to implement this. Any backend (Anthropic, Ollama, local models) could be supported by implementing `IChatClient`.

### IFunctionTool

```typescript
interface IFunctionTool {
    readonly name: string;
    readonly definition: ToolDefinition;     // OpenAI JSON Schema
    readonly isReadOnly: boolean;
    readonly requiresConfirmation: boolean;
    execute(args): Promise<ToolResult>;
    validate(args): ValidationResult;
}
```

Every tool (builtin or MCP) is wrapped in this interface. `FunctionTool` is the default implementation; `toolAdapter.ts` bridges the existing `BuiltinTools` handlers and MCP-discovered tools into `IFunctionTool` instances registered in a `ToolRegistry`.

### Three Middleware Layers

The framework defines three interception points, each with its own context type:

```
AgentMiddleware          wraps the entire agent run
  └─ ChatMiddleware      wraps individual LLM API calls
  └─ FunctionMiddleware  wraps individual tool executions
```

Each middleware receives a typed context object and a `next()` function. It can pre-process (modify context), post-process (inspect results), short-circuit (return early), or retry (call `next()` again).

| Layer | Context | Concrete implementations |
|-------|---------|------------------------|
| `AgentMiddleware` | `AgentContext` (messages, tools, iteration, editedFiles, state bag) | AutofixMiddleware, MemoryMiddleware |
| `ChatMiddleware` | `ChatContext` (client, messages, options, stream flag) | ContextTrimMiddleware, RecoveryMiddleware |
| `FunctionMiddleware` | `FunctionContext` (tool, args, callId, state bag) | RetryMiddleware |

Middleware is composed via `MiddlewarePipeline`, which chains handlers from outermost to innermost using the classic `next()` delegation pattern.

### IContextProvider

```typescript
interface IContextProvider {
    readonly name: string;
    beforeRun?(context: AgentContext): Promise<ChatMessage[] | void>;
    afterRun?(context: AgentContext, response: AgentResponse): Promise<void>;
}
```

Context providers run before/after the agent loop and inject system messages. Three are active:

- **CustomInstructionsProvider** — loads `.junior/instructions.md` or `.github/copilot-instructions.md` from the workspace
- **WorkspaceContextProvider** — injects open editors, diagnostics, active file, workspace name
- **InvestigationContextProvider** — uses `RetrievalRanker` to identify relevant files from the user's query and pre-load context

### ResponseStream

*Removed.* The original `ResponseStream` abstraction (composable async iterable with transform hooks) was removed during the framework cleanup. Streaming is handled directly by `IChatClient.getResponseStream()` with `ChatMiddleware.processStream()` for interception.

## Tool System

Tools are the agent's interface to the workspace. There are ~20 builtin tools registered in `builtinTools.ts`:

| Category | Tools |
|----------|-------|
| **File I/O** | `read_file`, `write_file`, `edit_file`, `replace_lines`, `delete_file` |
| **Navigation** | `list_directory`, `get_file_tree`, `search_files` |
| **Symbols** | `get_document_symbols`, `find_symbol`, `go_to_definition`, `find_references` |
| **Search** | `grep_search`, `semantic_search` |
| **Diagnostics** | `get_diagnostics`, `apply_code_action`, `rename_symbol` |
| **Terminal** | `run_terminal_command`, `check_terminal_output` |
| **Planning** | `set_plan`, `update_plan_step` |
| **Editor** | `get_open_editors` |

### Security

All file tools validate paths through `validatePath()`:

- Resolves against workspace root
- Rejects null bytes, UNC paths (`\\server\...`), and any path that resolves outside the workspace
- Traversal attacks (`../../etc/passwd`) are blocked by the normalized-prefix check

Write tools (`write_file`, `edit_file`, `replace_lines`) snapshot the original file content before modification, enabling the undo/diff system.

### MCP Integration

External tools are discovered via MCP (Model Context Protocol). `McpClient` supports both stdio-based (local process) and HTTP-based (remote endpoint) MCP servers. Server configurations are defined in VS Code settings. Discovered tools are adapted into `IFunctionTool` via `toolAdapter.ts` and appear alongside builtins — the agent doesn't distinguish between them.

## Copilot CLI Runtime

Junior supports two agent runtimes, selectable by the user. Both implement the `AgentRuntime` interface (`agentRuntime.ts`):

```typescript
interface AgentRuntime {
    isRunning(): boolean;
    getMessages(): ChatMessage[];
    setMessages(messages: ChatMessage[]): void;
    clearMessages(): void;
    cancel(): void;
    run(mode, text, images?, files?, displayText?): Promise<void>;
    resolveConfirmation?(actionId, approved, allowSession?): void;
    setPermissionLevel?(level: AgentPermissionLevel): void;
    getSessionState?(): RuntimeSessionState | undefined;
    restoreSessionState?(state): Promise<void>;
    dispose?(): void;
}
```

| Runtime | Implementation | Backend |
|---------|---------------|---------|
| **Local** | `agentLoop.ts` + framework middleware | Direct HTTPS to Azure OpenAI / OpenAI-compatible APIs |
| **Copilot CLI** | `CopilotSdkRuntime` (`copilotSdkRuntime.ts`) | Spawns GitHub Copilot CLI in server mode via `@github/copilot-sdk` |

### How it works

`CopilotSdkRuntime` spawns the Copilot CLI as a child process using the `@github/copilot-sdk` package (`CopilotClient`). Communication is over stdio. The lifecycle:

1. **Client start** — `CopilotClient` launches the CLI binary resolved by `copilotCliSupport.ts`
2. **Session create** — A `CopilotSession` is created with the workspace directory, system prompt, MCP server configs, and optional BYOK provider settings
3. **Prompt loop** — `session.sendAndWait()` sends the user message and blocks until the session goes idle. The CLI internally runs its own agent loop (tool calls, context management, etc.)
4. **Event streaming** — The runtime subscribes to SDK events (`assistant.message_delta`, `tool.execution_start`, `tool.execution_complete`, `assistant.reasoning_delta`, `assistant.usage`, `session.usage_info`) and translates them into the same `ExtensionMessage` protocol the webview expects

The UI is runtime-agnostic — working blocks, tool progress indicators, streaming text, and permission prompts all work identically regardless of which runtime is active.

### Availability detection

`copilotCliSupport.ts` determines whether the Copilot CLI runtime is available:

1. Resolve the CLI executable — checks `junior.copilotCli.path` (or `copilot` on PATH), handling Windows `.cmd`/`.bat` shims via `cmd.exe /d /s /c` wrapping
2. Detect auth mode:
   - **GitHub mode** — GitHub token env vars (`GH_TOKEN`, `GITHUB_TOKEN`, `COPILOT_GITHUB_TOKEN`) or a non-empty `~/.copilot` home directory
   - **BYOK mode** — user-configured provider (OpenAI, Azure, or Anthropic) with base URL, model, and credentials (API key, bearer token, or VS Code authentication session)

If neither auth mode is satisfied, the runtime is marked unavailable with a diagnostic reason.

### BYOK (Bring Your Own Key)

BYOK mode routes the Copilot CLI through a user-specified LLM provider instead of GitHub's backend. Configuration is read from `junior.copilotCli.*` settings or environment variables:

| Setting | Env var | Purpose |
|---------|---------|---------|
| `copilotCli.providerType` | `COPILOT_PROVIDER_TYPE` | `openai`, `azure`, or `anthropic` |
| `copilotCli.providerBaseUrl` | `COPILOT_PROVIDER_BASE_URL` | API endpoint URL |
| `copilotCli.model` | `COPILOT_MODEL` | Model / deployment ID |
| `copilotCli.providerApiKey` | `COPILOT_PROVIDER_API_KEY` | API key |
| `copilotCli.providerBearerToken` | `COPILOT_PROVIDER_BEARER_TOKEN` | Bearer token (alternative to API key) |
| `copilotCli.providerWireApi` | `COPILOT_PROVIDER_WIRE_API` | Wire protocol: `completions` or `responses` |

For Azure and Anthropic providers, bearer credentials can also come from a VS Code authentication session (`copilotCli.providerBearerTokenSource = vscode-auth-session`), enabling Entra ID / managed identity flows without storing secrets in settings.

### Permission model

The Copilot CLI issues permission requests for write and shell operations. `CopilotSdkRuntime` routes these through the same confirmation UI used by the local runtime. `permissions.ts` controls auto-approval:

- **Read** operations are always auto-approved
- **Write** and **shell** operations respect `copilotCli.autoApproveWrites` / `copilotCli.autoApproveTerminal` settings
- The `bypass` permission level auto-approves everything
- Session-level approval (user clicks "Allow for this session") is tracked per category

### Session management

Sessions persist across messages within a conversation. `CopilotSdkRuntime` stores the backend `sessionId` and attempts `client.resumeSession()` on the next message. If resume fails (CLI restarted, session expired), it transparently creates a new session. Session state is included in `SessionManager` persistence for restore-on-reload.

## Context Management

### Context Window Trimming

`ContextManager` estimates token usage (chars ÷ 3.5 heuristic) and trims when the conversation exceeds 70% of the configured window (default 128K tokens). Trimming strategy:

1. Always preserve the system prompt and the tail (recent user message + active tool loop)
2. Collapse the middle into summaries: `read_file(src/foo.ts) → 42 lines of code`
3. If still over budget, progressively truncate the summary itself

Emergency trim (used by `RecoveryMiddleware`) is more aggressive, targeting 35% of the window.

### Task Memory

`AgentTaskMemory` maintains structured working memory within a single task:

- **Objective** — the user's latest request
- **Relevant files** — observed during investigation, with reasons
- **Findings** — key observations (capped at 8)
- **Diagnostics** — errors/warnings seen
- **Failed actions** — tool calls that didn't succeed

This is injected as a system message at the start of each iteration (version-gated to avoid redundant re-injection). It prevents the agent from re-discovering the same context when earlier messages have been trimmed.

### Repo Pattern Store

`RepoPatternStore` persists learned patterns across sessions (saved to `learnedPatterns.json`):

- Frequently accessed files
- Successful build/test commands

These are injected as hints so the agent knows "this repo uses `npm run build`" without needing to discover it each time.

## Retrieval & Search

Three indexing systems feed into the `RetrievalRanker`:

| Indexer | What it does | Storage |
|---------|-------------|---------|
| `WorkspaceIndexer` | File tree with metadata (size, language, gitignore-aware) | In-memory |
| `SymbolIndexer` | Document symbols via VS Code's LSP integration | In-memory |
| `SemanticIndexer` | TF-IDF over code chunks (offline, no embeddings API needed) | Persisted to disk |

`RetrievalRanker` scores files using multiple signals: explicit user mentions, active editor, diagnostics, semantic similarity, symbol matches, and file recency. The top candidates are injected as context before the agent loop starts.

The semantic indexer uses TF-IDF rather than embedding vectors — a deliberate choice for air-gapped environments where an embedding endpoint may not be available.

## UI Layer

### Chat Panel

`ChatViewProvider` implements `vscode.WebviewViewProvider`. The webview (`media/chat.js`) communicates with the extension host via a typed message protocol:

- **Extension → Webview**: `ExtensionMessage` (text chunks, tool calls/results, working blocks, status, plans)
- **Webview → Extension**: `WebviewMessage` (user messages, file approvals, continuations, model switches)

The chat UI renders GitHub Copilot-style working blocks — collapsible summaries of tool activity (files read, searches run, edits made) with progress indicators.

### Inline Diff

When the agent edits files, `InlineDiffDecorator` renders changes directly in the editor:

- Green gutter + background for additions
- Red ghost lines for deletions
- CodeLens "Accept | Reject" controls per hunk
- Hunk-level and file-level resolution

Original file content is snapshotted before edits. Rejecting a hunk restores the original content.

### Inline Completions

`InlineCompletionProvider` delivers ghost-text suggestions using a separate (optionally different) model deployment. Features:

- Single-line vs. multi-line detection (adjusts max tokens and prompt)
- 150ms debounce + 2.5s cooldown after dismissals
- Type-ahead cache (reuses the tail of a previous completion if the user types into it)
- Neighboring-tab context (open editors inform the prompt)
- Comment suppression heuristic

## Configuration

Settings use a dual-namespace scheme for backward compatibility:

```typescript
getSetting('agent.maxIterations')
// Reads: junior.agent.maxIterations
// Falls back to: securechat.agent.maxIterations
```

`config.ts` provides `getSetting<T>()` and `updateSetting()`. The `junior.*` namespace is canonical; `securechat.*` is the legacy namespace from before the rename.

Provider options:

| Provider | How it connects |
|----------|----------------|
| `direct` | Azure OpenAI endpoint + API key |
| `apim` | Azure API Management gateway URL + subscription key |
| `openai` | OpenAI-compatible API (OpenAI, Ollama, LM Studio, etc.) |
| `copilot-cli` | GitHub Copilot CLI spawned via `@github/copilot-sdk` (GitHub auth or BYOK) |

## Session Persistence

`SessionManager` stores conversation history as JSON files on disk (one per session, max 20 retained). Sessions include messages, working-block UI state, and metadata. Legacy migration from VS Code Memento storage is handled automatically.

## Build & Deploy

```bash
npm run compile          # TypeScript → out/ (per-file, with source maps — dev)
npm run watch            # Watch mode (default build task)
npx tsc --noEmit         # Type-check without emitting
.\deploy.ps1 build       # Production: type-check → esbuild bundle → VSIX
```

Production builds use **esbuild** to bundle all TypeScript into a single minified `out/extension.js` (~200 KB). The VSIX ships this single bundle plus the webview assets — no source maps, no declaration files.

The extension has no runtime npm dependencies bundled — it uses raw Node.js (`https`, `fs`, `child_process`, `crypto`) and the VS Code API. The VSIX is self-contained.
