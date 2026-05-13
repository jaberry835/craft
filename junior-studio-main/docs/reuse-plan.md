# Junior Reuse Plan

Source extension: `../SecureChatExtension` on branch `feature/junior-dev-team`.

## What We Can Reuse Directly

- Chat UI assets: `media/chat.js`, `media/icon.svg`, Codicons, and the webview message protocol types.
- Provider and model concepts: Azure OpenAI direct, APIM in front of Foundry, OpenAI-compatible APIs, reasoning settings, and deployment selection.
- Agent concepts: ask/agent/plan modes, permission levels, MCP server configuration, token tracking, session history, custom agents, and dev teams.
- Documentation and samples: APIM/Foundry setup docs, sample settings, and CA refresh script patterns.

## What Needs a Visual Studio Adapter

- `vscode.workspace` usage becomes Visual Studio workspace/solution APIs plus file-system fallbacks.
- `vscode.window` usage becomes Visual Studio tool windows, editor services, output panes, status bar, and dialogs.
- `vscode.commands` contributions become VSCT commands and package initialization.
- `vscode.SecretStorage` becomes Windows Credential Manager, DPAPI-protected storage, or Visual Studio service-backed secret storage.
- `vscode.authentication` becomes MSAL or Visual Studio account APIs for Entra bearer auth.
- VS Code webviews become a Visual Studio tool window hosting WebView2.
- Inline completions and inline diffs become editor adornments/async completion providers in Visual Studio.

## Suggested Migration Slices

1. Host shell: VSIX package, `View > Junior Chat`, settings page, and WebView2 host. Done for the first slice.
2. Shared protocol: copy or generate the webview message contract so the Visual Studio host can speak the same UI protocol as Junior. Started with `JuniorWebViewBridge`.
3. Provider core: extract AOAI/APIM/OpenAI request building and token tracking behind host-neutral settings and secret interfaces. Started with a minimal settings-backed chat-completions adapter.
4. Chat loop: port the agent runtime with host-neutral file, terminal, diagnostics, and workspace interfaces.
5. Workspace intelligence: port file indexing first, then symbol/semantic indexing where Visual Studio APIs add value.
6. Editor features: add selection explain/review/fix, inline diff review, then inline completions.

## Recommended Shared Boundary

Keep the Visual Studio package thin. Put host-neutral logic behind interfaces like:

- `IJuniorSettingsStore`
- `IJuniorSecretStore`
- `IJuniorWorkspace`
- `IJuniorEditorHost`
- `IJuniorTerminalHost`
- `IJuniorAuthProvider`
- `IJuniorChatTransport`

The VS Code extension can keep its current behavior while gradually moving reusable logic into shared modules. The Visual Studio extension implements the same interfaces with Visual Studio services.