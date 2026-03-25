# Changelog

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