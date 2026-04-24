# Junior — Quick Start

A one-page guide to get you chatting with Junior in under 5 minutes.

## 1. Install

1. Open VS Code (1.85 or later).
2. `Ctrl+Shift+P` → **Extensions: Install from VSIX...** → pick the `junior-*.vsix` you were given.
3. Reload the window if prompted.

## 2. Pick Your Setup

`Ctrl+Shift+P` → **Junior: Open Sample Settings** and pick the file matching your environment:

| Your environment | Sample file | What you need |
|---|---|---|
| Azure API Management (APIM) with a subscription key | `apim-key.settings.json` | APIM key |
| Azure API Management (APIM) with VS Code / Entra sign-in | `apim-bearer.settings.json` | Sign-in (no key) |
| Direct Azure OpenAI / Foundry endpoint | `direct-key.settings.json` | Resource key |
| OpenAI / OpenRouter / Ollama / LM Studio | `openai-compat-key.settings.json` | Provider key |

If you're not sure, ask your administrator which one matches your team's setup.

## 3. Configure

1. Copy the sample file's contents into your VS Code user settings:
   `Ctrl+Shift+P` → **Preferences: Open User Settings (JSON)**.
2. Replace the placeholder host names, app IDs, and deployment IDs with your real values.

## 4. Authenticate

Pick the one that matches your sample:

- **Key auth:** `Ctrl+Shift+P` → **Junior: Set API Key** → paste your key.
- **Bearer / Entra sign-in:** `Ctrl+Shift+P` → **Junior: Sign In for Azure/APIM Bearer Mode**.

## 5. Open Chat

`Ctrl+Shift+I` (or click the **Junior** icon in the Activity Bar).

You should see the chat panel, the model picker shows at least one entry, and your first message gets a response.

---

## Common Commands

| Command | What it does |
|---|---|
| **Junior: Open Chat** | Open the chat panel |
| **Junior: New Chat Session** | Start a fresh conversation |
| **Junior: Select Model** | Switch between configured models |
| **Junior: Show Token Usage** | See how many tokens you've used |
| **Junior: Open Documentation** | Browse bundled setup guides |
| **Junior: Show Welcome Screen** | Re-open the splash screen |

## Troubleshooting

| Symptom | Try this |
|---|---|
| Chat panel is blank | Reload the window. Check the **Junior** output channel (`View → Output → Junior`) for errors. |
| "Missing API key" | Run **Junior: Set API Key** again. |
| "Missing deployment" | In settings, confirm `junior.azureOpenAI.deployments` and `activeDeployment` match a deployment your endpoint actually has. |
| 401 Unauthorized | Key is wrong or expired. For bearer mode, sign out and sign back in. |
| 404 on requests | Your `providerBaseUrl` or APIM path suffix is wrong. Compare to the sample. |
| Model dropdown empty | No deployments configured. Open the sample file and copy its `deployments` array. |

## Where to Get Help

- **Bundled docs:** `Ctrl+Shift+P` → **Junior: Open Documentation**.
- **Output channel:** `View → Output → Junior`. Always include this when reporting an issue.
- **Bug reports:** see `package.json` `bugs.url`.
