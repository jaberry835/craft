# Junior Developer Get Started

This is the source-build and maintainer guide for Junior.

If you are installing a prebuilt `.vsix` package, use [README.md](./README.md) instead.

Junior is a VS Code extension that provides a **Copilot-like autonomous agent** powered by **Azure OpenAI** or **OpenAI**, designed for air-gapped / offline developer environments with no internet access and no GitHub Copilot availability.

## Features

- **Agent Mode** — Autonomous tool-calling loop: the AI reads files, edits code, runs terminal commands, and searches your workspace without manual intervention.
- **Built-in Tools** — 20 workspace tools: `read_file`, `write_file`, `edit_file`, `delete_file`, `list_directory`, `search_files`, `grep_search`, `semantic_search`, `get_file_tree`, `get_document_symbols`, `find_symbol`, `go_to_definition`, `find_references`, `rename_symbol`, `run_terminal_command`, `get_diagnostics`, `get_open_editors`, `apply_code_action`, `set_plan`, `update_plan_step`.
- **MCP (Model Context Protocol)** — Connect external MCP tool servers over stdio for extensible tool capabilities.
- **Azure OpenAI & OpenAI Streaming** — Direct HTTPS connection to Azure OpenAI, OpenAI, or any compatible endpoint with streaming responses (no SDK, zero external runtime dependencies). Supports direct AOAI, API Management (APIM) proxy, and OpenAI API connections.
- **Multi-Model Selection** — Configure multiple deployments and switch between them from the chat panel.
- **Inline Code Completions** — Ghost-text suggestions (like GitHub Copilot) powered by your Azure OpenAI or OpenAI model. Supports a separate fast model for completions, debounced triggering, and aggressive cancellation for responsive UX.
- **Confirmation Dialogs** — Approve or deny file writes, deletions, and terminal commands before execution.
- **Context Menu Actions** — Right-click selected code to Explain, Review, or Fix it.
- **Session Persistence** — Chat history is persisted across VS Code restarts.

## Requirements

- VS Code 1.85.0 or later
- Network access to your **Azure OpenAI** resource (internal network; no public internet required), **or** network access to the **OpenAI API** (api.openai.com)
- A model that supports function/tool calling (e.g., `gpt-4o`, `gpt-4.1`, `gpt-4-turbo`, `o4-mini`, or newer)

## Setup

### 1. Install the Extension

Use the helper script from the project root:

```powershell
# Build VSIX
.\deploy.ps1 build

# Or build and print install path/instructions
.\deploy.ps1 install

# Build VSIX with custom default junior.* settings baked in
.\deploy.ps1 build -DefaultSettings .\settings.default.json
```

`-DefaultSettings` accepts a JSON object of `junior.*` keys and values. During packaging, those values temporarily override `package.json` defaults so the generated `.vsix` ships with your preset defaults. The working tree `package.json` is restored after the build.

These are extension defaults, not direct edits to VS Code's `settings.json`. They apply only when the user has not already set a value for that `junior.*` setting, and they do not affect non-`junior.*` settings from other extensions or VS Code itself.

Then in VS Code:
1. Open **Command Palette** (`Ctrl+Shift+P`)
2. Run **Extensions: Install from VSIX...**
3. Select the generated `junior-*.vsix`
4. Run **Developer: Reload Window**

For extension development/testing, you can still press **F5** to launch the Extension Development Host.

### Optional: GitHub Copilot CLI Provider

This repo can also expose a `Copilot CLI` provider inside Junior, but developers need to prepare that runtime explicitly.

Install prerequisites:

1. Install GitHub CLI.
2. Install GitHub Copilot CLI.
3. Ensure `copilot` is on `PATH`, or set `junior.copilotCli.path` to the binary.

On Windows, that setting may point to either `copilot.exe` or `copilot.cmd`.

BYOK/custom-provider path:

- Follow GitHub Copilot CLI's official BYOK setup instructions for your provider.
- Set `COPILOT_MODEL`.
- Set `COPILOT_PROVIDER_BASE_URL`.
- Optionally set `COPILOT_PROVIDER_TYPE` to `openai`, `azure`, or `anthropic`.
- Set `COPILOT_PROVIDER_API_KEY` or `COPILOT_PROVIDER_BEARER_TOKEN` when the provider requires auth.
- For Azure, set `COPILOT_PROVIDER_AZURE_API_VERSION`.
- If the provider expects the Responses API, set `COPILOT_PROVIDER_WIRE_API` to `responses`.

Junior exposes matching `junior.copilotCli.*` settings if you want the values in VS Code settings, but the spawned Copilot CLI process also inherits the environment variables that were already set before VS Code launched.

Example Junior settings for the Copilot CLI selector:

```jsonc
{
  "junior.agentProvider": "copilot-cli",
  "junior.copilotCli.path": "C:\\Users\\<you>\\AppData\\Local\\GitHubCopilotCLI\\copilot.cmd",
  "junior.copilotCli.model": "gpt-4.1",
  "junior.copilotCli.models": [
    {
      "name": "GPT-4.1",
      "id": "gpt-4.1"
    }
  ]
}
```

Leave `junior.copilotCli.home` out unless you need to override `COPILOT_HOME`.

Restart VS Code after changing environment variables. Junior now hides the Copilot CLI option unless the binary exists and the extension can detect either GitHub auth state or a complete BYOK configuration.

On Windows, Junior automatically wraps `copilot.cmd` and `copilot.bat` with `cmd.exe` when starting the Copilot CLI runtime. Paths that resolve to `copilot.exe` still launch directly.

For SDK-level troubleshooting, set `junior.copilotCli.logSdkEvents` to `true` and inspect the `Junior` output channel. Junior will log the raw Copilot SDK session events with compact summaries so you can see exactly which CLI events were emitted for a turn.

### 2. Configure Your AI Provider

Junior supports three connection modes: **direct** to an Azure OpenAI resource, through an **API Management (APIM)** proxy, or to the **OpenAI API**.

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
      "apiVersion": "2025-03-01-preview"
    },
    {
      "name": "GPT-4 Turbo",
      "deploymentId": "gpt-4-turbo",
      "apiVersion": "2025-03-01-preview"
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

#### Option C — OpenAI API

To connect directly to the OpenAI API (or any OpenAI-compatible endpoint such as OpenRouter or a local Ollama server):

```jsonc
{
  "junior.azureOpenAI.provider": "openai",
  "junior.azureOpenAI.openaiBaseUrl": "https://api.openai.com/v1",
  "junior.azureOpenAI.deployments": [
    { "name": "GPT-4o", "deploymentId": "gpt-4o" },
    { "name": "GPT-4o Mini", "deploymentId": "gpt-4o-mini" },
    { "name": "o4-mini", "deploymentId": "o4-mini" }
  ],
  "junior.azureOpenAI.activeDeployment": "gpt-4o"
}
```

The API key is sent as a `Bearer` token in the `Authorization` header. The `deployments` list and **Junior: Select Model** picker work the same way as with Azure — just use model names (e.g. `gpt-4o`) instead of deployment IDs. The `apiVersion` field is ignored for OpenAI.

**Compatible endpoints:**

| Service | `openaiBaseUrl` | Notes |
|---------|-----------------|-------|
| OpenAI | `https://api.openai.com/v1` (default) | Use your OpenAI API key |
| GitHub Models | `https://models.inference.ai.azure.com` | Use a GitHub fine-grained PAT with Models read permission |
| OpenRouter | `https://openrouter.ai/api/v1` | Use your OpenRouter key; some models are free |
| Ollama (local) | `http://localhost:11434/v1` | Any non-empty string as API key |
| LM Studio (local) | `http://localhost:1234/v1` | Any non-empty string as API key |

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

Quick test example using the reference MCP server:

```jsonc
{
  "junior.mcp.servers": {
    "everything": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-everything"]
    }
  }
}
```

After saving settings, run **Junior: Manage MCP Servers** and choose **Connect All Configured Servers** to reload MCP connections without restarting VS Code.

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

If the MCP server supports bearer tokens and you want Junior to reuse an existing VS Code authentication session, add `authSession`:

```jsonc
{
  "junior.mcp.servers": {
    "github": {
      "url": "https://api.githubcopilot.com/mcp/",
      "authSession": {
        "providerId": "github"
      }
    }
  }
}
```

For GitHub's hosted MCP server at `https://api.githubcopilot.com/mcp/`, Junior will also try to reuse an existing VS Code GitHub login automatically when no `Authorization` header is configured. If no compatible session is available, configure `headers.Authorization` with a PAT instead.

For HTTP MCP servers that respond with `401 Unauthorized` and a `WWW-Authenticate` challenge, Junior will also retry once using the configured `authSession` provider. This helps with remote MCP servers that follow OAuth challenge flows but still rely on a known VS Code auth provider such as `github` or `microsoft`.

You can mix both transports — servers with `command` use stdio, servers with `url` use HTTP.

By default, Junior merges `junior.mcp.servers` with external settings listed in `junior.mcp.externalServerSettings` (defaults to `["mcp.servers"]`). If two settings define the same server name, `junior.mcp.servers` wins. Set `junior.mcp.includeExternalServers` to `false` to only use Junior's own setting.

**Complete example — OpenAI provider (all settings shown):**

```jsonc
{
  // ── Provider & connection ──
  "junior.azureOpenAI.provider": "openai",             // "direct" | "apim" | "openai"
  "junior.azureOpenAI.openaiBaseUrl": "https://api.openai.com/v1", // base URL (include /v1 for OpenAI; omit for GitHub Models)

  // ── Models (shared across all providers) ──
  "junior.azureOpenAI.deployments": [                  // list of models to pick from
    { "name": "GPT-4o", "deploymentId": "gpt-4o" },
    { "name": "GPT-4o Mini", "deploymentId": "gpt-4o-mini" },
    { "name": "o4-mini", "deploymentId": "o4-mini" }
  ],
  "junior.azureOpenAI.activeDeployment": "gpt-4o",     // currently selected model

  // ── Azure OpenAI settings (used when provider is "direct" or "apim") ──
  "junior.azureOpenAI.endpoint": "",                   // Azure OpenAI resource URL
  "junior.azureOpenAI.apimBaseUrl": "",                // APIM gateway URL (when provider is "apim")
  "junior.azureOpenAI.apiVersion": "2025-03-01-preview", // Azure API version

  // ── Model behavior ──
  "junior.maxTokens": 16384,                           // max completion tokens per response
  "junior.temperature": 0.3,                           // response temperature (0.0–1.0)

  // ── Agent settings ──
  "junior.agent.maxIterations": 25,                    // max tool-call loops per turn
  "junior.agent.contextWindow": 128000,                // model context window size (tokens)
  "junior.agent.contextThreshold": 0.7,                // fraction of context window before summarizing (0.3–0.95)
  "junior.agent.confirmWrites": true,                  // confirm before file write/delete
  "junior.agent.confirmTerminal": true,                // confirm before terminal commands

  // ── Workspace indexing ──
  "junior.workspace.maxFileSize": 100000,              // max file size (bytes) to index
  "junior.workspace.excludePatterns": [
    "**/node_modules/**",
    "**/.git/**",
    "**/bin/**",
    "**/obj/**",
    "**/out/**",
    "**/dist/**",
    "**/*.min.js",
    "**/*.map"
  ],

  // ── Inline completions (ghost text) ──
  "junior.inlineCompletions.enabled": true,            // toggle inline suggestions on/off
  "junior.inlineCompletions.deployment": "gpt-4o-mini",// model for completions (leave "" to use the chat model)
  "junior.inlineCompletions.timeoutMs": 5000,          // abort if no response within this time (1000–30000)
  "junior.inlineCompletions.candidates": 1,            // number of alternatives (1–3); cycle with Alt+] / Alt+[

  // ── Slash commands ──
  "junior.slashCommands.directories": [],              // additional dirs to scan for .md slash commands

  // ── MCP servers ──
  "junior.mcp.includeExternalServers": true,           // also load servers from mcp.servers
  "junior.mcp.externalServerSettings": [
    "mcp.servers"
  ],
  "junior.mcp.servers": {
    // Add local MCP servers here; these override duplicates from external settings
  }
}
```

MCP tools appear alongside built-in tools with names prefixed by their server name (e.g., `mcp_filesystem_read_file`).

### 4. (Optional) Spec Kit Integration — Spec-Driven Development

Junior supports **slash commands** that integrate with [GitHub Spec Kit](https://github.com/github/spec-kit), enabling structured spec-driven development workflows directly from the chat panel.

#### What is Spec Kit?

Spec Kit is an open-source toolkit from GitHub that replaces ad-hoc prompting with a disciplined, multi-step development methodology:

1. **Constitution** — establish project principles and guidelines
2. **Specify** — define requirements (the *what*, not the *how*)
3. **Plan** — create a technical implementation plan
4. **Tasks** — break down into actionable task lists
5. **Implement** — execute all tasks according to the plan

#### Quick Setup

**Step 1: Install the Spec Kit CLI** (one-time, on one machine):

```bash
# Install via uv (Python package manager)
uv tool install specify-cli --from git+https://github.com/github/spec-kit.git
```

**Step 2: Initialize your project** (one-time per repo):

```bash
# In your project directory
specify init . --ai generic --ai-commands-dir .junior/commands
```

This creates `.junior/commands/` with prompt template `.md` files for each workflow step. **Commit these files** — other developers on the team won't need Spec Kit installed.

**Step 3: Use slash commands in Junior:**

Type `/` in the chat input to see available commands with autocomplete:

| Command | Description |
|---------|-------------|
| `/speckit.constitution` | Create or update project governing principles |
| `/speckit.specify` | Define what you want to build (requirements) |
| `/speckit.plan` | Create a technical implementation plan |
| `/speckit.tasks` | Generate actionable task list from the plan |
| `/speckit.implement` | Execute all tasks to build the feature |
| `/speckit.clarify` | Clarify underspecified areas |
| `/speckit.analyze` | Cross-artifact consistency analysis |

You can also append additional context after the command:

```
/speckit.specify Build a REST API for user management with JWT auth
```

#### Custom Slash Commands

Slash commands aren't limited to Spec Kit. Any `.md` file placed in the command directories works as a slash command. Junior scans these directories (in priority order):

1. Any directories listed in `junior.slashCommands.directories` (setting)
2. `.junior/commands/`
3. `.github/copilot/commands/`
4. `.github/commands/`

To create a custom command, add a markdown file — e.g., `.junior/commands/review-security.md` — and type `/review-security` in the chat. The file's content is prepended to your message as context for the AI.

#### How It Works

When you type `/commandName [optional text]` in the chat:

1. Junior looks up `commandName.md` in the command directories
2. The template content is loaded and prepended to your message
3. The combined prompt is sent to the AI model
4. The AI follows the template's instructions with your additional context

No runtime dependency on Spec Kit is needed — the prompt templates are plain markdown files.

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
| `Junior: Open Chat in Editor Tab` | Open chat as a top-level editor tab |
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
| `Junior: Trigger Inline Completion` | Manually trigger a ghost-text suggestion (`Alt+\`) |
| `Junior: Show Token Usage` | Show detailed session token usage breakdown |
| `Junior: Reset Token Usage` | Reset all session token counters to zero |

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
| `junior.azureOpenAI.provider` | `"direct"` | Connection mode: `Azure OpenAI`, `API Management (APIM)`, or `OpenAI / Compatible` |
| `junior.azureOpenAI.openaiBaseUrl` | `"https://api.openai.com/v1"` | OpenAI-compatible API base URL. Include `/v1` for OpenAI; omit for GitHub Models (used when provider is `openai`) |
| `junior.azureOpenAI.deployments` | `[]` | List of `{ name, deploymentId, apiVersion? }` — models available for selection. Works with all providers. |
| `junior.azureOpenAI.activeDeployment` | `""` | Currently active model — Azure deployment ID or OpenAI model name |
| `junior.azureOpenAI.endpoint` | `""` | Azure OpenAI endpoint URL (used when provider is `direct`) |
| `junior.azureOpenAI.apimBaseUrl` | `""` | APIM gateway base URL with path prefix (used when provider is `apim`) |
| `junior.azureOpenAI.apiKey` | `""` | API key (prefer using **Junior: Set API Key** for secure storage) |
| `junior.azureOpenAI.apiVersion` | `"2025-03-01-preview"` | Azure API version (>= `2024-08-01` required for token usage tracking) |
| `junior.maxTokens` | `16384` | Max completion tokens per response |
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
| `junior.slashCommands.directories` | `[]` | Additional directories to scan for slash command `.md` files. Built-in dirs (`.junior/commands`, `.github/copilot/commands`, `.github/commands`) are always scanned |
| `junior.inlineCompletions.enabled` | `true` | Enable/disable inline ghost-text code completions |
| `junior.inlineCompletions.deployment` | `""` | Deployment ID or OpenAI model name for inline completions. Leave empty to use the active chat model. A fast model (e.g. `gpt-4o-mini`) is recommended. |
| `junior.inlineCompletions.timeoutMs` | `5000` | Max time (ms) to wait for a completion response before aborting (1000–30000) |
| `junior.inlineCompletions.candidates` | `1` | Number of alternative completions to fetch (1–3). Cycle with Alt+] / Alt+[ |

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
├── inlineCompletionProvider.ts — Inline ghost-text completions (InlineCompletionItemProvider)
├── mcpClient.ts          — MCP stdio/HTTP client for external tool servers
├── workspaceIndexer.ts   — Workspace file scanning and search (cached to disk)
├── symbolIndexer.ts      — Symbol indexing (functions, classes, etc.)
├── semanticIndexer.ts    — TF-IDF semantic indexing for natural-language search (cached to disk)
├── planTreeProvider.ts   — Plan tree view provider for agent step tracking
├── sessionManager.ts     — Chat session persistence (globalState)
└── chatViewProvider.ts   — Webview UI (sidebar chat panel)└── tokenTracker.ts       — Session token usage tracking with status bar + webview badge```

## Development

```bash
npm install          # Install dependencies
npm run compile      # Build once (tsc, per-file output with source maps)
npm run watch        # Build in watch mode (default build task)
npm run lint         # Run ESLint
npm test             # Run unit tests (vitest)
npm run test:watch   # Run tests in watch mode
.\deploy.ps1 build   # Production: type-check → esbuild bundle → VSIX
```

### Running Tests

Tests use [Vitest](https://vitest.dev/) and live in `test/`. They run against the framework and middleware layers without requiring a VS Code extension host — a minimal `vscode` stub is provided at `test/__mocks__/vscode.ts`.

```bash
npm test                    # Run all tests once
npm run test:watch          # Watch mode — re-runs on file changes
npx vitest run --reporter verbose   # Verbose output with individual test names
```

Current test coverage:

| Test file | What it covers |
|-----------|---------------|
| `middleware-pipeline.test.ts` | `MiddlewarePipeline.runAgent/runFunction/runChat` — ordering, short-circuit, retry, context mutation |
| `retry-middleware.test.ts` | `RetryMiddleware` — success passthrough, retry logic, no-retry tools/patterns, custom options |
| `recovery-middleware.test.ts` | `RecoveryMiddleware` — 3-tier `process()` recovery, `processStream()` stall/overflow retry, error classification |
| `chat-client-middleware.test.ts` | `ChatClientWithMiddleware` — `getResponse`/`getResponseStream` delegation, `processStream` chaining |

To add a new test, create a `test/*.test.ts` file — vitest picks it up automatically.

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
- Supports per-request overrides for `maxTokens` and `temperature` (used by inline completions)
- Uses only Node.js built-in `https` — no npm packages, no SDK, no external dependencies

### Inline Code Completions

`inlineCompletionProvider.ts` registers as a VS Code `InlineCompletionItemProvider` to deliver ghost-text suggestions as you type:

- **Debounced triggering** — requests fire after 150ms of idle time to avoid spamming the API during active typing.
- **Aggressive cancellation** — every new keystroke aborts any in-flight request via `AbortSignal`, keeping the UI responsive.
- **Buffered response** — streamed tokens are collected into a complete suggestion before displaying (no visual flicker).
- **Request deduplication** — identical requests (same document version + cursor position) return cached results.
- **FIM-style prompt** — sends prefix (up to 8K chars before cursor) and suffix (up to 2K chars after cursor) with a system prompt that instructs the model to output only code.
- **Separate deployment** — optionally use a faster/cheaper model for completions (e.g. `gpt-4o`) while keeping a larger model for chat. Configure via `junior.inlineCompletions.deployment`.
- **IntelliSense awareness** — suppresses ghost text when the native completions widget is active.
- **Large file guard** — skips files over 500KB to avoid excessive token usage.
- **Toggle** — disable instantly via `junior.inlineCompletions.enabled` (no reload required).
- **Single-line vs multi-line detection** — when the cursor is mid-line, completes only the current line (64 tokens). On a blank line, generates multi-line blocks (256 tokens).
- **Cooldown after dismissal** — if a suggestion is dismissed, the next request is delayed (up to 2.5s) to reduce API waste.
- **Neighboring-tab context** — includes snippets from up to 3 open editor tabs in the prompt, giving the model awareness of related files.
- **Smart suppression** — skips triggering in comment lines (detected via language-specific prefixes: `//`, `#`, `--`, `<!--`, etc.).
- **Hard request timeout** — aborts if the model doesn't respond within the configured timeout (default 5s). Configurable via `junior.inlineCompletions.timeoutMs`.
- **Type-ahead cache reuse** — when you type characters that match the beginning of the last suggestion, the remaining tail is served instantly with zero latency (no API call).
- **Status bar indicator** — shows a sparkle icon in the status bar; displays a spinning animation while fetching. Click it to manually trigger a completion.
- **Manual trigger** — press `Alt+\` to force a suggestion on demand, bypassing cooldown and comment suppression.
- **Multi-candidate cycling** — set `junior.inlineCompletions.candidates` to 2 or 3 to fetch multiple alternatives in parallel with varied temperature. Cycle through them with `Alt+]` / `Alt+[`.

### Token Usage Tracking

Junior tracks cumulative token usage across your session — both from chat and inline completions — and displays it in two places:

- **Status bar** — a `$(pulse) 18.6K` indicator in the bottom-left status bar. Hover for a rich GHCP-style tooltip showing a full breakdown: prompt vs. completion tokens, chat vs. inline, percentages, request counts, and a clickable "Reset Counters" link.
- **Panel badge** — a small `📊 18.6K` badge in the chat panel next to "Enter to send".

Token tracking requires `stream_options: { include_usage: true }` in the API request, which is supported on Azure OpenAI API versions `2024-08-01` and later. The default API version is `2025-03-01-preview`.

**Graceful degradation:** If your deployment uses an older API version (e.g., `2024-06-01`), the `stream_options` parameter is automatically omitted. Everything works normally — the tracker simply shows 0 tokens because the API doesn't return usage data. No errors, no 500s.

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


