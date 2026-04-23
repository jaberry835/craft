# Changelog

## 1.1.6 — 2026-04-14

### Codebase Refactoring

- **Split builtinTools.ts into focused tool modules** — the 1,857-line monolith is now a 548-line shell delegating to five category files under `src/tools/`: fileTools, searchTools, terminalTools, codeActionTools, and planTools. Adding a new tool means editing the relevant category file, not a single mega-file.
- **Extracted ProviderRouter from chatViewProvider** — model configuration, provider switching, and CLI availability checking are now in a dedicated `providerRouter.ts` module (144 lines), keeping provider logic out of the 3,000+ line webview provider.
- **Extracted session restore logic from chatViewProvider** — the 300+ line transcript replay and tool-description helpers are now in `sessionRestore.ts`, reducing chatViewProvider and making restore behavior independently testable.

### Workspace Indexing Performance

- **Phased startup indexing** — file indexing (fast, stat-only with disk cache) now completes first and makes the agent usable immediately. Symbol and semantic indexing run in the background afterward, so users can start chatting without waiting.
- **Added disk caching to SymbolIndexer** — symbol data is now persisted to `symbolIndex.json` and only files that changed since the last activation are re-indexed via `executeDocumentSymbolProvider`. Previously every file was re-indexed on every reload.
- **Batched stat() calls in WorkspaceIndexer** — file metadata is now fetched 20 at a time via `Promise.allSettled` instead of one-by-one awaits, cutting file indexing time significantly on large workspaces.
- **Batched file reads in SemanticIndexer** — changed files are read 10 at a time concurrently instead of serially.
- **Raised findFiles limit from 10,000 to 50,000** — large monorepos no longer silently lose files from the index.

### Copilot CLI Integration

- **CLI thinking text now renders inside working blocks** — reasoning/thinking output from the Copilot CLI is now shown as progress entries inside the collapsible working block (GHCP-style), instead of as large standalone narration bubbles that dominated the chat view.
- **Switched to `customize` mode for CLI system prompt** — uses the SDK's fine-grained `systemMessage.sections` API to surgically set identity, tone, and guidelines while preserving the CLI's built-in tool instructions, safety rules, and other prompt sections.

### Authentication

- **Added VS Code auth-session support for Copilot CLI BYOK bearer mode** — Junior can now acquire Copilot CLI bearer credentials from a VS Code authentication provider session instead of requiring a pasted bearer token in settings.
- **Added local Azure OpenAI and APIM bearer auth modes** — direct Azure and APIM-backed local agent mode can now use either `api-key`, a manually supplied bearer token, or a VS Code authentication session.
- **Added sign-in commands for bearer flows** — new commands trigger interactive sign-in for both local Azure/APIM bearer mode and Copilot CLI bearer mode.
- **Improved auth diagnostics** — the `Junior` output channel now logs the resolved local auth mode and safe bearer-token claims such as `aud` and `scp` without printing secrets.

### Documentation

- **Updated setup guides for bearer auth** — the README and developer guide now document the new local Azure/APIM bearer settings, Copilot CLI bearer settings, sign-in commands, and token-refresh behavior.

## 1.1.3— 2026-03-31

### UI

- **Improved model-selector dropdown readability** — increased font size, added proper background/foreground theming via VS Code dropdown variables, widened the max-width to reduce truncation, and styled the option list for better contrast. Dropdown items now show both the display name and deployment ID when they differ, with a tooltip for the full label.
- **Added welcome splash screen** — first-time users now see a Matrix-style code rain splash screen (in Microsoft brand colors) with quick-access buttons for configuring settings and setting the API key. Includes a "Start Coding" dismissal link and an opt-in checkbox to show the screen on every launch. Reopenable anytime via **Junior: Show Welcome Screen** in the command palette.

## 1.1.1 — 2026-03-27

### Agent Mode Improvements

- **Improved agent autonomy during issue investigation** — Junior now does a better job of gathering likely context before asking the user to point it at files. The agent can use active editor context, diagnostics, semantic retrieval, symbol matches, and ranked likely files to orient itself earlier in a run.
- **Added structured working memory for the current task** — the agent now keeps a compact in-run memory of the objective, relevant files, findings, diagnostics, and failed attempts so it is less likely to rediscover the same context repeatedly.
- **Added lightweight repo-scoped learned memory** — Junior can now retain a small amount of repository-specific signal across tasks, such as commonly relevant files and previously successful validation commands, while keeping the prompt injection conservative.
- **Reduced prompt bloat from memory injection** — task and repo memory are now injected more selectively so later iterations stay lighter on token usage, which helps on lower-capacity development endpoints.
- **Improved retrieval prioritization** — likely files are now ranked using a combination of diagnostics, semantic matches, symbol matches, active file bias, and explicit user mentions instead of relying on a single heuristic.

### UI

- **Updated the running-agent stop icon** — the animated processing/stop button now shows an agent-style mark inside the circle instead of the previous generic stop glyph, while keeping the existing ring animation and cancel behavior.

### MCP Compatibility

- **Fixed stdio MCP transport for current Node MCP servers** — Junior now speaks newline-delimited JSON over stdio, which matches the current MCP Node SDK transport instead of the older `Content-Length` framing.
- **Kept backward-compatible stdio parsing** — the MCP client still accepts legacy `Content-Length` framed responses while also handling newline-delimited JSON-RPC messages.
- **Improved Windows stdio server startup** — local MCP servers launched through commands like `npx` now connect correctly on Windows, including reference servers such as `@modelcontextprotocol/server-everything`.
- **GitHub remote MCP can reuse a VS Code GitHub login** — HTTP MCP servers can now populate bearer auth from a VS Code authentication provider session, and GitHub's hosted MCP endpoint is auto-detected when no explicit `Authorization` header is configured.
- **HTTP MCP auth now retries on OAuth challenges** — when an HTTP MCP server returns `401` with `WWW-Authenticate`, Junior can retry once using a configured or inferred VS Code auth provider session, making the flow more general than the GitHub-only happy path.

### Documentation

- **Added a concrete stdio MCP example to the README** — the setup docs now include a ready-to-copy `server-everything` configuration for quickly validating MCP connectivity.
- **Documented MCP reconnect workflow** — the README now points users to **Junior: Manage MCP Servers** to reconnect configured servers after changing settings.

### Build & Distribution

- **Build-time default settings override for VSIX packaging** — `deploy.ps1` now supports `-DefaultSettings` to supply a JSON file of `junior.*` values that temporarily override contributed setting defaults in `package.json` during packaging.
- **Packaged defaults stay safe by default** — baked-in values ship as extension defaults inside the VSIX rather than rewriting a user's `settings.json`. Experienced users can still override any `junior.*` setting in user/workspace settings, including MCP-related settings such as `junior.mcp.servers`.
- **Clearer build guidance** — the deploy script and README now explicitly warn that non-`junior.*` settings are ignored by this feature and that existing user/workspace settings take precedence over packaged defaults.


## 1.1.0 — 2026-03-25

### UI Polish & Streaming

- **Fixed "Created with X" bug** — failed tool calls (e.g. `write_file`, `edit_file`) now display "Failed: Created file.py" / "Failed: Edited file.py" instead of misleadingly showing the success label with an error icon.
- **Smoother final response rendering** — the assistant's final text response now animates in at a readable pace instead of appearing instantly. Uses an adaptive drain rate (faster for large responses, slower for short ones).
- **Debounced scroll-to-bottom** — multiple rapid webview messages no longer trigger redundant DOM reflows; scroll calls are coalesced within the same animation frame.
- **Working block summaries exclude failures** — collapsed progress cards no longer count failed tool calls in their summary (e.g. "Created 5 files" won't include files that failed to create).

### Reliability

- **`edit_file` now handles CRLF/LF mismatch automatically** — files with Windows line endings (`\r\n`) no longer fail when the model sends `\n`. The handler auto-converts and preserves the file's line-ending style in the replacement.
- **Write tools no longer auto-retry** — `write_file`, `replace_lines`, and `delete_file` added to the no-retry set. These were silently retrying after 600ms on failure, adding dead latency (the retry would also fail since path validation errors don't self-heal).
- **File change diff stats only shown on writes** — `fileChangeTick` no longer stamps `+N -M` diff counts on read-only entries that happen to share the same file path.

### Token Tracking & Context

- **Token ring reflects actual context usage** — the status bar ring meter and webview badge now show the current context window fill level (not cumulative session tokens). After context compaction trims older messages, the ring drops accordingly. Tooltip shows both context size and total usage.
- **"Compacting conversation…" status message** — when the context manager trims the conversation to stay within the model's context window, a visible status message appears in the chat (similar to GitHub Copilot). Also logged to the Output channel.

### Diagnostics

- **Agent loop errors now logged to Output channel** — errors were previously only shown in the chat UI (easy to miss). Key failures are now logged to the "Junior" Output panel:
  - Agent loop crashes (with stack trace)
  - Non-recoverable API/streaming errors
  - Context recovery attempts (prompt too large)
  - Unknown tool calls (model hallucinated a tool name)
- **Session clear cancels pending drain** — switching sessions while text is still animating no longer causes ghost renders.

### Composer Toolbar Redesign (GHCP-style)

- **Redesigned input toolbar** — the composer toolbar below the text input now matches GitHub Copilot's layout and styling:
  - **`+` attach button** — replaces the old paperclip icon with a clean codicon plus sign
  - **Agent mode label** — `◈ Agent` indicator shown next to the model selector
  - **Model selector** — unchanged, sits between the Agent label and tools
  - **MCP Tools button** — new dual-slider icon (matching GHCP's configure/tools icon) opens the Manage MCP Servers dialog; moved from the view title bar into the composer
  - **Send / Stop button** — an `↑` arrow on the right sends the message; while the agent is running it morphs into a circular stop button with a spinning ring animation
- **Decluttered top bar** — removed the Stop Agent and Manage MCP Servers buttons from the sidebar title bar (both now live in the composer toolbar)
- **Consistent button styling** — all composer toolbar buttons share a uniform transparent style with subtle rounded hover highlights
