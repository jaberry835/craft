# SecureChat — AI Assistant for Offline Environments

A VS Code extension that provides a **Copilot-like autonomous agent** powered by **Azure OpenAI**, designed for air-gapped / offline developer environments with no internet access and no GitHub Copilot availability.

## Features

- **Agent Mode** — Autonomous tool-calling loop: the AI reads files, edits code, runs terminal commands, and searches your workspace without manual intervention.
- **Built-in Tools** — 11 workspace tools: `read_file`, `write_file`, `edit_file`, `delete_file`, `list_directory`, `search_files`, `grep_search`, `get_file_tree`, `run_terminal_command`, `get_diagnostics`, `get_open_editors`.
- **MCP (Model Context Protocol)** — Connect external MCP tool servers over stdio for extensible tool capabilities.
- **Azure OpenAI Streaming** — Direct HTTPS connection to your Azure OpenAI resource with streaming responses (no SDK, zero external runtime dependencies).
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
3. Select the generated `secure-chat-*.vsix`
4. Run **Developer: Reload Window**

For extension development/testing, you can still press **F5** to launch the Extension Development Host.

### 2. Configure Azure OpenAI

Open VS Code Settings (`Ctrl+,`) and search for `SecureChat`, or add to your `settings.json`:

```jsonc
{
  "securechat.azureOpenAI.endpoint": "https://your-resource.openai.azure.com",
  "securechat.azureOpenAI.apiKey": "your-api-key",
  "securechat.azureOpenAI.deployments": [
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
  "securechat.azureOpenAI.activeDeployment": "gpt-4o"
}
```

### 3. (Optional) Configure MCP Servers

Add MCP tool servers to extend the agent's capabilities:

```jsonc
{
  "securechat.mcp.servers": {
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

MCP tools appear alongside built-in tools with names prefixed by their server name (e.g., `mcp_filesystem_read_file`).

## Usage

### Open the Chat Panel

- Click the **SecureChat** icon in the Activity Bar (left sidebar), or
- Press `Ctrl+Shift+I`, or
- Run **SecureChat: Open Chat** from the Command Palette

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
| `SecureChat: Open Chat` | Focus the chat panel |
| `SecureChat: New Chat Session` | Start a fresh conversation |
| `SecureChat: Select Model` | Switch between configured deployments |
| `SecureChat: Index Workspace` | Re-scan workspace files (manual refresh) |
| `SecureChat: Explain Selected Code` | Explain highlighted code |
| `SecureChat: Review Selected Code` | Code review of selection |
| `SecureChat: Fix Selected Code` | Fix issues in selection |
| `SecureChat: Manage MCP Servers` | Connect/disconnect MCP servers |
| `SecureChat: Cancel Agent Run` | Stop the current agent loop |

`Index Workspace` also runs automatically on activation. Use it manually after major file/folder changes or when workspace settings (exclude patterns, max file size) change.

### Context Menu

Select code in the editor, right-click, and choose:
- **SecureChat: Explain Selected Code**
- **SecureChat: Review Selected Code**
- **SecureChat: Fix Selected Code**

## Settings Reference

| Setting | Default | Description |
|---------|---------|-------------|
| `securechat.azureOpenAI.endpoint` | `""` | Azure OpenAI endpoint URL |
| `securechat.azureOpenAI.apiKey` | `""` | API key |
| `securechat.azureOpenAI.deployments` | `[]` | List of `{ name, deploymentId, apiVersion }` |
| `securechat.azureOpenAI.activeDeployment` | `""` | Currently active deployment ID |
| `securechat.azureOpenAI.apiVersion` | `"2024-06-01"` | Default API version |
| `securechat.maxTokens` | `4096` | Max tokens per response |
| `securechat.temperature` | `0.3` | Response temperature (0–1) |
| `securechat.workspace.maxFileSize` | `100000` | Max file size (bytes) to index |
| `securechat.workspace.excludePatterns` | `[...]` | Glob patterns excluded from indexing |
| `securechat.agent.maxIterations` | `25` | Max tool-call loops per turn |
| `securechat.agent.confirmWrites` | `true` | Confirm before file write/delete |
| `securechat.agent.confirmTerminal` | `true` | Confirm before terminal commands |
| `securechat.mcp.servers` | `{}` | MCP server configurations |

## Architecture

```
src/
├── extension.ts          — Activation entry point, command registration
├── types.ts              — Shared TypeScript type definitions
├── aoaiClient.ts         — Azure OpenAI streaming client (raw HTTPS)
├── agentLoop.ts          — Core agent orchestrator (tool-calling loop)
├── builtinTools.ts       — 11 built-in workspace tools
├── mcpClient.ts          — MCP stdio client for external tool servers
├── workspaceIndexer.ts   — Workspace file scanning and search
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

- The API key is stored in VS Code settings. For production use, consider migrating to the VS Code `SecretStorage` API or an environment variable.
- All HTTP calls go directly to your Azure OpenAI endpoint — **no data leaves your network**.
- The webview uses a strict Content Security Policy with nonce-based script/style execution.
- Terminal commands and file writes require user confirmation by default.

## License

MIT
