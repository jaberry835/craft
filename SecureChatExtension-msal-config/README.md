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

If your Azure OpenAI or APIM route expects `Authorization: Bearer ...` instead of `api-key`, switch `junior.azureOpenAI.authMode` to `msal` and supply your own Entra app registration. See [Bearer auth via MSAL](#bearer-auth-via-msal) below.

For most teams, `junior.inlineCompletions.deployment` should be treated as part of initial setup, not an optional later tuning step. A common pattern is to keep chat on the main model and point inline completions at a faster model.

If your team shipped the VSIX with preset defaults, some of these values may already be filled in. You can still override them in your own settings.

Four fully-worked configuration examples appear below in [Provider Configuration Examples](#provider-configuration-examples). Pick the one that matches your environment and copy it into `settings.json`.

## Provider Options

| Provider value | Use this when | Required settings | Auth header |
|---|---|---|---|
| `direct` | You connect straight to an Azure OpenAI resource | `junior.azureOpenAI.endpoint`, `junior.azureOpenAI.deployments`, `junior.azureOpenAI.activeDeployment` | `api-key` |
| `apim` | Your organization exposes Azure OpenAI through Azure API Management | `junior.azureOpenAI.apimBaseUrl`, `junior.azureOpenAI.deployments`, `junior.azureOpenAI.activeDeployment` | `api-key` |
| `openai` | You use OpenAI or another OpenAI-compatible API | `junior.azureOpenAI.openaiBaseUrl`, `junior.azureOpenAI.deployments`, `junior.azureOpenAI.activeDeployment` | `api-key` |

For `direct` and `apim`, the default auth mode is `api-key`. To use Entra bearer tokens instead, see [Bearer auth via MSAL](#bearer-auth-via-msal) below.

If you already have a raw bearer token from another system, set `junior.azureOpenAI.authMode` to `bearer-token` and place the token in `junior.azureOpenAI.bearerToken`.

### Bearer auth via MSAL

For Entra-protected APIM or direct Azure OpenAI / Foundry, Junior signs in with MSAL using your own public-client app registration. Works in commercial AAD, Azure US Government, Azure China, and custom/air-gapped sovereign tenants.

Tokens are cached in VS Code SecretStorage and refreshed silently; you only re-sign-in when the refresh token expires.

#### App registration (one-time, in your tenant)

1. **App registrations → New registration** → any account-type, no redirect URI yet → Register.
2. **Authentication → + Add a platform → Mobile and desktop applications** → tick `http://localhost`. *Required* — without it sign-in fails with `AADSTS500113`.
3. **Authentication → Advanced settings → Allow public client flows = Yes**.
4. **API permissions** (only when calling a Microsoft-owned resource directly):
    - APIM-fronted Foundry (scope `api://<your-app>/user_impersonation`) → no API permission needed; just **Expose an API → add scope `user_impersonation`** so the audience exists.
    - Direct Foundry / AOAI (scope `https://cognitiveservices.azure.com/.default` or `https://ai.azure.com/.default`) → add delegated permission for **Azure Cognitive Services** (or **Azure AI Services**) → `user_impersonation` → **Grant admin consent**. Without it sign-in fails with `AADSTS650057`.
5. **Data-plane RBAC** on the AOAI / Foundry resource: assign the signed-in user **Cognitive Services OpenAI User** (`*.cognitiveservices.azure.com`) or **Cognitive Services User** (`*.services.ai.azure.com`). Required even when AAD issues the token.

#### Junior settings — local Azure / APIM

```jsonc
{
  "junior.azureOpenAI.authMode": "msal",
  "junior.azureOpenAI.authScopes": [
    // APIM-fronted: "api://<your-apim-app-clientid>/user_impersonation"
    // Direct AOAI:  "https://cognitiveservices.azure.com/.default"
    "https://cognitiveservices.azure.com/.default"
  ],

  // Shared MSAL block — reused by Copilot CLI BYOK as well
  "junior.msal.clientId": "<your-public-client-app-clientid>",
  "junior.msal.tenantId": "<your-tenant-guid-or-domain>",
  "junior.msal.cloudInstance": "https://login.microsoftonline.com"
}
```

#### Per-cloud authority

| Cloud | `junior.msal.cloudInstance` |
|---|---|
| Commercial | `https://login.microsoftonline.com` (default) |
| Azure US Government | `https://login.microsoftonline.us` |
| Azure China | `https://login.partner.microsoftonline.cn` |

For USNat / USSec / custom sovereign tenants, leave `cloudInstance` unset and provide:

```jsonc
"junior.msal.authority":        "https://login.<your-sovereign-host>/<tenant-guid>",
"junior.msal.knownAuthorities": ["login.<your-sovereign-host>"]
```

For headless / SSH workstations:

```jsonc
"junior.msal.interactiveFlow": "device-code"
```

#### Same pattern for Copilot CLI BYOK

```jsonc
{
  "junior.copilotCli.providerBearerTokenSource": "msal",
  "junior.copilotCli.providerAuthScopes": [
    "api://<your-apim-app-clientid>/user_impersonation"
  ]
  // junior.msal.* is shared with the AOAI block above
}
```

#### Commands

- **Junior: MSAL Sign In** — sign in and cache the token.
- **Junior: MSAL Sign Out** — pick an account and remove it.
- **Junior: MSAL Show Accounts** — list signed-in accounts.

Ready-to-paste scenario files for every provider × auth combination live in [`settings/`](settings/).

## Provider Configuration Examples

Four scenarios below cover the common deployment shapes. Pick one and paste into `settings.json`. Set the API key (where applicable) with **Junior: Set API Key** — do not put it in `settings.json`.

For the matching scenario for Copilot CLI BYOK and additional combinations (sovereign overlays, OpenAI-compatible, etc.), see the ready-to-paste files in [`settings/`](settings/).

### 1. Direct Azure OpenAI — API key

Use when you connect straight to an Azure OpenAI / Foundry resource and the resource accepts an `api-key` header.

```jsonc
{
  "junior.azureOpenAI.provider": "direct",
  "junior.azureOpenAI.endpoint": "https://<your-resource>.openai.azure.com",
  "junior.azureOpenAI.apiVersion": "2025-04-01-preview",
  "junior.azureOpenAI.deployments": [
    { "name": "GPT-5.4",      "deploymentId": "gpt-5.4",      "apiVersion": "2025-04-01-preview" },
    { "name": "gpt-5.4-mini", "deploymentId": "gpt-5.4-mini", "apiVersion": "2025-04-01-preview" }
  ],
  "junior.azureOpenAI.activeDeployment": "gpt-5.4",
  "junior.inlineCompletions.deployment": "gpt-5.4-mini"
}
```

Notes:

- `deploymentId` must match the Azure deployment name exactly.
- `apiVersion` can be set globally on `junior.azureOpenAI.apiVersion`, per-deployment, or both.
- The key is sent in the `api-key` header.

### 2. APIM in front of Azure OpenAI — API key (subscription key)

Use when your organization fronts AOAI with APIM and the API requires a subscription key.

```jsonc
{
  "junior.azureOpenAI.provider": "apim",
  "junior.azureOpenAI.apimBaseUrl": "https://<your-apim>.azure-api.net/<api-suffix>",
  "junior.azureOpenAI.apiVersion": "2025-04-01-preview",
  "junior.azureOpenAI.deployments": [
    { "name": "GPT-5.4",      "deploymentId": "gpt-5.4",      "apiVersion": "2025-04-01-preview" },
    { "name": "gpt-5.4-mini", "deploymentId": "gpt-5.4-mini", "apiVersion": "2025-04-01-preview" }
  ],
  "junior.azureOpenAI.activeDeployment": "gpt-5.4",
  "junior.inlineCompletions.deployment": "gpt-5.4-mini"
}
```

Notes:

- `apimBaseUrl` includes the APIM API URL suffix (e.g. `/foundryapi`, `/openai`). Junior appends the AOAI path itself.
- The key is sent as `Ocp-Apim-Subscription-Key`.
- The APIM operation must expose the AOAI chat completions / responses path format.

### 3. APIM in front of Azure OpenAI — Entra bearer (MSAL)

Use when APIM authenticates inbound calls with Entra (`validate-jwt`) and forwards to AOAI with its managed identity. End-to-end works in commercial AAD, US Gov, China, and custom sovereign tenants.

App registration prerequisites: see [Bearer auth via MSAL](#bearer-auth-via-msal) above (`http://localhost` redirect, public-client flows on, `Expose an API` with `user_impersonation` scope).

```jsonc
{
  "junior.azureOpenAI.provider": "apim",
  "junior.azureOpenAI.apimBaseUrl": "https://<your-apim>.azure-api.net/<api-suffix>",
  "junior.azureOpenAI.apiVersion": "2025-04-01-preview",
  "junior.azureOpenAI.deployments": [
    { "name": "GPT-5.4",      "deploymentId": "gpt-5.4",      "apiVersion": "2025-04-01-preview" },
    { "name": "gpt-5.4-mini", "deploymentId": "gpt-5.4-mini", "apiVersion": "2025-04-01-preview" }
  ],
  "junior.azureOpenAI.activeDeployment": "gpt-5.4",
  "junior.inlineCompletions.deployment": "gpt-5.4-mini",

  "junior.azureOpenAI.authMode": "msal",
  "junior.azureOpenAI.authScopes": [
    "api://<your-apim-app-clientid>/user_impersonation"
  ],

  "junior.msal.clientId": "<your-public-client-app-clientid>",
  "junior.msal.tenantId": "<your-tenant-guid-or-domain>",
  "junior.msal.cloudInstance": "https://login.microsoftonline.com"
}
```

For sovereign clouds, change `cloudInstance` (or use `authority` + `knownAuthorities` for custom hosts) per the [per-cloud authority table](#per-cloud-authority).

First-time sign-in: run **Junior: MSAL Sign In**, then send a chat. Subsequent runs refresh silently.

### 4. OpenAI / OpenAI-compatible API

Use for OpenAI itself and any service that follows the OpenAI REST shape (GitHub Models, OpenRouter, Ollama, LM Studio, etc.).

```jsonc
{
  "junior.azureOpenAI.provider": "openai",
  "junior.azureOpenAI.openaiBaseUrl": "https://api.openai.com/v1",
  "junior.azureOpenAI.deployments": [
    { "name": "GPT-4o",      "deploymentId": "gpt-4o" },
    { "name": "GPT-4o Mini", "deploymentId": "gpt-4o-mini" }
  ],
  "junior.azureOpenAI.activeDeployment": "gpt-4o",
  "junior.inlineCompletions.deployment": "gpt-4o-mini"
}
```

Notes:

- In `openai` mode, `deploymentId` is the model name.
- `junior.azureOpenAI.apiVersion` is ignored.
- The key is sent as `Authorization: Bearer ...`.

Common compatible base URLs:

| Service | `junior.azureOpenAI.openaiBaseUrl` |
|---|---|
| OpenAI | `https://api.openai.com/v1` |
| GitHub Models | `https://models.inference.ai.azure.com` |
| OpenRouter | `https://openrouter.ai/api/v1` |
| Ollama | `http://localhost:11434/v1` |
| LM Studio | `http://localhost:1234/v1` |

## Optional: Copilot CLI Provider

Junior can also route agent turns through GitHub Copilot CLI via the Copilot SDK. The same four scenarios from above (direct AOAI key, APIM key, APIM MSAL bearer, OpenAI-compatible) work with Copilot CLI BYOK — just with `junior.copilotCli.*` settings instead of `junior.azureOpenAI.*`.

Prerequisites:

1. Install GitHub CLI and run `gh auth login` once.
2. Install GitHub Copilot CLI (`npm i -g @github/copilot`) and make sure `copilot` resolves on `PATH`, or set `junior.copilotCli.path` to the launcher.
3. On Windows, point `junior.copilotCli.path` at the `copilot.cmd` shim (e.g. `C:\\Users\\<you>\\AppData\\Roaming\\npm\\copilot.cmd`) — Junior wraps `.cmd`/`.bat` shims with `cmd.exe` automatically. Use `copilot.exe` only if you have a native binary.

API key handling: run **Junior: Set Copilot CLI Provider API Key** to store the key in VS Code SecretStorage. Do not put it in `settings.json`. Run the same command with an empty input to clear it.

> Note: `gpt-4.1` is **not** compatible with the Copilot SDK Responses-API path because it doesn't support encrypted reasoning content. Use a `gpt-5.x` model with Copilot CLI BYOK.

Ready-to-paste scenario files for Copilot CLI live in [`settings/`](settings/) (`settings.copilot-cli-*.json`). The four canonical shapes:

### A. Copilot CLI — Direct AOAI / Foundry, API key

```jsonc
{
  "junior.agentProvider": "copilot-cli",
  "junior.copilotCli.path": "C:\\Users\\<you>\\AppData\\Roaming\\npm\\copilot.cmd",
  "junior.copilotCli.model": "gpt-5.2",
  "junior.copilotCli.models": [
    { "name": "GPT-5.2", "id": "gpt-5.2" }
  ],
  "junior.copilotCli.providerType": "azure",
  "junior.copilotCli.providerBaseUrl": "https://<your-resource>.cognitiveservices.azure.com/",
  "junior.copilotCli.providerWireApi": "responses",
  "junior.copilotCli.providerAzureApiVersion": "2025-03-01-preview"
}
```

### B. Copilot CLI — APIM in front of AOAI, subscription key

```jsonc
{
  "junior.agentProvider": "copilot-cli",
  "junior.copilotCli.path": "C:\\Users\\<you>\\AppData\\Roaming\\npm\\copilot.cmd",
  "junior.copilotCli.model": "gpt-5.2",
  "junior.copilotCli.models": [
    { "name": "GPT-5.2", "id": "gpt-5.2" }
  ],
  "junior.copilotCli.providerType": "azure",
  "junior.copilotCli.providerBaseUrl": "https://<your-apim>.azure-api.net",
  "junior.copilotCli.providerWireApi": "responses"
  // Leave providerAzureApiVersion UNSET for APIM mode.
}
```

### C. Copilot CLI — APIM in front of AOAI, Entra bearer (MSAL)

```jsonc
{
  "junior.agentProvider": "copilot-cli",
  "junior.copilotCli.path": "C:\\Users\\<you>\\AppData\\Roaming\\npm\\copilot.cmd",
  "junior.copilotCli.model": "gpt-5.2",
  "junior.copilotCli.models": [
    { "name": "GPT-5.2", "id": "gpt-5.2" }
  ],
  "junior.copilotCli.providerType": "azure",
  "junior.copilotCli.providerBaseUrl": "https://<your-apim>.azure-api.net",
  "junior.copilotCli.providerWireApi": "responses",

  "junior.copilotCli.providerBearerTokenSource": "msal",
  "junior.copilotCli.providerAuthScopes": [
    "api://<your-apim-app-clientid>/user_impersonation"
  ],

  "junior.msal.clientId": "<your-public-client-app-clientid>",
  "junior.msal.tenantId": "<your-tenant-guid-or-domain>",
  "junior.msal.cloudInstance": "https://login.microsoftonline.com"
}
```

The `junior.msal.*` block is shared with the local agent — sign in once with **Junior: MSAL Sign In** and both runtimes pick up the cached token.

### D. Copilot CLI — OpenAI / OpenAI-compatible

```jsonc
{
  "junior.agentProvider": "copilot-cli",
  "junior.copilotCli.path": "C:\\Users\\<you>\\AppData\\Roaming\\npm\\copilot.cmd",
  "junior.copilotCli.model": "gpt-4o",
  "junior.copilotCli.models": [
    { "name": "GPT-4o",      "id": "gpt-4o" },
    { "name": "GPT-4o mini", "id": "gpt-4o-mini" }
  ],
  "junior.copilotCli.providerType": "openai",
  "junior.copilotCli.providerBaseUrl": "https://api.openai.com/v1"
  // Ollama:    "http://localhost:11434/v1"
  // LM Studio: "http://localhost:1234/v1"
  // wireApi defaults to "chat" for openai providerType — set explicitly only
  // if your endpoint requires the Responses API:
  // "junior.copilotCli.providerWireApi": "responses"
}
```

Optional Copilot CLI knobs:

- `junior.copilotCli.autoApproveWrites` / `autoApproveTerminal` — opt-in auto-approval for Copilot CLI's built-in tools (default `false`).
- `junior.copilotCli.logSdkEvents` — set to `true` to dump raw Copilot SDK session events to the `Junior` output channel for debugging.
- `junior.copilotCli.home` — only set if you intentionally want to override `COPILOT_HOME`.

Environment-variable fallback: if you launched VS Code from a shell where `COPILOT_MODEL`, `COPILOT_PROVIDER_BASE_URL`, `COPILOT_PROVIDER_TYPE`, `COPILOT_PROVIDER_API_KEY`, `COPILOT_PROVIDER_BEARER_TOKEN`, `COPILOT_PROVIDER_AZURE_API_VERSION`, or `COPILOT_PROVIDER_WIRE_API` were already set, Junior inherits them. Settings above take precedence over env vars; the Copilot CLI option is hidden if no auth/BYOK prerequisites are present.

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
