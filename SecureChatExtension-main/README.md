# Junior — AI Assistant for Offline Environments

A VS Code extension that provides a **Copilot-like autonomous agent** powered by **Azure OpenAI**, designed for air-gapped / offline developer environments with no internet access and no GitHub Copilot availability.

## Features

- **Agent Mode** — Autonomous tool-calling loop: the AI reads files, edits code, runs terminal commands, and searches your workspace without manual intervention.
- **Built-in Tools** — 20 workspace tools: `read_file`, `write_file`, `edit_file`, `delete_file`, `list_directory`, `search_files`, `grep_search`, `semantic_search`, `get_file_tree`, `get_document_symbols`, `find_symbol`, `go_to_definition`, `find_references`, `rename_symbol`, `run_terminal_command`, `get_diagnostics`, `get_open_editors`, `apply_code_action`, `set_plan`, `update_plan_step`.
- **MCP (Model Context Protocol)** — Connect external MCP tool servers over stdio for extensible tool capabilities.
- **Azure OpenAI Streaming** — Direct HTTPS connection to your Azure OpenAI resource with streaming responses (no SDK, zero external runtime dependencies). Supports both direct AOAI and API Management (APIM) proxy connections.
- **Multi-Model Selection** — Configure multiple deployments and switch between them from the chat panel.
- **Confirmation Dialogs** — Approve or deny file writes, deletions, and terminal commands before execution.
- **Context Menu Actions** — Right-click selected code to Explain, Review, or Fix it.
- **Session Persistence** — Chat history is persisted across VS Code restarts.

## Requirements

- VS Code 1.85.0 or later
- Network access to your **Azure OpenAI** resource (internal network; no public internet required)
- An Azure OpenAI deployment that supports function/tool calling (e.g., `gpt-4o`, `gpt-4-turbo`, `gpt-35-turbo-1106` or newer)

## Setup

### 1. Install the Extension

Use the helper script from the project root:

```powershell
# Build VSIX
.\deploy.ps1 build

# Or build and print install path/instructions
.\deploy.ps1 install
```

Then in VS Code:
1. Open **Command Palette** (`Ctrl+Shift+P`)
2. Run **Extensions: Install from VSIX...**
3. Select the generated `junior-*.vsix`
4. Run **Developer: Reload Window**

For extension development/testing, you can still press **F5** to launch the Extension Development Host.

### 2. Configure Azure OpenAI

Junior supports two connection modes: **direct** to an Azure OpenAI resource, or through an **API Management (APIM)** proxy.

#### Option A — Direct Azure OpenAI

Open VS Code Settings (`Ctrl+,`) and search for `Junior`, or add to your `settings.json`:

```jsonc
{
  "junior.azureOpenAI.provider": "direct",
  "junior.azureOpenAI.endpoint": "https://your-resource.openai.azure.com",
  "junior.azureOpenAI.deployments": [
    {
      "name": "GPT-4o",
      "deploymentId": "gpt-4o",
      "apiVersion": "2024-06-01"
    },
    {
      "name": "GPT-4 Turbo",
      "deploymentId": "gpt-4-turbo",
      "apiVersion": "2024-06-01"
    }
  ],
  "junior.azureOpenAI.activeDeployment": "gpt-4o"
}
```

#### Option B — Via API Management (APIM)

If your Azure OpenAI is behind an APIM gateway, set the provider to `apim` and supply the APIM base URL (including any path prefix):

```jsonc
{
  "junior.azureOpenAI.provider": "apim",
  "junior.azureOpenAI.apimBaseUrl": "https://my-apim.azure-api.net/foundryapi",
  "junior.azureOpenAI.deployments": [
    {
      "name": "GPT-5.3 Chat",
      "deploymentId": "gpt-5.3-chat",
      "apiVersion": "2025-03-01-preview"
    }
  ],
  "junior.azureOpenAI.activeDeployment": "gpt-5.3-chat"
}
```

The APIM endpoint must expose the standard Azure OpenAI Chat Completions API path (`/openai/deployments/{deployment-id}/chat/completions`). The API key is sent in the `api-key` header, which works with both direct AOAI and most APIM configurations.

> **Note:** Deployments must be configured manually in `junior.azureOpenAI.deployments` — they are not auto-discovered. The `deploymentId` values must match the deployment names in your Azure OpenAI resource exactly.

#### Store your API key

Then store your API key securely:

1. Open **Command Palette** (`Ctrl+Shift+P`)
2. Run **Junior: Set API Key**
3. Paste your key into the password prompt

The key is stored in VS Code's **SecretStorage**, which uses your OS credential manager (Windows Credential Manager, macOS Keychain, or Linux secret service). **No plaintext is written to disk** — not in settings.json, not in any config file.

> **Backward compatibility:** If you previously had `securechat.*` keys in your settings.json, Junior still reads them as a fallback. New settings should use `junior.*`.

### 3. (Optional) Configure MCP Servers

Add MCP tool servers to extend the agent's capabilities. Junior supports two transports and can also reuse MCP server definitions from other VS Code extensions (for example the official MCP extension via `mcp.servers`) by default.

**stdio** — spawn a local process:

```jsonc
{
  "junior.mcp.servers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/dir"]
    },
    "database": {
      "command": "python",
      "args": ["my_db_mcp_server.py"],
      "env": { "DB_CONNECTION": "..." },
      "cwd": "/path/to/server"
    }
  }
}
```

**HTTP** — connect to a remote MCP server endpoint:

```jsonc
{
  "junior.mcp.servers": {
    "remote-tools": {
      "url": "https://my-mcp-server.internal:8080/mcp",
      "headers": {
        "Authorization": "Bearer my-token"
      }
    }
  }
}
```

You can mix both transports — servers with `command` use stdio, servers with `url` use HTTP.

By default, Junior merges `junior.mcp.servers` with external settings listed in `junior.mcp.externalServerSettings` (defaults to `["mcp.servers"]`). If two settings define the same server name, `junior.mcp.servers` wins. Set `junior.mcp.includeExternalServers` to `false` to only use Junior's own setting.

**Complete example (explicitly using external MCP servers):**

```jsonc
{
  "junior.azureOpenAI.provider": "direct",
  "junior.azureOpenAI.endpoint": "https://your-resource.openai.azure.com",
  "junior.azureOpenAI.deployments": [
    {
      "name": "GPT-4o",
      "deploymentId": "gpt-4o",
      "apiVersion": "2024-06-01"
    }
  ],
  "junior.azureOpenAI.activeDeployment": "gpt-4o",
  "junior.mcp.includeExternalServers": true,  //use the vscode MCP servers in extensions view
  "junior.mcp.externalServerSettings": [
    "mcp.servers"
  ],
  // Optional local overrides/additions.
  // Leave empty if you only want external servers.
  "junior.mcp.servers": {
      // "msdocs": {
       // "url": "https://learn.microsoft.com/api/mcp"
       // }
  }
}
```

MCP tools appear alongside built-in tools with names prefixed by their server name (e.g., `mcp_filesystem_read_file`).

## Usage

### Open the Chat Panel

- Click the **Junior** icon in the Activity Bar (left sidebar), or
- Press `Ctrl+Shift+I`, or
- Run **Junior: Open Chat** from the Command Palette

### Chat with the Agent

Type a message and press **Enter**. The agent will:
1. Analyze your request
2. Autonomously call tools (read files, search code, edit files, etc.)
3. Stream its response with tool call visualization
4. Ask for confirmation before destructive actions (file writes, terminal commands)

Press **Shift+Enter** for a newline without sending.

### Commands

| Command | Description |
|---------|-------------|
| `Junior: Open Chat` | Focus the chat panel |
| `Junior: New Chat Session` | Start a fresh conversation |
| `Junior: Select Model` | Switch between configured deployments |
| `Junior: Index Workspace` | Re-scan workspace files (manual refresh) |
| `Junior: Explain Selected Code` | Explain highlighted code |
| `Junior: Review Selected Code` | Code review of selection |
| `Junior: Fix Selected Code` | Fix issues in selection |
| `Junior: Manage MCP Servers` | Connect/disconnect MCP servers |
| `Junior: Cancel Agent Run` | Stop the current agent loop |
| `Junior: Toggle Chat History` | Show/hide the session history panel |
| `Junior: Set API Key` | Store API key securely in OS credential manager |

`Index Workspace` also runs automatically on activation. Use it manually after major file/folder changes or when workspace settings (exclude patterns, max file size) change.

> **Index Persistence:** The file index and semantic index are cached under VS Code's global storage directory. On subsequent activations, only files whose size or modification time changed are re-processed, which dramatically reduces startup time for large repositories.

### Context Menu

Select code in the editor, right-click, and choose:
- **Junior: Explain Selected Code**
- **Junior: Review Selected Code**
- **Junior: Fix Selected Code**

## Settings Reference

| Setting | Default | Description |
|---------|---------|-------------|
| `junior.azureOpenAI.provider` | `"direct"` | Connection mode: `direct` for AOAI, `apim` for API Management proxy |
| `junior.azureOpenAI.endpoint` | `""` | Azure OpenAI endpoint URL (used when provider is `direct`) |
| `junior.azureOpenAI.apimBaseUrl` | `""` | APIM gateway base URL with path prefix (used when provider is `apim`) |
| `junior.azureOpenAI.apiKey` | `""` | API key |
| `junior.azureOpenAI.deployments` | `[]` | List of `{ name, deploymentId, apiVersion }` — configured manually |
| `junior.azureOpenAI.activeDeployment` | `""` | Currently active deployment ID |
| `junior.azureOpenAI.apiVersion` | `"2024-06-01"` | Default API version |
| `junior.maxTokens` | `4096` | Max tokens per response |
| `junior.temperature` | `0.3` | Response temperature (0–1) |
| `junior.workspace.maxFileSize` | `100000` | Max file size (bytes) to index |
| `junior.workspace.excludePatterns` | `[...]` | Glob patterns excluded from indexing |
| `junior.agent.maxIterations` | `25` | Max tool-call loops per turn |
| `junior.agent.contextWindow` | `128000` | Model context window size (tokens). Older messages are summarized when approaching this limit. |
| `junior.agent.contextThreshold` | `0.70` | Fraction of context window (0.3–0.95) at which older messages are summarized |
| `junior.agent.confirmWrites` | `true` | Confirm before file write/delete |
| `junior.agent.confirmTerminal` | `true` | Confirm before terminal commands |
| `junior.mcp.servers` | `{}` | MCP server configurations (overrides duplicates from external settings) |
| `junior.mcp.includeExternalServers` | `true` | Also load MCP servers from external settings keys |
| `junior.mcp.externalServerSettings` | `["mcp.servers"]` | External settings paths to merge MCP servers from |

## Architecture

```
src/
├── extension.ts          — Activation entry point, command registration
├── types.ts              — Shared TypeScript type definitions
├── config.ts             — Settings helper with legacy namespace fallback
├── aoaiClient.ts         — Azure OpenAI streaming client (raw HTTPS)
├── agentLoop.ts          — Core agent orchestrator (tool-calling loop)
├── contextManager.ts     — Context window management (token estimation, message trimming)
├── toolValidator.ts      — Tool argument validation (schema checking before execution)
├── builtinTools.ts       — 20 built-in workspace tools
├── mcpClient.ts          — MCP stdio/HTTP client for external tool servers
├── workspaceIndexer.ts   — Workspace file scanning and search (cached to disk)
├── symbolIndexer.ts      — Symbol indexing (functions, classes, etc.)
├── semanticIndexer.ts    — TF-IDF semantic indexing for natural-language search (cached to disk)
├── planTreeProvider.ts   — Plan tree view provider for agent step tracking
├── sessionManager.ts     — Chat session persistence (globalState)
└── chatViewProvider.ts   — Webview UI (sidebar chat panel)
```

## Development

```bash
npm install          # Install dependencies
npm run compile      # Build once
npm run watch        # Build in watch mode
npm run lint         # Run ESLint
npm run package      # Create .vsix package
```

Press **F5** to launch the Extension Development Host with the extension loaded.

## Security Notes

- The API key is stored in VS Code's **SecretStorage** (OS credential manager) when set via **Junior: Set API Key**. No plaintext is written to disk. The legacy `settings.json` key is supported as a fallback but is not recommended.
- All HTTP calls go directly to your Azure OpenAI endpoint (or APIM gateway) — **no data leaves your network**.
- The webview uses a strict Content Security Policy with nonce-based script/style execution.

---

## How Junior Works — Technical Deep Dive

This section explains the internal mechanics of Junior and the quality-of-life improvements that bring it closer to GitHub Copilot's agent mode experience.

### The Agent Loop

Junior's core is an autonomous **tool-calling loop** in `agentLoop.ts`. When you send a message:

1. A **context pack** is assembled automatically — open editors, active file/cursor position, workspace diagnostics, and workspace name — and injected as a system message so the model starts with situational awareness, similar to how GHCP populates its context window.
2. Your message is appended to the conversation and sent to Azure OpenAI with the full tool catalog (built-in + MCP tools).
3. If the model responds with tool calls, each is executed and results are fed back. This loops for up to `maxIterations` (default 25).
4. If the model responds with text (no tool calls), the loop ends and the response is streamed to the UI.

### Built-in Tools (20)

The agent has direct access to the workspace through built-in tools registered in `builtinTools.ts`:

| Tool | Purpose |
|------|---------|
| `read_file` | Read file contents (path-validated to workspace) |
| `write_file` | Create or overwrite a file |
| `edit_file` | Surgical find-and-replace within a file |
| `delete_file` | Remove a file |
| `list_directory` | List folder contents |
| `search_files` | Filename search across the workspace index |
| `grep_search` | Regex/text search in file contents |
| `semantic_search` | Natural-language code search using TF-IDF semantic indexing |
| `get_file_tree` | Full workspace file tree |
| `get_document_symbols` | List symbols (classes, functions, methods, etc.) for a specific file |
| `find_symbol` | Find symbol definitions by name across the indexed workspace |
| `go_to_definition` | Find the definition location for a symbol in a file |
| `find_references` | Find all references to a symbol across the workspace |
| `rename_symbol` | Project-wide rename (like F2) — updates all references, imports, and usages |
| `run_terminal_command` | Execute shell commands with configurable timeout |
| `get_diagnostics` | Read VS Code's language server diagnostics |
| `get_open_editors` | List currently open editor tabs |
| `apply_code_action` | List and apply VS Code quick-fixes at a specific line |
| `set_plan` | Set the agent's plan with 3–6 specific steps for the current task |
| `update_plan_step` | Update the status of a plan step (in_progress, completed, failed) |

All file-path parameters are validated against the workspace root to prevent path traversal attacks.

### Post-Edit Validation Pipeline

After every `write_file`, `edit_file`, or `apply_code_action`, the agent **automatically collects diagnostics** from VS Code's language server (after a 750ms settling delay). Errors and warnings are appended to the tool result, so the model sees them immediately and can self-correct without a separate diagnostic-checking step. The system prompt instructs the model to fix any errors it introduced.

### Robust Retry Policy

Tool calls are wrapped in `executeToolWithRetry()`. If a tool fails, it is retried once (after a 600ms delay) before reporting failure to the model. Certain tools are excluded from retry where it wouldn't help: terminal commands (user may have declined), code actions, and invalid-path errors.

### Terminal Command Improvements

The `run_terminal_command` tool includes several safeguards:

- **Dangerous command blocking** — patterns like `rm -rf /` and `format C:` are rejected outright.
- **Configurable timeout** — the model can specify `timeout_ms` (5–120 seconds, default 30s) for longer builds.
- **Partial-success on timeout** — if a command times out but produced stdout/stderr output, the result is returned as a success with a timeout note rather than a failure. This prevents the agent from marking lengthy builds as failed when they actually produced useful output.
- **Description warns the model** — the tool description explicitly tells the model not to run watch-mode or long-running commands.

### Confirmation Dialogs & Session-Level Approval

By default, file writes and terminal commands require user confirmation. Each confirmation dialog presents three options:

- **Allow** — approve this one action
- **Allow for Session** — approve this action and skip confirmation for all future actions of the same category (terminal or write) for the rest of the session
- **Deny** — reject the action

Categories are tracked independently — you can allow all terminal commands without auto-approving file writes. Session approvals reset when you start a new chat session. This mirrors GitHub Copilot's "allow for this session" workflow.

### Chat History & Session Persistence

Sessions are persisted to VS Code's `globalState` and survive window reloads:

- **Automatic restore** — on reload, Junior restores the last active session including the full conversation, tool calls, and agent loop state.
- **History panel** — click the clock icon ($(history)) in the view title bar to see all past sessions with titles, message counts, and relative timestamps. Click to switch; click ✕ to delete.
- **Storage limits** — to stay within `globalState`'s ~1 MB budget:
  - **20 sessions max** — oldest are pruned automatically when exceeded
  - **8,000 character cap** per message — large tool outputs are trimmed before persistence
  - **Base64 images stripped** — inline image data is removed from stored messages to prevent storage bloat
- Auto-titling — sessions are named from the first user message (truncated to 60 characters).

### MCP (Model Context Protocol) Client

Junior can connect to external tool servers using the Model Context Protocol, supporting two transports:

- **stdio** — spawns a local process, communicates via JSON-RPC over stdin/stdout. Used for local tool servers.
- **HTTP/SSE (Streamable HTTP)** — sends JSON-RPC POST requests to a URL endpoint. Handles both `application/json` and `text/event-stream` responses (SSE). Tracks `Mcp-Session-Id` per the Streamable HTTP specification.

Transport is auto-detected from the configuration: if `command` is present, stdio is used; if `url` is present, HTTP is used. MCP tools are discovered via the `tools/list` method and appear in the tool catalog with a server-name prefix.

### Context Pack Assembly

Before the first model call in each turn, `buildContextPack()` gathers:

- **Open editors** — file paths of all visible editor tabs
- **Active file & cursor** — the file and line number the user is looking at
- **Active diagnostics** — current errors/warnings across all open files
- **Workspace name** — so the model knows the project context

This is injected as a `[Context Snapshot]` system message, giving the model awareness without the user needing to manually attach files.

### Workspace Indexing

Three indexers run on activation and can be re-triggered via the Index Workspace command:

1. **WorkspaceIndexer** — scans all files respecting exclude patterns and size limits, builds a filename search index.
2. **SymbolIndexer** — uses VS Code's `DocumentSymbolProvider` to index functions, classes, variables, interfaces, etc. across the workspace. Powers `find_symbols` and `get_symbol_detail`.
3. **SemanticIndexer** — splits source files into chunks, builds a TF-IDF index for natural-language code search via `semantic_search`.

### Azure OpenAI Client

`aoaiClient.ts` is a zero-dependency HTTPS client that speaks directly to the Azure OpenAI REST API. It:

- Streams responses token-by-token via SSE (`stream: true`)
- Handles tool-call function arguments that arrive across multiple SSE chunks
- Supports switching between multiple configured deployments at runtime
- Uses only Node.js built-in `https` — no npm packages, no SDK, no external dependencies

### UI Architecture

The chat panel is a VS Code `WebviewViewProvider` rendered in the sidebar. The webview HTML, CSS, and JS are all generated in `chatViewProvider.ts` (inline styles with nonce CSP) with `media/chat.js` as an external script.

Key UI features:
- **Markdown rendering** — assistant responses render headings, lists, inline code, and fenced code blocks with syntax labels and copy buttons
- **Tool call visualization** — collapsible blocks show tool name, arguments, and result with success/failure indicators
- **Working spinner** — an animated pulsing-dots indicator shows the current agent status while processing
- **Plan panel** — a collapsible step tracker showing the agent's plan with pending/in-progress/completed/failed states
- **Image paste** — paste screenshots from clipboard directly into the chat
- **File attachment** — attach workspace files to provide context
- **Model selector** — dropdown in the composer toolbar to switch deployments mid-conversation
- Terminal commands and file writes require user confirmation by default.

## License

MIT



