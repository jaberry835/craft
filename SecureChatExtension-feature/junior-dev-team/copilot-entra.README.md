# copilot-entra.ps1

PowerShell helper that points the GitHub **Copilot CLI** at an **Azure APIM** front
end secured by **Microsoft Entra ID** (bearer / `user_impersonation`), and keeps
your bearer token fresh across a long working session.

## What it does

1. Acquires an Entra access token for the configured API scope (silently from
   the `az` cache when possible; falls back to `az login` only when needed).
2. Sets the `COPILOT_*` env vars the Copilot CLI BYOK bearer mode expects:
   `COPILOT_PROVIDER_TYPE=azure`, base URL, model, wire API, bearer token, etc.
3. Registers two helper functions in your shell:
   - `Refresh-CopilotToken` — mint a new bearer (silent if the `az` cache is warm)
   - `Start-Copilot` — refresh + launch `copilot`, with an optional relaunch loop

## Prerequisites

- [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) (`az`) on PATH
- [GitHub Copilot CLI](https://docs.github.com/copilot/github-copilot-in-the-cli) (`copilot`) on PATH
- Permission to consent to the API scope (`api://<ApiAppId>/user_impersonation`)

## First-time use

Open PowerShell in the repo root and **dot-source** the script (the leading
`. ` runs it in your current shell, so env vars and helpers persist):

```powershell
. .\copilot-entra.ps1
```

On first run, `az login` opens a browser. After that the cached refresh token
(~90 days) lets subsequent runs mint tokens silently.

Then launch the CLI:

```powershell
Start-Copilot
```

`Start-Copilot` refreshes the token, runs `copilot --model <Model>`, and when
copilot exits asks whether to refresh + relaunch. Answer `y` to keep going.

## Daily use

New shell? Same two lines:

```powershell
. .\copilot-entra.ps1
Start-Copilot
```

## When you get a 401 mid-session

Access tokens last ~60–90 minutes. If `copilot` starts erroring:

```powershell
# inside copilot
exit

# back in PowerShell
Refresh-CopilotToken
copilot --model gpt-5.4
```

Or just `Start-Copilot` again.

> **Why can't it refresh in place?** The Copilot CLI reads
> `COPILOT_PROVIDER_BEARER_TOKEN` only at process startup. There is no hook to
> push a new token into a running copilot process, so a relaunch is required.

## One-shot mode

If you don't need the helpers and just want set-vars-and-launch:

```powershell
.\copilot-entra.ps1 -LaunchCopilot
```

(No dot-source — helpers won't be available after copilot exits.)

## Parameters

| Parameter                  | Default                                                           | Notes |
|----------------------------|-------------------------------------------------------------------|-------|
| `-TenantId`                | `224e1b7d-7931-4c13-bce7-79f3873f0e34`                            | Entra tenant |
| `-ApiAppId`                | `aa6b2ff6-4168-4ffa-b0de-a91ef1726ac6`                            | App registration exposing the API |
| `-ScopeName`               | `user_impersonation`                                              | Scope on the API app |
| `-BaseUrl`                 | `https://yourapim.azure-api.net`                                  | APIM (or other compatible) endpoint |
| `-Model`                   | `gpt-5.4`                                                         | Model id passed to `copilot --model` |
| `-CopilotHome`             | `$env:TEMP\copilot-byok-entra`                                    | `COPILOT_HOME` for this session |
| `-LaunchCopilot`           | off                                                               | Launch `copilot` immediately (no helpers) |
| `-ClearExistingCopilotEnv` | off                                                               | Wipe existing `COPILOT_*` env vars first |

Example:

```powershell
. .\copilot-entra.ps1 -Model gpt-5.4 -BaseUrl https://my-apim.azure-api.net
Start-Copilot
```

## Troubleshooting

- **`az login` opens every time** — your `az` CLI may not be persisting the
  refresh token. Check `az config` / token cache location, or that you're not
  signing in with `--use-device-code` in a transient profile.
- **401s immediately** — token audience mismatch. The token must be for the
  app registration that fronts your `BaseUrl` (APIM vs. direct AOAI vs.
  Foundry inference all need different audiences).
- **CLI doesn't see new token after `Refresh-CopilotToken`** — expected; you
  must restart `copilot`.
