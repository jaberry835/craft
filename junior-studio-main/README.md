# Junior Studio

Junior Studio is the Visual Studio extension host for Junior, the air-gapped AI coding assistant currently implemented as a VS Code extension in `../SecureChatExtension`.

The first milestone is intentionally small: a Visual Studio VSIX with a `View > Junior Chat` tool window. The implementation is structured so the next slices can reuse Junior's existing chat UI, provider configuration, Azure OpenAI / Foundry client, agent loop, and workspace tooling behind Visual Studio-specific adapters.

## Prerequisites

Junior Studio is split into two projects with different runtimes — both must be installed.

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
- An **OpenAI-compatible** endpoint (`/openai/v1` or `/v1`) and bearer token.

These are configured under `Tools > Options > Junior Studio`.

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

1. Open `Tools > Options > Junior Studio` in Visual Studio.
2. Set the provider, endpoint/base URL, API key, active deployment, and (optionally) approval policies.
3. Open `View > Junior Chat` and send a message.

If the provider is not configured, the tool window falls back to an explanatory local response so the UI remains testable.

## Troubleshooting Command Visibility

If the extension appears in `Tools > Options > Junior Studio` but `Junior Chat` is missing from the menu, install the latest VSIX and refresh Visual Studio's command cache:

```powershell
& "C:\Program Files\Microsoft Visual Studio\2022\Enterprise\Common7\IDE\devenv.exe" /updateconfiguration
& "C:\Program Files\Microsoft Visual Studio\2022\Enterprise\Common7\IDE\devenv.exe" /clearcache
```

The package registers `Menus.ctmenu`; registering the intermediate `.cto` file causes Visual Studio to log `Resource not found` and skip command registration.

## Source Reuse Plan

See [docs/reuse-plan.md](docs/reuse-plan.md) for the migration map from the VS Code Junior extension into this Visual Studio host.