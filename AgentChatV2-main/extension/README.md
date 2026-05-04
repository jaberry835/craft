# Security Package Assist — Browser Extension

A Manifest V3 (Edge / Chrome) side-panel extension that uses the AgentChatV2
backend to help a user complete a third-party Security Package wizard. It
runs alongside the wizard, reads its visible form fields, and calls the same
orchestrator agent the chat UI uses — exposed through new additive
`/api/assist/*` endpoints. The existing chat UI and admin agents are
unchanged.

What you get in the side panel:

- **Explain page** — plain-language summary of the current wizard step.
- **Suggest field** — recommended value with confidence pill and citation
  chips inline in the chat bubble, plus a one-click "Insert into form"
  button.
- **Generate preview** — produces JSON and a rendered HTML preview of the
  full package built from every field collected across all wizard steps.
  Triggered from the Preview tab's empty-state button (and a Regenerate
  button once an artifact exists).
- **Deploy** — publishes the approved HTML preview to the static site
  through an in-panel modal (project name, display name, owner,
  description). Result appears as a banner in the Preview tab with the
  live URL.
- **Free-form chat** with optional "Include current page context".
- **Cross-step memory with passive auto-capture** — once the content
  script is injected (one click on any action), every field the user
  edits, every wizard step they navigate to, and every SPA re-render is
  silently captured and merged into the wizard accumulator. The footer
  shows a live `N fields · M step(s)` counter.

---

## 1. Prerequisites

- Edge or Chrome 116+
- AgentChatV2 backend running and reachable (locally `http://127.0.0.1:5000`,
  or your deployed URL).
- An **Entra app registration** the backend already trusts. You will need:
  - **Tenant id**
  - **Client (application) id**
  - The API scope the backend validates, e.g. `api://<client-id>/MCPaccess`
  - **Authority** — `https://login.microsoftonline.com` for public cloud
    or `https://login.microsoftonline.us` for Azure Government.
- The **agent id** of the Security Package orchestrator agent that uses the
  prompt at `backend/prompts/security_package_extension_assistant.txt`.
  (You can also list agents from inside the extension's Options page — see
  step 5.)

---

## 2. Pin a stable extension ID

By default Edge / Chrome derives the extension id from a random key created
the first time the unpacked folder is loaded. Every reinstall produces a
new id, which breaks the OAuth redirect URI you register in Entra.

Generate a key once and pin it into `manifest.json`:

```powershell
cd extension
.\generate-extension-id.ps1 -PatchManifest
```

What the script does:

1. Creates `extension-key.pem` **outside** the extension folder
   (`..\extension-key.pem` at repo root) so Edge does not warn about a
   private key inside a loaded extension.
2. Derives the extension id (16-byte SHA-256 of the SPKI DER, mapped to
   a–p) and prints it.
3. Writes the public-key SPKI base64 into the `key` field of
   `manifest.json`. From now on, the extension id is **the same on every
   machine** that loads this folder.

**Keep `extension-key.pem` private.** It is gitignored. You only need it
again if you ever need to publish a `.crx` signed with the same id.

For the rest of this README we will refer to the resulting id as
`<EXTENSION_ID>`.

---

## 3. Load the unpacked extension

1. Open `edge://extensions` (or `chrome://extensions`).
2. Enable **Developer mode**.
3. Click **Load unpacked** and pick the `extension/` folder.
4. Confirm the id matches `<EXTENSION_ID>` from step 2.
5. Pin the extension to the toolbar.

---

## 4. Register the OAuth redirect URI in Entra

The extension uses `chrome.identity.launchWebAuthFlow`, which forces the
redirect to:

```
https://<EXTENSION_ID>.chromiumapp.org/oauth2
```

In the Entra portal for your app registration:

1. **Authentication → Add a platform → Single-page application (SPA)**.
2. Add the redirect URI above. SPA platform is required for PKCE without a
   client secret.
3. **API permissions** must already include the scope you'll request
   (e.g. `api://<client-id>/MCPaccess`) and that scope must be
   admin-consented for your tenant.

If you're on Azure Government, set the **Authority** in step 5 below to
`https://login.microsoftonline.us`.

---

## 5. Configure the extension

Click the extension icon → **Options** (or right-click → Options). Fill in:

| Field                  | Example                                                       |
| ---------------------- | ------------------------------------------------------------- |
| Backend URL            | `http://127.0.0.1:5000` (local) or your deployed URL          |
| Tenant id              | `03f141f3-...`                                                |
| Client id              | `6349498a-...`                                                |
| API scope              | `api://6349498a-.../MCPaccess`                                |
| Authority              | `https://login.microsoftonline.com` or `...microsoftonline.us`|
| Agent id               | (leave empty, then click **Load agents** below)               |
| Dev token (optional)   | Paste a bearer token to skip OAuth during local testing.      |
| Show developer views   | Off by default. Reveals the *Page* / *Wizard* source toggles in the Preview and JSON tabs (debugging the field extractor). |

Click **Save**, then **Load agents**. The dropdown populates from
`GET /api/chat/agents`. Pick the Security Package extension assistant agent
(the one configured to use
`backend/prompts/security_package_extension_assistant.txt`). Save again.

---

## 6. Trust the extension origin in the backend

Add the extension's origin to the backend CORS allow-list so the side panel
can call `/api/assist/*`:

```
chrome-extension://<EXTENSION_ID>
```

Where to add it depends on your backend deployment. For local dev, append
it to whatever CORS list `backend/main.py` configures.

---

## 7. Try it

1. Start the backend:
   ```powershell
   cd backend
   python -m uvicorn main:app --reload --port 5000
   ```
2. (If your agent uses MCP tools) start the MCP server it points at, e.g.
   `http://localhost:8000/mcp`.
3. Open the test wizard in a browser tab:
   `extension/test/mock-wizard.html` (drag-drop into a tab works) or any
   real wizard you have access to.
4. Open the side panel from the extension icon.
5. First action will trigger the OAuth popup. Sign in. Token is cached for
   the session.
6. Click **Explain page** once on step 1 — this injects the content script
   and unlocks passive auto-capture. From here on you can fill out fields
   and click **Next** between steps; the side panel's footer counter will
   update on its own as fields and steps accumulate.
7. On any step (typically the last), switch to the **Preview** tab and
   click **Generate preview**. You should see:
   - A rendered HTML preview built from every field across every step.
   - The structured package in the **JSON** tab.
   - The footer counter showing the totals, e.g. `18 fields · 4 step(s)`.
8. When you're happy, click **Deploy**. The modal pre-fills from the
   wizard data — adjust the project slug if needed and confirm. A success
   banner with the live URL replaces the preview iframe.

---

## 8. Files in this folder

| File                       | Purpose                                                              |
| -------------------------- | -------------------------------------------------------------------- |
| `manifest.json`            | MV3 manifest. Holds pinned `key` and host permissions.               |
| `background.js`            | Service worker: PKCE auth, token cache, `/api/assist/*` calls.       |
| `content_script.js`        | Programmatically injected; extracts fields and pushes passive snapshots on input / blur / popstate / hashchange / pushState / DOM mutations. |
| `sidepanel.html` / `.css`  | Side-panel UI shell with Chat / Preview / JSON tabs, deploy modal, banner. |
| `sidepanel.js`             | UI logic, wizard accumulator (origin-scoped), passive snapshot listener, deploy flow, dev-views gating. |
| `options.html` / `.js`     | Settings: backend URL, agent id, Entra config, dev token, dev-views toggle. |
| `generate-extension-id.ps1`| One-shot helper to mint and pin a stable extension id.               |
| `icons/`                   | 16 / 32 / 128 px PNGs.                                               |
| `test/mock-wizard.html`    | 4-step mock wizard for end-to-end testing without a real customer site.|
| `.gitignore`               | Ignores generated key material.                                      |

---

## 9. Permissions explained

`manifest.json` requests:

- **`activeTab`** — temporary access to the current tab on each user
  click. Lets us inject `content_script.js` without declaring host
  permissions for arbitrary customer wizard URLs.
- **`scripting`** — needed to programmatically inject the content script.
- **`storage`** — for cached config and the `chrome.storage.session`
  wizard accumulator.
- **`sidePanel`** — opens the side panel UI.
- **`identity`** — for `launchWebAuthFlow` PKCE OAuth.
- **`host_permissions`** — only your **backend** URL. We deliberately do
  *not* declare host permissions for customer wizard sites; activeTab
  covers that on demand.

---

## 10. Troubleshooting

**"Cancelled via cancel scope" / 500 from `/api/assist/*`**
The agent's MCP server is not reachable. Start it (e.g. on
`http://localhost:8000/mcp`) and retry. The backend now surfaces the real
exception type in the response detail.

**OAuth popup loops or fails with `redirect_uri_mismatch`**
The redirect URI in Entra must be exactly
`https://<EXTENSION_ID>.chromiumapp.org/oauth2` and registered under the
**SPA** platform. The extension id printed by step 2 must match the id
shown on `edge://extensions`.

**"Can't read this page"**
Some pages are off-limits to extensions (browser-internal pages like
`edge://`, the Web Store, PDF viewers, file:// pages depending on
settings). Switch to the actual wizard tab and retry.

**Suggestions ignore earlier-step answers**
The content script must have been injected at least once on the wizard
tab (any action button does it). After that, passive capture handles the
rest — you do *not* need to click Explain page on every step. Confirm the
footer counter is incrementing as you advance. The accumulator is keyed
by **origin only**, so multi-page wizards on different paths share one
bucket. If the counter is stuck at 0, click any action button on the
current step to re-inject the content script.

**Preview tab is blank**
Preview only fills with agent HTML after you click **Generate preview**
from the Preview tab's empty state (or the Regenerate button). Enable
*Show developer views* in Options to expose the **Page** / **Wizard**
source toggles, which render fields directly without an agent call —
useful for confirming what was extracted.

**Deploy modal closes silently / banner shows error**
The inline error message inside the modal explains the failure (most
often: project slug already exists, or the agent's `deploy_security_page`
MCP tool is unreachable). The Preview tab also shows a red banner
variant on failure with the same detail.

**Edge warns about a private key in the loaded folder**
`extension-key.pem` should live at the **repo root**, not inside
`extension/`. The generator script defaults to that location. If you
moved it, move it back out and reload the extension.
