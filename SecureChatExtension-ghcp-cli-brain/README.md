# JuniorGH — VS Code Chat UI for GitHub Copilot CLI

A VS Code extension that provides a **Copilot-like chat panel** powered by a local **GitHub Copilot CLI** runtime (`copilot --acp --stdio`). JuniorGH is a lightweight UI shell — GitHub's full professional agent (tools, model access, context gathering) runs inside the CLI process.

## Features

- **Copilot CLI Agent** — Delegates all reasoning, tool use, and code editing to the GitHub Copilot CLI over the ACP (Agent Communication Protocol) via JSON-RPC stdio.
- **Rich Chat UI** — Streaming markdown responses, working-block visualization, collapsible tool calls, image paste, file attachment, and slash commands.
- **MCP (Model Context Protocol)** — Connect external MCP tool servers over stdio or HTTP for extensible tool capabilities.
- **Inline Code Completions** — Ghost-text suggestions powered by Azure OpenAI / OpenAI (independent of the CLI runtime).
- **Session Persistence** — Chat history is persisted across VS Code restarts with full working-block restore.
- **Context Menu Actions** — Right-click selected code to Explain, Review, or Fix it.
- **Model Selection** — Set or change the Copilot CLI model from the chat panel.

## Requirements

- VS Code 1.85.0 or later
- A **GitHub Copilot** subscription (Individual, Business, or Enterprise)
- The `copilot` CLI binary available on your PATH (or configure a custom path)

## Setup

### 1. Install the Extension

Use the helper script from the project root:

```powershell
# Build VSIX
.\deploy.ps1 build

# Or build and print install path/instructions
.\deploy.ps1 install

# Build VSIX with custom default juniorgh.* settings baked in
.\deploy.ps1 build -DefaultSettings .\settings.default.json
```

`-DefaultSettings` accepts a JSON object of `juniorgh.*` keys and values. During packaging, those values temporarily override `package.json` defaults so the generated `.vsix` ships with your preset defaults. The working tree `package.json` is restored after the build.

Then in VS Code:
1. Open **Command Palette** (`Ctrl+Shift+P`)
2. Run **Extensions: Install from VSIX...**
3. Select the generated `juniorgh-*.vsix`
4. Run **Developer: Reload Window**

### 2. Configure the Copilot CLI

JuniorGH launches `copilot --acp --stdio` as its chat backend. Optional settings in `settings.json`:

```jsonc
{
  "juniorgh.copilotCli.path": "copilot",                 // Path to copilot binary (default: "copilot")
  "juniorgh.copilotCli.home": "C:/Tools/copilot-home",   // Override COPILOT_HOME directory
  "juniorgh.copilotCli.model": "claude-sonnet-4.6",      // Active model (empty = CLI default)
  "juniorgh.copilotCli.additionalArgs": []                // Extra CLI arguments
}
```

#### Discovering Available Models

The models available to you depend on your GitHub Copilot subscription. To find out which models you have access to, ask the Copilot CLI directly:

```
copilot -p "what models do I have access to"
```

The CLI will respond with a table of model names, IDs, and tiers. Use those IDs to populate the model picker.

#### Configuring the Model Picker

The model picker dropdown is populated from `juniorgh.copilotCli.models`. Since available models vary by customer/license, the extension ships with an empty default list. Configure it per-user in `settings.json`:

```jsonc
{
  "juniorgh.copilotCli.models": [
    { "name": "Claude Sonnet 4 (default)", "id": "" },
    { "name": "Claude Sonnet 4.6", "id": "claude-sonnet-4.6" },
    { "name": "GPT-5.4", "id": "gpt-5.4" },
    { "name": "GPT-5.3 Codex", "id": "gpt-5.3-codex" }
  ]
}
```

An entry with `"id": ""` means "use the Copilot CLI default model".

**For enterprise deployments**, bake a model list into the VSIX using `settings.default.json`:

```powershell
.\deploy.ps1 build -DefaultSettings .\settings.default.json
```

This lets you ship a customer-specific model list without requiring each user to configure it manually. See `settings.default.json` for an example.

### 3. (Optional) Configure Inline Completions

Inline ghost-text completions use a separate Azure OpenAI / OpenAI connection (independent of the CLI). To enable them:

1. Run **JuniorGH: Set API Key** from the Command Palette to store your key securely
2. Configure your provider in `settings.json`:

```jsonc
{
  "juniorgh.api.provider": "openai",
  "juniorgh.openai.baseUrl": "https://api.openai.com/v1",
  "juniorgh.api.models": [
    { "name": "GPT-4o Mini", "id": "gpt-4o-mini" }
  ],
  "juniorgh.inlineCompletions.enabled": true,
  "juniorgh.inlineCompletions.model": "gpt-4o-mini"
}
```

### 4. (Optional) Configure MCP Servers

Add MCP tool servers to extend the agent's capabilities:

**stdio** — spawn a local process:

```jsonc
{
  "juniorgh.mcp.servers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/dir"]
    }
  }
}
```

**HTTP** — connect to a remote MCP server:

```jsonc
{
  "juniorgh.mcp.servers": {
    "remote-tools": {
      "url": "https://my-mcp-server.internal:8080/mcp",
      "headers": { "Authorization": "Bearer my-token" }
    }
  }
}
```

By default, JuniorGH also merges MCP servers from `mcp.servers` (VS Code's built-in MCP setting). Set `juniorgh.mcp.includeExternalServers` to `false` to only use JuniorGH's own setting.

### 5. (Optional) Spec Kit Integration — Spec-Driven Development

JuniorGH supports **slash commands** that integrate with [GitHub Spec Kit](https://github.com/github/spec-kit), enabling structured spec-driven development workflows directly from the chat panel.

#### Quick Setup

```bash
# Install the Spec Kit CLI (one-time)
uv tool install specify-cli --from git+https://github.com/github/spec-kit.git

# Initialize your project (one-time per repo)
specify init . --ai generic --ai-commands-dir .juniorgh/commands
```

This creates `.juniorgh/commands/` with prompt template `.md` files for each workflow step. **Commit these files** — other developers on the team won't need Spec Kit installed.

Type `/` in the chat input to see available commands with autocomplete (e.g. `/speckit.specify`, `/speckit.plan`, `/speckit.implement`).

#### Custom Slash Commands

Any `.md` file placed in the command directories works as a slash command. JuniorGH scans these directories (in priority order):

1. Any directories listed in `juniorgh.slashCommands.directories` (setting)
2. `.juniorgh/commands/`
3. `.github/copilot/commands/`
4. `.github/commands/`

## Usage

### Open the Chat Panel

- Click the **JuniorGH** icon in the Activity Bar (left sidebar), or
- Press `Ctrl+Shift+I`, or
- Run **JuniorGH: Open Chat** from the Command Palette

### Chat with the Agent

Type a message and press **Enter**. The Copilot CLI agent will analyze your request, call tools, edit files, and stream its response — all visualized in the chat panel.

Press **Shift+Enter** for a newline without sending.

### Commands

| Command | Description |
|---------|-------------|
| `JuniorGH: Open Chat` | Focus the chat panel |
| `JuniorGH: Open Chat in Editor Tab` | Open chat as a top-level editor tab |
| `JuniorGH: New Chat Session` | Start a fresh conversation |
| `JuniorGH: Select Model` | Set the Copilot CLI model |
| `JuniorGH: Index Workspace` | Re-scan workspace files (manual refresh) |
| `JuniorGH: Explain Selected Code` | Explain highlighted code |
| `JuniorGH: Review Selected Code` | Code review of selection |
| `JuniorGH: Fix Selected Code` | Fix issues in selection |
| `JuniorGH: Manage MCP Servers` | Connect/disconnect MCP servers |
| `JuniorGH: Cancel Agent Run` | Stop the current agent loop |
| `JuniorGH: Toggle Chat History` | Show/hide the session history panel |
| `JuniorGH: Set API Key` | Store API key securely (for inline completions) |
| `JuniorGH: Trigger Inline Completion` | Manually trigger a ghost-text suggestion (`Alt+\`) |
| `JuniorGH: Show Token Usage` | Show detailed session token usage breakdown |
| `JuniorGH: Reset Token Usage` | Reset all session token counters to zero |

## Architecture

JuniorGH is a thin UI shell. The Copilot CLI does the heavy lifting.

```
┌───────────────────────┐     ACP (JSON-RPC/stdio)     ┌──────────────────┐
│  JuniorGH Extension   │ ◄──────────────────────────► │  copilot CLI     │
│                       │                               │                  │
│  chatViewProvider   │   Messages, tool calls,       │  Agent loop      │
│  copilotCliAcp      │   working blocks, thoughts    │  20+ tools       │
│  Runtime            │                               │  Model access    │
│  sessionManager     │                               │  Context mgmt    │
└───────────────────────┘                               └──────────────────┘
```

```
src/
├── extension.ts              — Activation entry point, command registration
├── chatViewProvider.ts       — Webview UI (sidebar chat panel)
├── copilotCliAcpRuntime.ts   — ACP protocol handler (JSON-RPC over stdio to CLI)
├── agentRuntime.ts           — Runtime interface + callback types
├── sessionManager.ts         — Chat session persistence
├── commandRegistrar.ts       — VS Code command registration
├── config.ts                 — Settings helper with legacy namespace fallback
├── types.ts                  — Shared TypeScript type definitions
├── tokenTracker.ts           — Token usage tracking with status bar + webview badge
├── aoaiClient.ts             — Azure OpenAI client (used by inline completions)
├── inlineCompletionProvider.ts — Inline ghost-text completions
├── mcpClient.ts              — MCP client for external tool servers
├── workspaceIndexer.ts       — Workspace file scanning and search
├── symbolIndexer.ts          — Symbol indexing (functions, classes, etc.)
├── semanticIndexer.ts        — TF-IDF semantic indexing for search
├── retrievalRanker.ts        — Retrieval result ranking
├── repoPatternStore.ts       — Repository pattern storage
media/
└── chat.js                   — Webview-side rendering and interaction
```

### How It Works

1. You type a message in the chat panel
2. JuniorGH sends it to the Copilot CLI over ACP (JSON-RPC over stdio)
3. The CLI runs its full agent loop — reading files, searching code, editing files, running commands — all using GitHub's professional toolset and models
4. Tool calls, thoughts, and working progress stream back to JuniorGH for live visualization
5. The final response is rendered as streaming markdown in the chat panel

### Session Persistence

Sessions are persisted to disk and survive VS Code restarts:
- Full conversation restore including working blocks, tool calls, and interleaved text
- History panel with session switching and deletion
- Automatic session titling from first user message

### Inline Code Completions

Ghost-text suggestions powered by Azure OpenAI / OpenAI (independent of the CLI agent):
- Debounced triggering, aggressive cancellation, type-ahead cache reuse
- Separate deployment support (e.g. fast `gpt-4o-mini` for completions)
- Multi-candidate cycling with `Alt+]` / `Alt+[`
- Status bar indicator with manual trigger (`Alt+\`)

## Development

```bash
npm install          # Install dependencies
npm run compile      # Build once
npm run watch        # Build in watch mode
npm run lint         # Run ESLint
npm run package      # Create .vsix package
```

Press **F5** to launch the Extension Development Host.

## Security Notes

- The API key (for inline completions) is stored in VS Code's **SecretStorage** (OS credential manager). No plaintext is written to disk.
- The webview uses a strict Content Security Policy with nonce-based script/style execution.

## License

MIT



