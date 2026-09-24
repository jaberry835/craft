---
name: Capture web evidence
description: Launch Microsoft Edge for interactive authentication, navigate to a web address, and save screenshot evidence with provenance metadata.
argument-hint: <http-or-https-url> [project-relative-output.png]
---

# Capture web evidence

Use the `browser_capture` tool for every browser operation.

1. Call `browser_capture` with `action: "status"`.
2. If no session is active, call it with `action: "launch"` and `headless: false`. Visible Edge is the default because the user may need to authenticate.
3. Tell the user to complete authentication in Edge when needed. Do not request or store their credentials.
4. Call `browser_capture` with `action: "navigate"` and the requested absolute HTTP or HTTPS URL.
5. Call `browser_capture` with `action: "capture"`. Prefer a descriptive path under `evidence/screenshots/`.
6. Report both the PNG and adjacent JSON provenance file.

Use `headless: true` only when the user explicitly requests it or the target does not require interactive authentication. Close the session only when the user asks or the workflow no longer needs its authenticated state.
