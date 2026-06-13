# Junior User Guide

Junior is a VS Code extension that brings agentic chat and inline coding assistance to air-gapped, offline, and otherwise restricted development environments using **Azure OpenAI**, **OpenAI**, **OpenAI-compatible**, or **GitHub Copilot CLI** backends.

## What Junior Does

Junior adds an AI chat panel and inline code completions to VS Code. It can connect to:

- **Azure OpenAI** directly
- **Azure API Management (APIM)** in front of Azure OpenAI / Foundry
- **OpenAI-compatible APIs** (OpenAI, GitHub Models, OpenRouter, Ollama, LM Studio)
- **GitHub Copilot CLI** (optional, via the Copilot SDK)

## New User Path

If you are setting up Junior for the first time, use this path:

1. Install the `.vsix`.
2. Pick the sample settings file that matches your environment.
3. Copy that sample into your VS Code user `settings.json`.
4. Add an API key or sign in, depending on your environment.
5. Open the chat with `Ctrl+Shift+I`.

### Which setup should I choose?

> The filenames in the table below are bundled inside the VSIX. The fastest way to open one is **Junior: Open Sample Settings** from the Command Palette — that works fully offline. The links also resolve on GitHub and the VS Code Marketplace.

| If your environment looks like this | Sample file | Auth |
|---|---|---|
| You have a direct Azure OpenAI / Foundry endpoint | [`samples/direct-key.settings.json`](samples/direct-key.settings.json) | Resource key |
| You have Azure API Management (APIM) in front of Azure OpenAI / Foundry and were given a subscription key | [`samples/apim-key.settings.json`](samples/apim-key.settings.json) | APIM subscription key |
| You have Azure API Management (APIM) and your team wants VS Code / Entra sign-in | [`samples/apim-bearer.settings.json`](samples/apim-bearer.settings.json) | Bearer token from VS Code sign-in |
| You have an OpenAI-compatible endpoint such as OpenAI, GitHub Models, OpenRouter, Ollama, or LM Studio | [`samples/openai-compat-key.settings.json`](samples/openai-compat-key.settings.json) | Provider API key |
| You want Junior to route agent turns through GitHub Copilot CLI | Go to [Optional: GitHub Copilot CLI Provider](#optional-github-copilot-cli-provider) | GitHub sign-in or BYOK |

If you are not sure, start with the sample your administrator or team documentation gave you. In most enterprise setups, that is usually one of the APIM samples.

### What you should see after setup

After a successful first run:

- Junior appears in the VS Code Activity Bar.
- **Junior: Open Chat** opens a working chat panel.
- the model picker shows at least one model or deployment.
- requests do not fail with missing key, missing sign-in, or missing deployment errors.

## Before You Start

You need:

- VS Code 1.85.0 or later
- a `junior-*.vsix` file from your team or administrator
- network access to your AI endpoint
- an API key, bearer token, or Entra sign-in for that endpoint
- at least one model or deployment that supports chat and tool calling

You do **not** need to build the extension from source.

Terms used in this guide:

- **APIM** = Azure API Management
- **Entra sign-in** = Microsoft identity sign-in through VS Code
- **BYOK** = bring your own key / provider configuration

## Install

1. Open the Command Palette (`Ctrl+Shift+P`).
2. Run **Extensions: Install from VSIX...** and pick the `.vsix`.
3. Run **Developer: Reload Window** if VS Code does not reload on its own.
4. Open Junior from the Activity Bar, or run **Junior: Open Chat**.

On first open, Junior shows a splash screen with **Configure Settings** and **Set API Key** buttons. That is the fastest way to reach the two setup steps most users need.

To browse the bundled sample settings and setup guides without leaving VS Code, open the Command Palette (`Ctrl+Shift+P`) and run **Junior: Open Sample Settings** or **Junior: Open Documentation**.

## Quick Start

> **Tip:** Sample settings files and setup guides are bundled with the VSIX. Open the Command Palette (`Ctrl+Shift+P`) and run:
>
> - **Junior: Open Sample Settings** — browse and open any bundled sample `settings.json` directly in VS Code.
> - **Junior: Open Documentation** — browse and open any bundled setup guide directly in VS Code.
>
> The links in the rest of this README open on GitHub when viewed from the Marketplace or Extensions view. The two commands above are the offline-friendly way to reach the same files.

The fastest setup path for most users is:

1. Run **Junior: Open Sample Settings** and pick the file that matches your environment (see the table below for what each one does).
2. Copy its contents into your VS Code user `settings.json` (Command Palette → **Preferences: Open User Settings (JSON)**).
3. Replace the placeholder host names, app IDs, and deployment IDs.
4. Run **Junior: Set API Key** if your sample uses key auth, or **Junior: Sign In for Azure/APIM Bearer Mode** if your sample uses bearer auth.
5. Open the chat with `Ctrl+Shift+I`.

> **Tip:** If you are running VS Code directly on a network that uses a private or enterprise TLS certificate chain, run **Junior: Add CA Refresh Script** after the normal settings step. Junior creates a user-level refresh script and PEM cache in VS Code extension storage, then writes Junior User settings so every workspace can use them. Paste your site's refresh code into the script so it writes the full PEM chain to the `$CaCertPath` parameter. On the first certificate validation failure, Junior will ask permission to run that script and retry the request once after it succeeds.

### Bundled Sample Settings

| Sample | Provider | Auth |
|---|---|---|
| [`samples/apim-key.settings.json`](samples/apim-key.settings.json) | APIM in front of Azure OpenAI / Foundry | APIM subscription key (`api-key` header) |
| [`samples/apim-bearer.settings.json`](samples/apim-bearer.settings.json) | APIM in front of Azure OpenAI / Foundry | VS Code sign-in bearer token (Entra) |
| [`samples/direct-key.settings.json`](samples/direct-key.settings.json) | Direct Azure OpenAI / Foundry resource | Resource key (`api-key` header) |
| [`samples/openai-compat-key.settings.json`](samples/openai-compat-key.settings.json) | OpenAI / OpenRouter / Ollama / LM Studio / etc. | Provider API key (`Authorization: Bearer`) |

Each sample is annotated inline with what to replace and which command to run after copying it in.

> Bearer auth for the direct Azure OpenAI / Foundry path is supported but not shipped as a sample — see [docs/ENTRA-VSCODE-AUTH-APP-SETUP.md](docs/ENTRA-VSCODE-AUTH-APP-SETUP.md) (or run **Junior: Open Documentation**) for the full pattern.

## Store Your API Key

Junior keeps API keys in VS Code SecretStorage (backed by your OS credential manager) instead of plain `settings.json`. There are two separate keys, one per provider path:

### Local provider (Azure OpenAI / APIM / OpenAI-compatible)

1. Open the Command Palette.
2. Run **Junior: Set API Key**.
3. Paste the key.

Fallback: set `junior.azureOpenAI.apiKey` in settings (less secure).

### Copilot CLI BYOK provider

When `junior.agentProvider` is `copilot-cli` and your BYOK provider needs an API key:

1. Open the Command Palette.
2. Run **Junior: Set Copilot CLI API Key**.
3. Paste the key. Submit empty to clear it.

Resolution order (highest first):

1. SecretStorage value set by **Junior: Set Copilot CLI API Key**
2. `junior.copilotCli.providerApiKey` setting
3. `COPILOT_PROVIDER_API_KEY` environment variable

## Advanced: Bearer Auth and VS Code Sign-In

Most new users can skip this section unless their endpoint expects `Authorization: Bearer ...` or their team specifically told them to use VS Code sign-in.

If your endpoint expects `Authorization: Bearer ...`, Junior can either use a raw token or have VS Code do the sign-in for you.

### VS Code sign-in (recommended for Azure / APIM)

Set `authMode` to `vscode-auth-session` and tell Junior which provider and scopes to use:

```jsonc
{
  "junior.azureOpenAI.authMode": "vscode-auth-session",
  "junior.azureOpenAI.bearerTokenSource": "vscode-auth-session",
  "junior.azureOpenAI.authProviderId": "microsoft",
  "junior.azureOpenAI.authScopes": [
    "api://<api-app-clientid>/user_impersonation"
  ]
}
```

Then run **Junior: Sign In for Azure/APIM Bearer Mode** once. The same pattern applies to Copilot CLI BYOK via the `junior.copilotCli.providerAuthProviderId` / `providerAuthScopes` settings and **Junior: Sign In for Copilot CLI Bearer Mode**.

If APIM rejects the sign-in with `AADSTS500113` ("reply URL not registered"), you almost certainly need the two-Entra-app pattern documented in [docs/ENTRA-VSCODE-AUTH-APP-SETUP.md](docs/ENTRA-VSCODE-AUTH-APP-SETUP.md). That guide also covers VS Code's built-in client id (`aebc6443-996d-45c2-90f0-388ff96faa56`) and the `VSCODE_CLIENT_ID:` / `VSCODE_TENANT:` scope override.

### Sovereign / government clouds

For Azure US Government, Azure China, and other sovereign tenants, switch the auth provider id to `microsoft-sovereign-cloud` and set the matching VS Code environment:

```jsonc
{
  "junior.azureOpenAI.authProviderId": "microsoft-sovereign-cloud",
  "microsoft-sovereign-cloud.environment": "AzureUSGovernment"
}
```

The audience in `authScopes` controls the token's `aud` claim — it is **not** derived from the endpoint URL. If you switch a workspace from commercial to gov, update both `authProviderId` and `authScopes` together.

### Raw bearer token

If you already have a token from another system, set `authMode` to `bearer-token` and place it in `junior.azureOpenAI.bearerToken`. Refresh is your responsibility.

### Token refresh and logging

- Junior asks VS Code for a token each time it builds a request. Silent refresh happens when the provider supports it.
- The **Junior** output channel logs the resolved auth mode and safe token claims (`aud`, `scp`, `exp`) without printing the token itself.

## Optional: GitHub Copilot CLI Provider

Most users do not need this section. Use it only if you want Junior to route agent turns through GitHub Copilot CLI instead of the built-in local provider.

Junior can route agent turns through GitHub Copilot CLI via the Copilot SDK.

Prerequisites:

1. Install GitHub CLI and GitHub Copilot CLI.
2. Make `copilot` available on `PATH`, or set `junior.copilotCli.path` to the executable. On Windows, both `copilot.exe` and the `copilot.cmd` shim work.
3. Either sign in to GitHub through Copilot CLI, or configure BYOK provider settings (key or bearer).

Junior hides the Copilot CLI option in the UI unless the executable is found and at least one auth path is available.

Minimal selector settings:

```jsonc
{
  "junior.agentProvider": "copilot-cli",
  "junior.copilotCli.path": "C:\\Users\\you\\AppData\\Roaming\\npm\\copilot.cmd",
  "junior.copilotCli.model": "gpt-4.1",
  "junior.copilotCli.models": [
    { "name": "GPT-4.1", "id": "gpt-4.1" }
  ]
}
```

For BYOK details (key or bearer through APIM, sovereign cloud), see the same APIM guides Junior uses:

- [docs/APIM-FOUNDRY-KEY-SETUP.md](docs/APIM-FOUNDRY-KEY-SETUP.md) — APIM in front of Foundry, subscription-key auth.
- [docs/APIM-FOUNDRY-BEARER-SETUP.md](docs/APIM-FOUNDRY-BEARER-SETUP.md) — APIM in front of Foundry, Entra bearer auth (with managed identity to the backend).

For Copilot SDK troubleshooting, set `junior.copilotCli.logSdkEvents` to `true` and inspect the **Junior** output channel.

## Basic Use

| Action | How to do it |
|---|---|
| Open the chat panel | Click the Junior activity icon, run **Junior: Open Chat**, or press `Ctrl+Shift+I` |
| Start a new conversation | Run **Junior: New Chat Session** |
| Change models | Run **Junior: Select Model** |
| Rebuild workspace index | Run **Junior: Index Workspace** |
| Explain, review, or fix selected code | Select text in the editor, then right-click |
| Trigger inline completion manually | Run **Junior: Trigger Inline Completion** or press `Alt+\` |
| Connect configured MCP servers | Run **Junior: Manage MCP Servers** |
| Inspect token usage | Run **Junior: Show Token Usage** |
| Open a bundled sample settings file | Run **Junior: Open Sample Settings** |
| Open a bundled setup guide | Run **Junior: Open Documentation** |
| Add a user-level CA refresh script | Run **Junior: Add CA Refresh Script** |

Normal workflow:

1. Open the chat.
2. Ask for a change, explanation, or review.
3. Approve file writes or terminal commands when Junior asks.
4. Switch models for a different speed/quality balance.

## Custom Project Instructions

Add a `.junior/instructions.md` file (or `.github/copilot-instructions.md`) to any repo to give Junior project-specific guidance. Junior reads it at the start of every conversation and appends it to its system prompt.

Use it for:

- build and test commands
- coding standards and naming conventions
- architecture decisions
- files or directories that need special handling
- frameworks and APIs in use

Plain Markdown, capped at 4,000 characters. If both paths exist, the first one found is used.

### Slash Commands and Spec Kit (Optional)

Type `/` in the chat input to see available commands. Any `.md` or `.prompt.md` file in the command directories below works as a slash command (YAML frontmatter is stripped automatically):

1. directories listed in `junior.slashCommands.directories`
2. `.junior/commands/`
3. `.github/copilot/commands/`
4. `.github/commands/`
5. `.github/prompts/`

Junior is compatible with [GitHub Spec Kit](https://github.com/github/spec-kit) — **no GitHub Copilot install, sign-in, or network access required**. Spec Kit is a Python CLI that just writes prompt templates into your repo; Junior reads them locally. Two ways to set it up:

- **Portable (recommended for restricted environments)** — `specify init . --ai generic --ai-commands-dir .junior/commands`. Commit `.junior/commands/` so the whole team gets the slash commands without installing Spec Kit.
- **Drop-in** — `specify init . --ai copilot` writes to `.github/prompts/` and gives you `/speckit.constitution`, `/speckit.specify`, `/speckit.plan`, `/speckit.tasks`, `/speckit.implement`, `/speckit.clarify`, and `/speckit.analyze`. The `--ai copilot` flag only selects which template variant Spec Kit writes — it does not require Copilot to be installed or signed in. Use this if you also use Copilot Chat in non-restricted projects and want one shared prompt set.

The `.specify/scripts/powershell/` helpers Spec Kit drops in your repo run via Junior's terminal tool on Windows with no WSL.

## Settings Reference

Everything below is reference material. If you are still doing first-run setup, you can stop after **Quick Start** and come back here only when you need a specific setting.

All settings use the `junior.*` namespace. Only the settings most users touch are listed here; see `package.json` for the full list.

### Connection and Models

| Setting | Default | Meaning |
|---|---|---|
| `junior.agentProvider` | `"local"` | `local` (built-in agent loop) or `copilot-cli` (route via Copilot SDK). |
| `junior.azureOpenAI.provider` | `"direct"` | `direct`, `apim`, or `openai`. |
| `junior.azureOpenAI.endpoint` | `""` | Resource URL. Used when `provider` is `direct`. |
| `junior.azureOpenAI.apimBaseUrl` | `""` | APIM base URL with required path prefix. Used when `provider` is `apim`. |
| `junior.azureOpenAI.openaiBaseUrl` | `"https://api.openai.com/v1"` | Base URL for OpenAI-compatible APIs. |
| `junior.azureOpenAI.apiVersion` | `"2025-03-01-preview"` | Azure OpenAI API version. Used when `wireApi` is `chat-completions` (the v1 `responses` wire API does not require it). |
| `junior.azureOpenAI.deployments` | `[]` | Selectable models. Each entry: `{ name, deploymentId, apiVersion? }`. |
| `junior.azureOpenAI.activeDeployment` | `""` | Default chat model. |
| `junior.azureOpenAI.apiKey` | `""` | Settings-based API key fallback. Prefer **Junior: Set API Key**. |

### Wire API (responses vs. chat-completions)

The APIM samples default to **`wireApi: responses`** — the new `/openai/v1/responses` route that the Azure AI Foundry portal exposes when you import the Foundry API template into APIM. It's faster on tool-call-heavy turns (server-side state), surfaces typed reasoning events for the **Thinking** panel, and puts the model in the request body so you don't need an `api-version` query parameter.

If your APIM route does NOT expose `/openai/v1/responses` (older Azure OpenAI template imports, classic AOAI deployments, OpenAI-compat endpoints), set `junior.azureOpenAI.wireApi` to `chat-completions` (or remove it — that's still the built-in default) and Junior reverts to `/openai/deployments/{id}/chat/completions?api-version=...`.

| Setting | Default | Meaning |
|---|---|---|
| `junior.azureOpenAI.wireApi` | `"chat-completions"` | `responses` for the Foundry `/openai/v1/responses` path; `chat-completions` for the classic Azure OpenAI deployment route. The bundled APIM samples set this to `responses`. |
| `junior.azureOpenAI.reasoningEffort` | `"high"` | `none`, `low`, `medium`, `high`, or `xhigh`. Honored only when `wireApi=responses` and the deployment is reasoning-capable. Lower = faster + cheaper. |
| `junior.azureOpenAI.reasoningSummary` | `"auto"` | `auto`, `detailed`, or `none`. Controls the streamed reasoning summary that powers the **Thinking** panel in the chat view. |
| `junior.azureOpenAI.useServerSideState` | `false` | When `true` and `wireApi=responses`, threads `previous_response_id` across iterations so the model doesn't re-derive prior reasoning. Once a response id is held, only incremental conversation items (new tool results / turns) are sent instead of the full transcript, keeping requests small. |

See [docs/APIM-FOUNDRY-KEY-SETUP.md](docs/APIM-FOUNDRY-KEY-SETUP.md) or [docs/APIM-FOUNDRY-BEARER-SETUP.md](docs/APIM-FOUNDRY-BEARER-SETUP.md) for the matching APIM configuration.

### Local Bearer Auth

| Setting | Default | Meaning |
|---|---|---|
| `junior.azureOpenAI.authMode` | `"api-key"` | `api-key`, `bearer-token`, or `vscode-auth-session`. |
| `junior.azureOpenAI.bearerToken` | `""` | Raw bearer token when `authMode` is `bearer-token`. |
| `junior.azureOpenAI.bearerTokenSource` | `""` | Set to `vscode-auth-session` to mirror `authMode`. |
| `junior.azureOpenAI.authProviderId` | `"microsoft"` | VS Code auth provider id (`microsoft`, `microsoft-sovereign-cloud`, etc.). |
| `junior.azureOpenAI.authScopes` | `[]` | Token scopes / audience. May include `VSCODE_CLIENT_ID:<id>` and `VSCODE_TENANT:<tenant>` overrides. |

### Copilot CLI BYOK

| Setting | Default | Meaning |
|---|---|---|
| `junior.copilotCli.path` | `"copilot"` | Path to the Copilot CLI executable. |
| `junior.copilotCli.model` | `""` | Model id passed to the CLI. Required for BYOK. |
| `junior.copilotCli.models` | `[]` | Models offered in the picker. |
| `junior.copilotCli.providerType` | `"openai"` | `openai`, `azure`, or `anthropic`. |
| `junior.copilotCli.providerBaseUrl` | `""` | Provider base URL. |
| `junior.copilotCli.providerApiKey` | `""` | Settings fallback. Prefer **Junior: Set Copilot CLI API Key**. |
| `junior.copilotCli.providerBearerToken` | `""` | Raw bearer token. |
| `junior.copilotCli.providerBearerTokenSource` | `""` | Set to `vscode-auth-session` for VS Code sign-in. |
| `junior.copilotCli.providerAuthProviderId` | `"microsoft"` | VS Code auth provider id for bearer mode. |
| `junior.copilotCli.providerAuthScopes` | `[]` | Token scopes for bearer mode. |
| `junior.copilotCli.providerWireApi` | `""` | `responses` for GPT-5-class models behind APIM, otherwise leave unset. |
| `junior.copilotCli.providerAzureApiVersion` | `""` | Azure API version for direct Azure BYOK. |
| `junior.copilotCli.logSdkEvents` | `false` | Log raw Copilot SDK events to the **Junior** output channel. |

### Model Behavior

| Setting | Default | Meaning |
|---|---|---|
| `junior.maxTokens` | `16384` | Max output tokens per response. |
| `junior.temperature` | `0.3` | Response randomness. |

### Agent Behavior

| Setting | Default | Meaning |
|---|---|---|
| `junior.agent.maxIterations` | `25` | Max tool-call loops per turn. |
| `junior.agent.contextWindow` | `128000` | Model context size used for trimming and summarization. |
| `junior.agent.contextThreshold` | `0.7` | Fraction of the context window at which Junior summarizes older content. |
| `junior.agent.confirmWrites` | `true` | Ask before writing or deleting files. |
| `junior.agent.confirmTerminal` | `true` | Ask before running terminal commands. |
| `junior.agent.autoInvestigate` | `true` | Gather likely context (diagnostics, related files) before the first model call. |
| `junior.agent.autoInvestigateMaxFiles` | `4` | Max files included in that preflight investigation. |

### Inline Completions

| Setting | Default | Meaning |
|---|---|---|
| `junior.inlineCompletions.enabled` | `true` | Turns ghost-text suggestions on or off. |
| `junior.inlineCompletions.deployment` | `""` | Model used for inline completions. Leave empty to reuse the chat model. |
| `junior.inlineCompletions.timeoutMs` | `5000` | Max wait time per request before Junior cancels it. |
| `junior.inlineCompletions.candidates` | `1` | Number of alternative suggestions to fetch (1–3). |

### Workspace Indexing

| Setting | Default | Meaning |
|---|---|---|
| `junior.workspace.maxFileSize` | `100000` | Largest file size, in bytes, that Junior will index. |
| `junior.workspace.excludePatterns` | built-in list | Glob patterns excluded from indexing. |

## MCP Servers

These are optional. You only need them if your team uses external MCP tools.

| Setting | Default | Meaning |
|---|---|---|
| `junior.mcp.servers` | `{}` | MCP server definitions. Use `{ command, args?, env?, cwd? }` for stdio or `{ url, headers?, authSession? }` for HTTP. |
| `junior.mcp.includeExternalServers` | `true` | Also load MCP server definitions from other VS Code settings. |
| `junior.mcp.externalServerSettings` | `["mcp.servers"]` | Additional settings paths Junior also checks. |

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
    "github": {
      "url": "https://api.githubcopilot.com/mcp/"
    }
  }
}
```

For known providers, Junior auto-detects auth:

| Server URL | Auth provider | Scopes |
|---|---|---|
| `https://api.githubcopilot.com/mcp/*` | `github` | `repo`, `workflow`, `user:email`, `read:user` |
| `https://login.microsoftonline.com/*` (and `login.microsoft.com`, `login.windows.net`) | `microsoft` | (default) |

For other servers, configure auth explicitly using `headers` or `authSession`:

```jsonc
{
  "junior.mcp.servers": {
    "my-corporate-tools": {
      "url": "https://tools.corp.example/mcp",
      "authSession": {
        "providerId": "microsoft",
        "scopes": ["api://my-app/.default"],
        "tokenScheme": "Bearer",
        "createIfNone": true
      }
    }
  }
}
```

| `authSession` field | Default | Meaning |
|---|---|---|
| `providerId` | *(required)* | VS Code authentication provider id |
| `scopes` | `[]` | OAuth scopes to request |
| `tokenHeader` | `"Authorization"` | Header to attach the token to |
| `tokenScheme` | `"Bearer"` | Prefix before the token. Empty string for raw token. |
| `createIfNone` | `false` | Prompt to sign in if no session exists |

If an MCP server returns `401` with a `WWW-Authenticate` header, Junior automatically retries after resolving the OAuth challenge through the configured provider.

## Troubleshooting

### Chat opens but requests fail

- Provider is wrong (`junior.azureOpenAI.provider`).
- Endpoint or base URL is wrong.
- Active deployment / model name does not exist.
- API key is missing — run **Junior: Set API Key**.

### Model picker is empty

`junior.azureOpenAI.deployments` is empty or malformed. Add at least one valid entry.

### Azure returns 404

- `deploymentId` does not match the real Azure deployment name.
- `endpoint` or `apimBaseUrl` is wrong.
- The APIM route does not expose the expected Azure OpenAI path.

### Sign-in fails with AADSTS500113

The VS Code client app is missing the `ms-appx-web://Microsoft.AAD.BrokerPlugin/<client-id>` redirect URI. See [docs/ENTRA-VSCODE-AUTH-APP-SETUP.md](docs/ENTRA-VSCODE-AUTH-APP-SETUP.md).

### Backend returns 401 after sign-in succeeds

The token's `aud` does not match what the backend expects. Check `junior.azureOpenAI.authScopes` (or `junior.copilotCli.providerAuthScopes`) against the audience APIM validates. The **Junior** output channel logs the resolved `aud` claim.

### Inline completions do not appear

- `junior.inlineCompletions.enabled` is `false`.
- The configured inline model does not exist on the endpoint.
- Requests are timing out — raise `junior.inlineCompletions.timeoutMs`.

### Copilot CLI option does not appear in the picker

`copilot` is not on `PATH`, `junior.copilotCli.path` is wrong, or no auth path is configured (no GitHub sign-in and no BYOK).

## More Documentation

Run **Junior: Open Documentation** from the Command Palette to browse the bundled guides directly inside VS Code. The same files live in [`docs/`](docs/) in the repo:

- [docs/APIM-FOUNDRY-KEY-SETUP.md](docs/APIM-FOUNDRY-KEY-SETUP.md) — APIM in front of Foundry, subscription-key auth (works for both Junior local and Copilot CLI).
- [docs/APIM-FOUNDRY-BEARER-SETUP.md](docs/APIM-FOUNDRY-BEARER-SETUP.md) — APIM in front of Foundry, Entra bearer auth with managed identity to the backend (works for both Junior local and Copilot CLI).
- [docs/ENTRA-VSCODE-AUTH-APP-SETUP.md](docs/ENTRA-VSCODE-AUTH-APP-SETUP.md) — Two-app Entra registration pattern for VS Code sign-in.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — Internal architecture overview.
- [docs/developer-getstarted.md](docs/developer-getstarted.md) — Building Junior from source.

## License

See the LICENSE file included with this extension for full terms.
