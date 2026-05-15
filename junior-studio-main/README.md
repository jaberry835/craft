# Junior

Junior is the air-gapped AI coding assistant. This repository is the Visual Studio extension host for Junior; `junior-studio` remains the internal repo and project name.

The first milestone is intentionally small: a Visual Studio VSIX with a `View > Junior Chat` tool window. The implementation is structured so the next slices can reuse Junior's existing chat UI, provider configuration, Azure OpenAI / Foundry client, agent loop, and workspace tooling behind Visual Studio-specific adapters.

## Prerequisites

The Visual Studio host is split into two projects with different runtimes — both must be installed.

### Tooling

- **Windows 10/11 x64** (the agent sidecar is built `win-x64`).
- **Visual Studio 2022 (17.x)**, any edition, with the following workloads:
  - **Visual Studio extension development** (provides the VSSDK that `JuniorStudio.VisualStudio` builds against).
  - **.NET desktop development** (for .NET Framework 4.7.2 build tools).
- **.NET Framework 4.7.2 Developer Pack** — installed automatically by the workloads above. Targeted by the VSIX.
- **.NET 8 SDK** — required to build and `dotnet publish` the agent sidecar. Download: <https://dotnet.microsoft.com/download/dotnet/8.0>.
- **Microsoft Edge WebView2 Runtime** — ships with Windows 11 and recent VS 2022 installs. The chat surface is hosted in WebView2 (`Microsoft.Web.WebView2` 1.0.3405.78).

### Target framework matrix

| Project | TFM | Output | Notes |
|---|---|---|---|
| `src/JuniorStudio.VisualStudio` | `net472` | VSIX (`JuniorStudio.VisualStudio.vsix`) | VS 2022 in-process extension; uses VSSDK 17.0 + WebView2. |
| `src/JuniorStudio.Agent` | `net8.0` (`win-x64`, framework-dependent) | Console exe (`JuniorStudio.Agent.exe`) | Sidecar process launched from the VSIX over stdio. Runs on the .NET 8 runtime; `RollForward=LatestMajor` allows newer runtimes. |

### NuGet packages

`JuniorStudio.VisualStudio` (.NET Framework 4.7.2):

- `Microsoft.VisualStudio.SDK` 17.0.32112.339
- `Microsoft.VSSDK.BuildTools` 17.14.2094
- `Microsoft.Web.WebView2` 1.0.3405.78

`JuniorStudio.Agent` (.NET 8):

- `Microsoft.Agents.AI` 1.5.0 — Microsoft Agent Framework, agent loop + streaming
- `Microsoft.Agents.AI.OpenAI` 1.5.0 — OpenAI/Azure OpenAI bindings for the agent framework
- `Azure.AI.OpenAI` 2.5.0-beta.1 — Azure OpenAI client (Responses API)
- `Azure.Identity` 1.13.1 — token-credential auth (used for non-key flows)

These transitively pull in `Microsoft.Extensions.AI`, `OpenAI`, `System.ClientModel`, and related core packages — a normal `dotnet restore` resolves everything.

### Provider / runtime requirements

To actually talk to a model you need one of:

- **Azure OpenAI / Microsoft Foundry** deployment + endpoint + API key.
- **Azure API Management** in front of Foundry, with a subscription key.
- **Azure API Management** in front of Foundry with Microsoft Entra ID bearer auth.
- An **OpenAI-compatible** endpoint (`/openai/v1` or `/v1`) and bearer token.

These are configured under `Tools > Options > Junior`.

### Secure API key storage

For `ApiKey` authentication, prefer storing Azure OpenAI or APIM keys in Windows Credential Manager from the Junior Chat welcome screen. Click **Set API key securely** and paste the key into the native password prompt. Junior writes the secret as a Windows Generic Credential and stores only a `cred:` reference in Visual Studio options, for example:

```text
cred:JuniorStudio/Apim/my-deployment/ApiKey
```

At runtime the Visual Studio host resolves that reference in memory before configuring the sidecar. The real key is not written to the VS options store or the chat transcript. The welcome screen also includes **Open Junior options** for jumping directly to the extension's options page.

### Entra ID / bearer authentication

`Tools > Options > Junior > Authentication` supports three modes:

- `ApiKey`: existing Azure OpenAI key or APIM subscription-key behavior.
- `BearerToken`: sends the configured raw bearer token as `Authorization: Bearer ...`.
- `EntraId`: uses `Azure.Identity` in the sidecar to acquire a bearer token for each request. For APIM, set **Entra ID Scopes** to the audience APIM validates, for example `api://<apim-app-client-id>/user_impersonation`. VS Code-style helper entries such as `VSCODE_CLIENT_ID:<client-id>` and `VSCODE_TENANT:<tenant-id>` are accepted and used as the interactive client and tenant hints.

For commercial Azure, leave **Azure Cloud** as `Commercial`. For Azure Government or China, select the matching cloud. For sovereign or air-gapped clouds, select `Custom` and set **Authority Host** to the login endpoint, for example `https://login.microsoftonline.us/`.

For `Direct` + `EntraId`, Junior sets the Azure OpenAI token audience from **Azure Cloud** by default:

- `Commercial`: `https://cognitiveservices.azure.com/.default`
- `Government`: `https://cognitiveservices.azure.us/.default`
- `China`: `https://cognitiveservices.azure.cn/.default`

Set **Direct Azure OpenAI Audience** when a sovereign cloud needs a custom Cognitive Services or Foundry audience.

Recommended configurations:

#### APIM in front of Foundry, Entra bearer

- **Provider**: `Apim`
- **APIM Base URL**: gateway host root, for example `https://<apim-name>.azure-api.net`
- **Authentication Mode**: `EntraId`
- **Entra ID Scopes**: APIM app audience scope, for example `api://<apim-app-client-id>/user_impersonation`
- **Entra Client ID**: public client app used for interactive sign-in
- **Entra Tenant ID**: tenant APIM validates

APIM should validate the inbound user token with an audience that matches the scope without `/user_impersonation`:

```xml
<validate-azure-ad-token tenant-id="<tenant-id>" header-name="Authorization" failed-validation-httpcode="401" failed-validation-error-message="Unauthorized">
  <audiences>
    <audience>api://<apim-app-client-id></audience>
  </audiences>
</validate-azure-ad-token>
```

#### Direct Azure OpenAI / Foundry, Entra bearer

- **Provider**: `Direct`
- **Endpoint**: resource endpoint, for example `https://<resource>.cognitiveservices.azure.com`
- **Authentication Mode**: `EntraId`
- **Direct Azure OpenAI Audience**: leave blank for the selected Azure cloud default, or set a custom sovereign audience
- **Entra ID Scopes**: not required for Direct mode; the direct audience is used instead
- **Entra Client ID**: leave blank to use the default interactive client, or use a client app that has permission to request Cognitive Services tokens

For Direct mode, the signed-in user must have data-plane access on the Azure OpenAI / Foundry resource, such as **Cognitive Services OpenAI User**. If Entra returns `AADSTS650057: Invalid resource`, the configured client app is not allowed to request the Cognitive Services audience; clear **Entra Client ID** or use a client app registration with the right delegated permissions/admin consent.

For Responses API calls, APIM bearer and Direct bearer paths use the OpenAI-compatible route shape `.../openai/v1/responses`, matching the VS Code Junior implementation.

Authentication and HTTP diagnostics are written to `%LOCALAPPDATA%\JuniorStudio\sidecar.log`. Entra failures include non-secret token claims such as `aud`, `iss`, `tid`, client id, and scopes to help troubleshoot APIM policies.

### MCP tools

`Tools > Options > Junior > MCP` can expose Model Context Protocol tools to Agent mode. Turn on **Enable MCP Servers** and paste a JSON object into **MCP Servers JSON**. Use the `...` button in the property grid to open the multiline editor. The sidecar accepts JSONC-style comments and trailing commas so blocks copied from VS Code settings work naturally. The Visual Studio sidecar supports the same core shapes as the VS Code Junior settings: stdio servers with `command`/`args`/`env`/`cwd`, and HTTP streamable servers with `url`, `headers`, and optional Entra `authSession`.

Example stdio server:

```json
{
  "everything": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-everything"]
  }
}
```

Example HTTP server with Entra bearer auth:

```json
{
  "rude-local": {
    "url": "http://localhost:8000/mcp",
    "authSession": {
      "providerId": "microsoft-sovereign-cloud",
      "scopes": [
        "VSCODE_TENANT:<tenant-id>",
        "api://<mcp-app-client-id>/MCPaccess"
      ],
      "tokenHeader": "Authorization",
      "tokenScheme": "Bearer",
      "createIfNone": true
    }
  }
}
```

MCP HTTP calls send `Accept: application/json, text/event-stream`, preserve `Mcp-Session-Id`, and parse JSON-RPC responses from plain JSON or server-sent events. Entra MCP auth uses the Junior Azure cloud/authority settings plus any `VSCODE_TENANT:<tenant-id>` and `VSCODE_CLIENT_ID:<client-id>` entries from the server's `authSession.scopes`.

After MCP is configured, click the MCP tools button in the chat composer to discover available tools. The picker shows each tool name and a short description with checkboxes for choosing which tools are exposed to Agent mode. These selections are runtime/session state; they do not rewrite **MCP Servers JSON**. The next Agent turn rebuilds its tool list from the checked MCP tools.

### Editor selection actions

Junior adds Visual Studio commands for the active editor selection:

- **Junior: Explain Selection**
- **Junior: Review Selection**
- **Junior: Fix Selection**
- **Junior: Preview Fix as Diff**
- **Junior: Complete Inline**

Select code in the editor, then run one of the selection commands from **Tools** or the editor context menu. Junior opens the chat tool window and submits the selected code with file path and line-range context. The fix command asks Agent mode to apply changes through the workspace tools when it is confident.

**Junior: Preview Fix as Diff** asks the configured model for a replacement for the selected code, writes the original and proposed replacement to temporary files, and opens Visual Studio's diff viewer. **Junior: Complete Inline** uses the text around the caret to generate a continuation and inserts the returned text at the caret.

Junior also registers an editor ghost-text layer. After you pause briefly while typing in a text editor, Junior asks the configured model for a short continuation and renders the first line as gray inline text at the caret. Run **Junior: Accept Inline Suggestion** from **Tools** or the editor context menu to insert the visible suggestion. The ghost suggestion path uses the same provider, deployment, and authentication settings as chat.

### Authentication reuse

Junior avoids re-authenticating when settings have not changed. Chat, MCP, selection commands, diff preview, manual completion, and ghost text all share one sidecar process for the Visual Studio session, so they reuse the same in-memory model client, credential chain, and MCP connections. The Visual Studio host skips duplicate sidecar `configure` messages, the sidecar reuses its existing model client and credential chain for identical configuration, and MCP keeps existing server connections when MCP settings are unchanged. Entra browser login also uses a persistent `JuniorStudio` token cache where the Azure Identity SDK supports it.

Expected behavior: the first explicit request for a tenant/client/scope may open a browser, and changing provider, scopes, tenant, cloud, deployment, endpoint, workspace, or MCP server JSON may rebuild auth state. Repeated chat turns, MCP tool discovery, editor commands, and ghost-text suggestions with unchanged settings should not prompt again during the same Visual Studio session. Automatic ghost text will not initiate the first browser login by itself; open chat or run an explicit editor command first to warm the shared sidecar. Check `%LOCALAPPDATA%\JuniorStudio\sidecar.log` for `CONFIG`, `AUTH`, and `MCP` reuse messages.

### Agent reliability layer

Junior includes reliability-focused workspace tools for Agent mode:

- `SearchRelevantFiles` scores filenames, lightweight file content, active diagnostics, files changed this session, and C# symbol matches against the current task so the agent can find likely files before broad reading. Results include match reasons.
- `GetDiagnostics` exposes the latest Visual Studio Error List snapshot to Agent and Plan mode so Junior can reason over current compiler/analyzer diagnostics before editing.
- `GetRepoInstructions` shows the active repository instruction file and any lower-precedence instruction files Junior detected.
- `ApplyPatch` applies multiple exact-text replacements to one file atomically; every hunk must match before anything is written, so multi-location edits do not leave partial changes behind.
- `ReplaceText` and `ReplaceLines` provide surgical edits that fail when expected context does not match, reducing accidental full-file rewrites.
- `ValidateWorkspace` runs an auto-detected validation command such as `dotnet build` or an explicit build/test command and returns diagnostics for follow-up fixes. After Agent mode edits files, Junior also runs the detected validation command automatically when one is available.

When write/delete approvals are set to `Confirm`, Junior shows a colored, scrollable unified diff preview before file mutations from `WriteFile`, `CreateFile`, `ApplyPatch`, `ReplaceText`, `ReplaceLines`, or `DeleteFile` are applied. Each agent turn also injects a capped workspace tree, likely relevant files, Visual Studio diagnostics, and repository guidance from `.junior/instructions.md`, `.github/copilot-instructions.md`, or `AGENTS.md` when present. When repo guidance is active, Junior shows a small chat notice with the winning instruction file, lower-precedence files that were also detected, and whether the active file was truncated for context. Error List diagnostics are refreshed through a diagnostics-only sidecar message before agent sends and periodically while the chat tool window is open, so Error List changes do not force a full model reconfiguration. The sidecar trims retained chat history to the most recent turns so long sessions are less likely to overflow model context. After each Agent-mode turn, Junior shows a turn summary with changed files, tools used, validation status, context included in the turn, retained/trimmed history counts, and whether the turn was an automatic repair. If automatic validation fails, Junior captures the build/test output into the conversation with a prioritized Repair targets list built from Visual Studio diagnostics and parsed validation output. **Automatic Repair Attempts** under `Tools > Options > Junior > Agent Reliability` controls how many validation-failure repair turns Junior may start on its own before asking you to continue; approval settings still apply and repeated identical failures stop the automatic loop. When validation repair spans multiple turns, Junior shows a repair chain summary with all changed files, automatic attempts used, final validation status, and stop reason.

## Build

Restore + build everything (sidecar then VSIX) from the repo root:

```powershell
# 1. Build/publish the .NET 8 sidecar into the VSIX content folder
dotnet publish src\JuniorStudio.Agent\JuniorStudio.Agent.csproj `
    -c Debug -r win-x64 --no-self-contained `
    -o src\JuniorStudio.VisualStudio\Assets\Agent

# 2. Build the .NET Framework 4.7.2 VSIX
& "C:\Program Files\Microsoft Visual Studio\2022\Enterprise\MSBuild\Current\Bin\MSBuild.exe" `
    src\JuniorStudio.VisualStudio\JuniorStudio.VisualStudio.csproj `
    /t:Rebuild /p:Configuration=Debug /p:DeployExtension=False /m /nologo /v:minimal
```

The VSIX is produced at `src\JuniorStudio.VisualStudio\bin\Debug\JuniorStudio.VisualStudio.vsix` (~14 MB, includes the published sidecar). Double-click to install, or use VSIXInstaller.

You can also open `JuniorStudio.sln` in Visual Studio 2022 and build normally; the VSIX project's pre-build step shells out to `dotnet publish` for the sidecar automatically.

## First Live Provider Path

The chat tool window can already make a basic chat-completions call when configured:

1. Open `Tools > Options > Junior` in Visual Studio.
2. Set the provider, endpoint/base URL, active deployment, and (optionally) approval policies. For API key auth, use **Set API key securely** in the Junior Chat welcome screen so the key is stored in Windows Credential Manager.
3. Open `View > Junior Chat` and send a message.

If the provider is not configured, the tool window falls back to an explanatory local response so the UI remains testable.

## Troubleshooting Command Visibility

If the extension appears in `Tools > Options > Junior` but `Junior Chat` is missing from the menu, install the latest VSIX and refresh Visual Studio's command cache:

```powershell
& "C:\Program Files\Microsoft Visual Studio\2022\Enterprise\Common7\IDE\devenv.exe" /updateconfiguration
& "C:\Program Files\Microsoft Visual Studio\2022\Enterprise\Common7\IDE\devenv.exe" /clearcache
```

The package registers `Menus.ctmenu`; registering the intermediate `.cto` file causes Visual Studio to log `Resource not found` and skip command registration.

## Source Reuse Plan

See [docs/reuse-plan.md](docs/reuse-plan.md) for the migration map from the VS Code Junior extension into this Visual Studio host.