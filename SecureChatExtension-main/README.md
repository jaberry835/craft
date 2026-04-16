# Junior User Guide

Junior is a VS Code extension that brings Agentic chat and coding assistance to air-gapped, offline, and otherwise restricted development environments using **Azure OpenAI**, **OpenAI**, or compatible endpoints.

## What Junior Does

Junior adds an AI chat panel and inline code completions to VS Code. It can connect to:

- **Azure OpenAI** directly
- **Azure API Management (APIM)** in front of Azure OpenAI
- **OpenAI-compatible APIs** such as OpenAI, GitHub Models, OpenRouter, Ollama, or LM Studio

Typical user tasks are:

- install the VSIX
- configure a provider and model list
- store an API key
- optionally configure GitHub Copilot CLI
- open the chat and start working

## Before You Start

You need:

- VS Code 1.85.0 or later
- a `junior-*.vsix` file from your team or administrator
- network access to your configured AI endpoint
- an API key or token for that endpoint
- at least one model or deployment that supports chat and tool calling

You do **not** need to build the extension from source.

If you want to use the optional Copilot CLI provider in Junior, you also need GitHub Copilot CLI installed before you open VS Code. Junior hides the Copilot CLI option unless the CLI executable is present and either GitHub auth or BYOK provider configuration is already available.

## Install The VSIX

1. In VS Code, open the Command Palette with `Ctrl+Shift+P`.
2. Run **Extensions: Install from VSIX...**.
3. Choose the `.vsix` file you were given.
4. After install completes, run **Developer: Reload Window** if VS Code does not reload automatically.
5. Open Junior from the Activity Bar, or run **Junior: Open Chat**.

On first open, Junior shows a splash screen with **Configure Settings** and **Set API Key** buttons. That is the fastest way to reach the two setup steps most users need.

## First-Time Setup

Junior can be configured in the Settings UI by searching for `Junior`, or directly in your `settings.json`.

Most teams should set these items before they start using the extension:

1. Set `junior.azureOpenAI.provider`.
2. Add one or more entries to `junior.azureOpenAI.deployments`.
3. Set `junior.azureOpenAI.activeDeployment`.
4. Set `junior.inlineCompletions.deployment` so inline suggestions use the intended model.
5. Run **Junior: Set API Key** and store your key securely.

If your Azure OpenAI or APIM route expects `Authorization: Bearer ...` instead of `api-key`, Junior can also use bearer auth for local agent mode. In that case, set `junior.azureOpenAI.authMode` to `bearer-token` or `vscode-auth-session` instead of using the default API-key mode.

For most teams, `junior.inlineCompletions.deployment` should be treated as part of initial setup, not an optional later tuning step. A common pattern is to keep chat on the main model and point inline completions at a faster model.

If your team shipped the VSIX with preset defaults, some of these values may already be filled in. You can still override them in your own settings.

### Complete Example: APIM Setup With Separate Chat And Inline Models

If your environment uses APIM and you want a fuller starting point, this is a realistic example:

```jsonc
{
  "junior.azureOpenAI.provider": "apim",
  "junior.azureOpenAI.apimBaseUrl": "https://rudeaoaiapi.azure-api.net/foundryapi",
  "junior.azureOpenAI.apiVersion": "2025-03-01-preview",
  "junior.azureOpenAI.deployments": [
    {
      "name": "GPT-5.3 Chat",
      "deploymentId": "gpt-5.3-chat",
      "apiVersion": "2025-03-01-preview"
    },
    {
      "name": "GPT-4o",
      "deploymentId": "gpt-4o",
      "apiVersion": "2025-03-01-preview"
    },
    {
      "name": "gpt-5.4-mini",
      "deploymentId": "gpt-5.4-mini",
      "apiVersion": "2025-03-01-preview"
    }
  ],
  "junior.azureOpenAI.activeDeployment": "gpt-5.4-mini",
  "junior.inlineCompletions.deployment": "gpt-4o",
  "junior.temperature": 1,
  "junior.mcp.includeExternalServers": true,
  "junior.mcp.externalServerSettings": [
    "mcp.servers"
  ],
  "junior.mcp.servers": {}
}
```

The API key is intentionally not shown in this sample. Set it with **Junior: Set API Key** unless your environment requires `junior.azureOpenAI.apiKey` in settings.

What each setting is doing in this example:

- `junior.azureOpenAI.provider`: tells Junior to call Azure OpenAI through APIM instead of directly.
- `junior.azureOpenAI.apimBaseUrl`: points to the APIM gateway base URL and path prefix.
- `junior.azureOpenAI.apiVersion`: sets the Azure OpenAI API version used for requests.
- `junior.azureOpenAI.deployments`: defines the models the extension can offer in its model picker.
- `junior.azureOpenAI.activeDeployment`: selects the default chat model used when you open Junior.
- `junior.inlineCompletions.deployment`: selects the separate model used for ghost-text inline completions.
- `junior.temperature`: controls response creativity. `1` is noticeably looser than the default `0.3`.
- `junior.mcp.includeExternalServers`: lets Junior also read MCP server definitions from other VS Code settings.
- `junior.mcp.externalServerSettings`: tells Junior which settings path to read external MCP definitions from.
- `junior.mcp.servers`: holds Junior-specific MCP server definitions. An empty object means none are defined here yet.

This example is not the only valid arrangement. The key point is that you should decide three things explicitly:

1. Which provider path you are using.
2. Which deployment is your default chat model.
3. Which deployment is your inline completions model.

## Provider Options

| Provider value | Use this when | Required settings | Auth header |
|---|---|---|---|
| `direct` | You connect straight to an Azure OpenAI resource | `junior.azureOpenAI.endpoint`, `junior.azureOpenAI.deployments`, `junior.azureOpenAI.activeDeployment` | `api-key` |
| `apim` | Your organization exposes Azure OpenAI through Azure API Management | `junior.azureOpenAI.apimBaseUrl`, `junior.azureOpenAI.deployments`, `junior.azureOpenAI.activeDeployment` | `api-key` |
| `openai` | You use OpenAI or another OpenAI-compatible API | `junior.azureOpenAI.openaiBaseUrl`, `junior.azureOpenAI.deployments`, `junior.azureOpenAI.activeDeployment` | `Authorization: Bearer ...` |

For `direct` and `apim`, the default auth mode is still `api-key`, but you can switch those providers to bearer auth with these settings:

```jsonc
{
  "junior.azureOpenAI.authMode": "vscode-auth-session",
  "junior.azureOpenAI.bearerTokenSource": "vscode-auth-session",
  "junior.azureOpenAI.authProviderId": "microsoft",
  "junior.azureOpenAI.authScopes": [
    "api://aa6b2ff6-4168-4ffa-b0de-a91ef1726ac6/user_impersonation"
  ]
}
```

If you already have a raw bearer token from another system, you can instead set `junior.azureOpenAI.authMode` to `bearer-token` and place the token in `junior.azureOpenAI.bearerToken`.

When using `vscode-auth-session`, run **Junior: Sign In for Azure/APIM Bearer Mode** to establish the login before sending requests.

Token refresh behavior for `vscode-auth-session`:

- Junior asks the VS Code authentication provider for a token each time it builds a request.
- If the provider can silently refresh the token, the request continues without prompting you.
- If the session is missing or can no longer be refreshed, VS Code can prompt you to sign in again on the next request.
- The `Junior` output channel now logs the resolved local auth mode and, for bearer flows, safe token claims such as `aud` and `scp` without printing the token itself.

## Optional: Copilot CLI Provider

Junior can also route agent turns through GitHub Copilot CLI via the Copilot SDK.

Before you expect the Copilot CLI option to appear in the UI:

1. Install GitHub CLI.
2. Install GitHub Copilot CLI and make `copilot` available on `PATH`, or set `junior.copilotCli.path` to the executable.
3. If you are using BYOK, follow GitHub Copilot CLI's official BYOK setup instructions for your provider first.
4. Start VS Code from an environment where the Copilot CLI variables are already set.

On Windows, `junior.copilotCli.path` can point to either `copilot.exe` or the `copilot.cmd` shim.

BYOK/custom-provider auth:

- Set `COPILOT_MODEL`. The Copilot SDK requires an explicit model when using a custom provider.
- Set `COPILOT_PROVIDER_BASE_URL`.
- Set `COPILOT_PROVIDER_TYPE` when needed. Valid values are `openai`, `azure`, and `anthropic`.
- For secured providers, set `COPILOT_PROVIDER_API_KEY` or `COPILOT_PROVIDER_BEARER_TOKEN`.
- For Azure BYOK, set `COPILOT_PROVIDER_AZURE_API_VERSION`.
- If your provider requires the Responses API, set `COPILOT_PROVIDER_WIRE_API=responses`.

Junior also exposes matching `junior.copilotCli.*` settings if you prefer to keep the values in VS Code settings. If you already set up the Copilot CLI environment variables before launching VS Code, Junior will use those inherited variables when it starts the CLI.

If you want Junior itself to acquire a bearer token through VS Code sign-in instead of storing `COPILOT_PROVIDER_BEARER_TOKEN`, set these additional settings:

```jsonc
{
  "junior.copilotCli.providerType": "azure",
  "junior.copilotCli.providerBaseUrl": "https://rudeaoaiapi.azure-api.net",
  "junior.copilotCli.model": "gpt-5.4",
  "junior.copilotCli.providerWireApi": "responses",
  "junior.copilotCli.providerBearerTokenSource": "vscode-auth-session",
  "junior.copilotCli.providerAuthProviderId": "microsoft",
  "junior.copilotCli.providerAuthScopes": [
    "api://aa6b2ff6-4168-4ffa-b0de-a91ef1726ac6/user_impersonation"
  ]
}
```

Then run **Junior: Sign In for Copilot CLI Bearer Mode**. Junior will request the VS Code auth session, use that access token for the Copilot CLI BYOK provider at runtime, and avoid storing the raw bearer token in settings.

Leave `junior.copilotCli.providerBearerTokenSource`, `junior.copilotCli.providerAuthProviderId`, and `junior.copilotCli.providerAuthScopes` empty unless you want Junior to manage bearer-token sign-in for the Copilot CLI provider.

Token refresh behavior for Copilot CLI bearer mode is the same: Junior asks VS Code for a session when creating the provider config, silent refresh is used when available, and you are only prompted to sign in again when the existing session can no longer satisfy the request.

For SDK-level troubleshooting, set `junior.copilotCli.logSdkEvents` to `true` and inspect the `Junior` output channel. Junior will log the raw Copilot SDK session events with compact summaries so you can see exactly which CLI events were emitted for a turn.

Example Junior settings for the Copilot CLI selector itself:

```jsonc
{
  "junior.agentProvider": "copilot-cli",
  "junior.copilotCli.path": "C:\\Users\\SystemAdministrator\\AppData\\Local\\GitHubCopilotCLI\\copilot.cmd",
  "junior.copilotCli.model": "gpt-4.1",
  "junior.copilotCli.models": [
    {
      "name": "GPT-4.1",
      "id": "gpt-4.1"
    }
  ]
}
```

You do not need to keep `junior.copilotCli.home` in settings unless you are intentionally overriding `COPILOT_HOME`.

Notes:

- Restart VS Code after changing environment variables so the extension host inherits them.
- On Windows, Junior now launches `copilot.cmd` and `copilot.bat` through `cmd.exe` automatically. Keep using `copilot.exe` if you have a native executable path and want direct spawn behavior.
- If Copilot CLI is installed but none of the auth or BYOK prerequisites are present, Junior keeps the provider on `Local` and does not show the Copilot CLI option.

### Option A: Direct Azure OpenAI

Use this when you have the Azure OpenAI resource URL itself.

```jsonc
{
  "junior.azureOpenAI.provider": "direct",
  "junior.azureOpenAI.endpoint": "https://your-resource.openai.azure.com",
  "junior.azureOpenAI.apiVersion": "2025-03-01-preview",
  "junior.azureOpenAI.deployments": [
    {
      "name": "GPT-4o",
      "deploymentId": "gpt-4o",
      "apiVersion": "2025-03-01-preview"
    },
    {
      "name": "GPT-4o Mini",
      "deploymentId": "gpt-4o-mini",
      "apiVersion": "2025-03-01-preview"
    }
  ],
  "junior.azureOpenAI.activeDeployment": "gpt-4o",
  "junior.inlineCompletions.deployment": "gpt-4o-mini"
}
```

Notes:

- `deploymentId` must match the Azure deployment name exactly.
- `apiVersion` can be set globally with `junior.azureOpenAI.apiVersion`, per deployment, or both.
- The extension sends your key as an `api-key` header.

### Option B: Azure OpenAI Through APIM

Use this when your company requires calls to go through an Azure API Management gateway.

```jsonc
{
  "junior.azureOpenAI.provider": "apim",
  "junior.azureOpenAI.apimBaseUrl": "https://my-apim.azure-api.net/foundryapi",
  "junior.azureOpenAI.apiVersion": "2025-03-01-preview",
  "junior.azureOpenAI.deployments": [
    {
      "name": "GPT-5.3 Chat",
      "deploymentId": "gpt-5.3-chat",
      "apiVersion": "2025-03-01-preview"
    },
    {
      "name": "GPT-4o",
      "deploymentId": "gpt-4o",
      "apiVersion": "2025-03-01-preview"
    }
  ],
  "junior.azureOpenAI.activeDeployment": "gpt-5.3-chat",
  "junior.inlineCompletions.deployment": "gpt-4o"
}
```

Notes:

- `junior.azureOpenAI.apimBaseUrl` should include any path prefix required by your APIM route.
- The APIM route must expose the Azure OpenAI chat completions path format.
- The extension still sends the key in the `api-key` header.

### Option C: OpenAI Or Another Compatible API

Use this for OpenAI and compatible services that follow the OpenAI-style REST API.

```jsonc
{
  "junior.azureOpenAI.provider": "openai",
  "junior.azureOpenAI.openaiBaseUrl": "https://api.openai.com/v1",
  "junior.azureOpenAI.deployments": [
    { "name": "GPT-4o", "deploymentId": "gpt-4o" },
    { "name": "GPT-4o Mini", "deploymentId": "gpt-4o-mini" },
    { "name": "o4-mini", "deploymentId": "o4-mini" }
  ],
  "junior.azureOpenAI.activeDeployment": "gpt-4o",
  "junior.inlineCompletions.deployment": "gpt-4o-mini"
}
```

Notes:

- In `openai` mode, `deploymentId` is the model name.
- `junior.azureOpenAI.apiVersion` is ignored in this mode.
- The extension sends your key as a bearer token.

Common compatible endpoints:

| Service | `junior.azureOpenAI.openaiBaseUrl` |
|---|---|
| OpenAI | `https://api.openai.com/v1` |
| GitHub Models | `https://models.inference.ai.azure.com` |
| OpenRouter | `https://openrouter.ai/api/v1` |
| Ollama | `http://localhost:11434/v1` |
| LM Studio | `http://localhost:1234/v1` |

## Store Your API Key

Preferred method:

1. Open the Command Palette.
2. Run **Junior: Set API Key**.
3. Paste the key when prompted.

Junior stores the key in VS Code SecretStorage, which uses the operating system credential store.

Fallback method:

- You can set `junior.azureOpenAI.apiKey` in settings.
- This works, but it is less secure than the command above.

## Settings Reference

All extension settings use the `junior.*` namespace.

### Connection And Models

| Setting | Default | Meaning |
|---|---|---|
| `junior.azureOpenAI.provider` | `"direct"` | Selects the connection mode: direct Azure OpenAI, APIM, or OpenAI-compatible API. |
| `junior.azureOpenAI.endpoint` | `""` | Azure OpenAI resource URL. Used only when provider is `direct`. |
| `junior.azureOpenAI.apimBaseUrl` | `""` | APIM base URL, including any required path prefix. Used only when provider is `apim`. |
| `junior.azureOpenAI.openaiBaseUrl` | `"https://api.openai.com/v1"` | Base URL for OpenAI-compatible APIs. Used only when provider is `openai`. |
| `junior.azureOpenAI.apiVersion` | `"2025-03-01-preview"` | Azure OpenAI API version for `direct` and `apim`. |
| `junior.azureOpenAI.deployments` | `[]` | List of selectable models. Each entry is an object with `name`, `deploymentId`, and optional `apiVersion`. |
| `junior.azureOpenAI.activeDeployment` | `""` | The model Junior uses by default for chat. |
| `junior.azureOpenAI.apiKey` | `""` | API key fallback stored in settings. Prefer **Junior: Set API Key** instead. |

### Model Behavior

| Setting | Default | Meaning |
|---|---|---|
| `junior.maxTokens` | `16384` | Maximum output tokens per response. Increase only if your model and endpoint support it. |
| `junior.temperature` | `0.3` | Response randomness. Lower values are more deterministic; higher values are more creative. |

### Agent Behavior

| Setting | Default | Meaning |
|---|---|---|
| `junior.agent.maxIterations` | `25` | Maximum number of tool-call loops Junior can take in one turn. |
| `junior.agent.contextWindow` | `128000` | The model context size Junior plans around when trimming and summarizing old messages. |
| `junior.agent.contextThreshold` | `0.7` | Fraction of the context window at which Junior starts summarizing older conversation content. |
| `junior.agent.confirmWrites` | `true` | Ask before writing or deleting files. |
| `junior.agent.confirmTerminal` | `true` | Ask before running terminal commands. |
| `junior.agent.autoInvestigate` | `true` | Before the first model call, gather likely context such as diagnostics and relevant files automatically. |
| `junior.agent.autoInvestigateMaxFiles` | `4` | Maximum number of likely files included in that automatic preflight investigation. |

### Workspace Indexing

| Setting | Default | Meaning |
|---|---|---|
| `junior.workspace.maxFileSize` | `100000` | Largest file size, in bytes, that Junior will index for search. |
| `junior.workspace.excludePatterns` | built-in list | Glob patterns excluded from indexing. Useful for large generated folders. |

Default exclude patterns:

```json
[
  "**/node_modules/**",
  "**/.git/**",
  "**/bin/**",
  "**/obj/**",
  "**/out/**",
  "**/dist/**",
  "**/*.min.js",
  "**/*.map"
]
```

### MCP Servers

These are optional. You only need them if your team uses external MCP tools.

| Setting | Default | Meaning |
|---|---|---|
| `junior.mcp.servers` | `{}` | Defines MCP servers. Use `{ command, args?, env?, cwd? }` for stdio or `{ url, headers?, authSession? }` for HTTP. |
| `junior.mcp.includeExternalServers` | `true` | Also load MCP server definitions from other VS Code settings. |
| `junior.mcp.externalServerSettings` | `["mcp.servers"]` | Settings paths that Junior also checks for MCP definitions. |

Minimal stdio example:

```jsonc
{
  "junior.mcp.servers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:/work"]
    }
  }
}
```

Minimal HTTP example:

```jsonc
{
  "junior.mcp.servers": {
    "remote-tools": {
      "url": "https://my-server.example/mcp",
      "headers": {
        "Authorization": "Bearer token"
      }
    }
  }
}
```

#### MCP Authentication

Junior supports three ways to authenticate with HTTP MCP servers, evaluated in this order:

1. **Explicit headers** — set `Authorization` (or any header) directly in the server config. Junior uses it as-is.
2. **`authSession` config** — tell Junior to fetch a token from a VS Code authentication provider and inject it into the request.
3. **Automatic detection** — if no auth is configured, Junior inspects the server URL and auto-authenticates for known providers.

**Automatic authentication (no config required):**

| Server URL | Auth provider | Scopes |
|---|---|---|
| `https://api.githubcopilot.com/mcp/*` | `github` | `repo`, `workflow`, `user:email`, `read:user` |
| `https://login.microsoftonline.com/*` (and `login.microsoft.com`, `login.windows.net`) | `microsoft` | (default) |

For the GitHub MCP server, this means you just need:

```jsonc
{
  "junior.mcp.servers": {
    "github": {
      "url": "https://api.githubcopilot.com/mcp/"
    }
  }
}
```

Junior will prompt for GitHub sign-in automatically and attach the token to every request.

**Explicit `authSession` config** — for servers that use a VS Code auth provider other than GitHub or Microsoft, or when you need custom scopes:

```jsonc
{
  "junior.mcp.servers": {
    "my-corporate-tools": {
      "url": "https://tools.corp.example/mcp",
      "authSession": {
        "providerId": "microsoft",
        "scopes": ["api://my-app/.default"],
        "tokenHeader": "Authorization",
        "tokenScheme": "Bearer",
        "createIfNone": true
      }
    }
  }
}
```

| `authSession` field | Default | Meaning |
|---|---|---|
| `providerId` | *(required)* | VS Code authentication provider ID (e.g. `github`, `microsoft`) |
| `scopes` | `[]` | OAuth scopes to request |
| `tokenHeader` | `"Authorization"` | HTTP header name for the token |
| `tokenScheme` | `"Bearer"` | Prefix before the token value. Set to `""` for a raw token with no prefix. |
| `createIfNone` | `false` | Prompt the user to sign in if no session exists. Set to `true` for interactive login. |

**401 challenge handling** — if an MCP server returns `401` with a `WWW-Authenticate` header, Junior automatically retries the request after resolving the OAuth challenge through the configured auth provider. This supports servers that use dynamic authentication negotiation.

### Inline Completions

| Setting | Default | Meaning |
|---|---|---|
| `junior.inlineCompletions.enabled` | `true` | Turns ghost-text suggestions on or off. |
| `junior.inlineCompletions.deployment` | `""` | Model used for inline completions. Leave empty to reuse the active chat model. |
| `junior.inlineCompletions.timeoutMs` | `5000` | Maximum wait time for a completion request before Junior cancels it. |
| `junior.inlineCompletions.candidates` | `1` | Number of alternative inline suggestions to fetch, from 1 to 3. |

Recommendation:

- keep chat on your best model
- set `junior.inlineCompletions.deployment` to a faster, cheaper model if you have one

### Slash Commands

| Setting | Default | Meaning |
|---|---|---|
| `junior.slashCommands.directories` | `[]` | Additional folders to scan for slash-command markdown files. Built-in command folders are always scanned. |

## Basic Use

Once the provider and API key are set, most users only need a few commands.

| Action | How to do it |
|---|---|
| Open the chat panel | Click the Junior activity icon or run **Junior: Open Chat** |
| Open chat with keyboard | Press `Ctrl+Shift+I` |
| Start a new conversation | Run **Junior: New Chat Session** |
| Change models | Run **Junior: Select Model** |
| Rebuild workspace index | Run **Junior: Index Workspace** |
| Explain, review, or fix selected code | Select text in the editor, then right-click |
| Trigger inline completion manually | Run **Junior: Trigger Inline Completion** or press `Alt+\` |
| Connect configured MCP servers | Run **Junior: Manage MCP Servers** |
| Inspect token usage | Run **Junior: Show Token Usage** |

Normal workflow:

1. Open the chat.
2. Ask for a change, explanation, or review.
3. Approve file writes or terminal commands if Junior asks.
4. Switch models if you want a different balance of speed and quality.

## Custom Project Instructions

You can add a `.junior/instructions.md` file (or `.github/copilot-instructions.md`) to any project repository to give Junior project-specific guidance. Junior reads this file from the workspace root at the start of every conversation and appends it to its system prompt.

Use it to tell Junior about:

- Build and test commands for your project
- Naming conventions or coding standards
- Architecture decisions or patterns to follow
- Files or directories that need special handling
- Frameworks, libraries, or APIs in use

The file is plain Markdown, capped at 4,000 characters. If both paths exist, the first one found is used.
### (Optional) Spec Kit Integration — Spec-Driven Development

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

## Troubleshooting

### The chat opens but requests fail

Check:

- the selected provider is correct
- the endpoint or base URL is correct
- the active deployment or model name exists
- your API key has been set

### The model picker is empty

`junior.azureOpenAI.deployments` is empty or malformed. Add at least one valid entry.

### Azure returns 404 or deployment errors

The most common causes are:

- `deploymentId` does not match the real Azure deployment name
- `junior.azureOpenAI.endpoint` or `junior.azureOpenAI.apimBaseUrl` is wrong
- the APIM route does not expose the expected Azure OpenAI path

### Inline completions do not appear

Check:

- `junior.inlineCompletions.enabled` is `true`
- the configured inline model exists
- the endpoint supports the selected model
- the request is not timing out; if needed, raise `junior.inlineCompletions.timeoutMs`


## License

See the LICENSE file included with this extension for full terms.
