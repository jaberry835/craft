# Junior — Contributor Guide

This is the source-build / fork / contributor guide for Junior.

If you are installing a prebuilt `.vsix`, use [../README.md](../README.md). For a tour of the runtime architecture and module layout, see [ARCHITECTURE.md](ARCHITECTURE.md).

This document covers only what a contributor needs that those two don't:

- Building the VSIX
- Repo conventions
- How to add a tool, a middleware, or a context provider
- Test workflow
- Release / version-bump checklist

---

## Prerequisites

- Node.js 18+ (matches the VS Code 1.85 runtime)
- npm
- VS Code 1.85.0 or later
- PowerShell (the `deploy.ps1` script is PowerShell — Windows pwsh or PowerShell 7 on macOS/Linux both work)

No global tooling is required. `vsce` is invoked through `npx`.

## First-time setup

```powershell
git clone https://github.com/adamruderman/junior.git
cd junior
npm install
```

Then either:

- Press **F5** to launch the Extension Development Host with the extension loaded — best for iterating on code.
- Or run `.\deploy.ps1 install` to build a VSIX and install it into your real VS Code.

## Build, install, package

All maintainer workflows go through `deploy.ps1`:

```powershell
.\deploy.ps1 build       # type-check, esbuild bundle, package .vsix
.\deploy.ps1 install     # build + install into VS Code
.\deploy.ps1 uninstall   # remove from VS Code
.\deploy.ps1 reinstall   # uninstall, rebuild, reinstall
```

### Baking default settings into a VSIX

```powershell
.\deploy.ps1 build -DefaultSettings .\settings.default.json
```

`-DefaultSettings` accepts a flat JSON object of `junior.*` keys. During packaging it temporarily rewrites the `default` for matching settings in `package.json`, builds the VSIX, then restores the working tree. A `package.json.bak` is written next to `package.json` for the duration of the build; if a build is interrupted, restore it manually with `Move-Item -Force package.json.bak package.json`.

These are extension defaults only. They never overwrite a user's `settings.json` and any user/workspace value still wins.

### Direct npm scripts (used inside `deploy.ps1`)

```powershell
npm run compile      # tsc → out/, per-file output with source maps (dev)
npm run watch        # tsc watch mode (default VS Code build task)
npm run lint         # ESLint
npm test             # vitest (one-shot)
npm run test:watch   # vitest watch mode
npx tsc --noEmit     # type-check without emit
```

Production builds use `esbuild.mjs` to bundle into a single minified `out/extension.js`. The dev build (`npm run compile` / `watch`) uses `tsc` per-file output, which is what F5 launches.

## Repo layout

For the full architecture map, read [ARCHITECTURE.md](ARCHITECTURE.md). At a glance:

```
src/                  Extension source (TypeScript)
  framework/          IChatClient / IFunctionTool / IContextProvider abstractions
  middleware/         Concrete middleware (retry, recovery, autofix, …)
  tools/              Per-category tool handler modules (file, search, terminal, …)
test/                 vitest unit tests (no VS Code host needed)
test/__mocks__/       Minimal vscode API stub used by tests
media/                Webview assets (chat.js, codicons)
docs/                 This guide, ARCHITECTURE.md, APIM/Entra setup guides
samples/              Sample settings JSONs shipped in the VSIX
deploy.ps1            Build/install/package script
esbuild.mjs           Production bundler config
```

## Conventions

- **TypeScript only.** No runtime npm dependencies are bundled — code uses Node built-ins (`https`, `fs`, `child_process`, `crypto`) plus the VS Code API. The `@github/copilot-sdk` is the lone exception (it's bundled). Adding a new runtime dependency needs a justification.
- **Settings live in the `junior.*` namespace.** Read with `getSetting<T>(path)` from [../src/config.ts](../src/config.ts). It falls back to the legacy `securechat.*` namespace automatically — never read `vscode.workspace.getConfiguration()` directly elsewhere.
- **Secrets go through SecretStorage.** Use `context.secrets` (or the helpers in [../src/copilotCliSupport.ts](../src/copilotCliSupport.ts) / [../src/aoaiClient.ts](../src/aoaiClient.ts)). Don't write keys to settings.
- **Wire-format types** live in [../src/types.ts](../src/types.ts). Framework-level types live in [../src/framework/types.ts](../src/framework/types.ts) and are deliberately decoupled from the wire format.
- **Tool path validation.** Any tool that touches the filesystem must call `validatePath()` from [../src/tools/fileTools.ts](../src/tools/fileTools.ts). It rejects null bytes, UNC paths, and any path that resolves outside the workspace.
- **No emojis in code or docs** unless explicitly requested.

## Adding a tool

Builtin tools live in [../src/tools/](../src/tools) split by category (`fileTools.ts`, `searchTools.ts`, `terminalTools.ts`, `codeActionTools.ts`, `planTools.ts`). Each module exports a factory like `createFileTools(ctx, callbacks)` that returns `{ definitions, handlers }`.

To add a tool:

1. Pick the right category module (or add a new one and re-export it from [../src/tools/index.ts](../src/tools/index.ts)).
2. Add an entry to the `definitions` array — name, description, JSON Schema parameters, and `isReadOnly` / `requiresConfirmation` flags.
3. Add the handler to the `handlers` map. Read-only tools should return quickly and may run in parallel; write/terminal tools must respect `requiresConfirmation` and pass through the `BuiltinTools` permission/snapshot flow.
4. Tools are picked up automatically because `BuiltinTools` (in [../src/builtinTools.ts](../src/builtinTools.ts)) calls each factory in its constructor.
5. If the tool produces edits, use the `onFileTouched` callback so the inline diff/undo system tracks it.

The system prompt in [../src/agentPrompt.ts](../src/agentPrompt.ts) is the single source of truth for tool guidance — update it if a new tool changes behavior the model needs to know about.

## Adding middleware

Three middleware interfaces live in [../src/framework/middleware.ts](../src/framework/middleware.ts):

| Interface | Wraps | Concrete examples |
|-----------|-------|-------------------|
| `AgentMiddleware` | the entire agent run | `MemoryMiddleware`, `AutofixMiddleware` |
| `ChatMiddleware` | individual LLM API calls | `ContextTrimMiddleware`, `RecoveryMiddleware` |
| `FunctionMiddleware` | individual tool executions | `RetryMiddleware` |

Implement the relevant interface in a new file under [../src/middleware/](../src/middleware), re-export it from [../src/middleware/index.ts](../src/middleware/index.ts), and register it in the pipeline construction inside [../src/agentLoop.ts](../src/agentLoop.ts). Each middleware receives a typed context and a `next()`; you may pre-process, post-process, short-circuit, or call `next()` multiple times to retry.

## Adding a context provider

`IContextProvider` lives in [../src/framework/contextProvider.ts](../src/framework/contextProvider.ts). Implementations are registered in [../src/middleware/contextProviders.ts](../src/middleware/contextProviders.ts). `beforeRun()` returns system messages to inject; `afterRun()` is for bookkeeping (memory writes, learning).

## Tests

Tests use [Vitest](https://vitest.dev/) and live in [../test/](../test). They run against the framework, middleware, and runtime modules without a VS Code extension host — a minimal `vscode` stub is provided at [../test/__mocks__/vscode.ts](../test/__mocks__/vscode.ts).

```powershell
npm test                                  # one-shot
npm run test:watch                        # watch mode
npx vitest run --reporter verbose         # individual test names
npx vitest run test/retry-middleware      # filter by file
```

Current suites:

| Test file | What it covers |
|-----------|---------------|
| `aoai-client.test.ts` | `AzureOpenAIClient` request shape, auth modes, SSE parsing |
| `chat-client-middleware.test.ts` | `ChatClientWithMiddleware` `getResponse` / `getResponseStream` chaining |
| `chat-transcript.test.ts` | Persisted transcript schema versioning |
| `context-manager.test.ts` | Context window estimation and trimming |
| `copilot-cli-model-config.test.ts` | Copilot CLI model/provider config resolution |
| `copilot-cli-support.test.ts` | CLI executable detection, BYOK config, secret cache |
| `copilot-sdk-runtime.test.ts` | `CopilotSdkRuntime` event translation and session lifecycle |
| `error-formatting.test.ts` | User-facing Copilot CLI error mapping |
| `middleware-pipeline.test.ts` | `MiddlewarePipeline` ordering, short-circuit, retry, mutation |
| `permissions.test.ts` | Permission level gating for local + Copilot CLI categories |
| `recovery-middleware.test.ts` | 3-tier `process()` recovery + `processStream()` stall/overflow retry |
| `retry-middleware.test.ts` | Retry success/exclusion logic |

To add a test, drop a `test/*.test.ts` file — vitest picks it up automatically. Mock VS Code APIs by extending [../test/__mocks__/vscode.ts](../test/__mocks__/vscode.ts) rather than mocking inline.

## Debugging in the Extension Development Host

1. Open the repo in VS Code.
2. The default build task (`npm: watch`) starts `tsc --watch` automatically; if it isn't running, start it.
3. Press **F5** — VS Code launches a second window with the extension loaded.
4. The `Junior` output channel in the host window shows the extension's logs. Set `junior.copilotCli.logSdkEvents` to `true` for raw Copilot SDK event traces.
5. Set breakpoints in `src/*.ts` directly — the per-file build emits source maps.

## Release checklist

When cutting a new VSIX:

1. Bump `version` in [../package.json](../package.json).
2. Add an entry to [../CHANGELOG.md](../CHANGELOG.md) describing user-visible changes.
3. `npm test` — must be green.
4. `.\deploy.ps1 build` (optionally with `-DefaultSettings`) and verify the produced `junior-<version>.vsix`.
5. Smoke-test: install the VSIX into a clean VS Code profile, open the chat panel, send one prompt against your provider, and verify the inline-completion and Copilot CLI runtimes still light up if configured.
6. (Optional) Inspect the contents — extract the `.vsix` (it's a zip) into a scratch folder to confirm `samples/`, `docs/`, and `media/` shipped and `src/`, `test/`, `node_modules/` did not. The `tmp-vsix-inspect/` folder in the repo is a holdover from this workflow and can be deleted between releases.
7. Commit and tag.

## VSIX contents

`.vscodeignore` excludes `src/`, `test/`, `node_modules/` (except `@vscode/codicons/dist`), `*.vsix`, source maps, and declaration files. The bundled output is a single minified `out/extension.js` (~200 KB) plus webview assets in `media/`. The shipped VSIX also includes `samples/` and `docs/` — those are the files the **Junior: Open Sample Settings** and **Junior: Open Documentation** commands open.

## Where to look next

- [../README.md](../README.md) — user-facing setup, settings, providers, MCP, slash commands.
- [ARCHITECTURE.md](ARCHITECTURE.md) — agent loop, framework layer, middleware, runtimes, retrieval, UI.
- [APIM-COPILOT-CLI-BYOK-SETUP.md](APIM-COPILOT-CLI-BYOK-SETUP.md) — APIM in front of Foundry for the Copilot CLI BYOK runtime (key + bearer variants).
- [ENTRA-VSCODE-AUTH-APP-SETUP.md](ENTRA-VSCODE-AUTH-APP-SETUP.md) — two-app Entra registration pattern for VS Code auth sessions.
