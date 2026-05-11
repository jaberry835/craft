# APIM in front of Azure AI Foundry — Subscription Key Auth

This is the recommended APIM setup for **both** Junior (local agent) and GitHub Copilot CLI when the client authenticates to APIM with an APIM subscription key.

Both clients use the same APIM API and the same `/openai/v1/responses` route. There is nothing CLI-specific or Junior-specific about the gateway side — only the client config differs.

## Prerequisites

1. An Azure AI Foundry (or Azure OpenAI) resource with at least one chat deployment (e.g. `gpt-5.4`).
2. An Azure API Management (APIM) instance with a **system-assigned managed identity** enabled.
3. The APIM managed identity has been granted inference access on the Foundry resource — start with the built-in role **Cognitive Services OpenAI User** (or your environment's equivalent in sovereign / air-gapped clouds).

## Step 1 — Import the Foundry API

In the APIM portal:

1. **APIs → + Add API → Azure AI Foundry / Azure OpenAI** (the dedicated Foundry import template).
2. Point it at your Foundry resource and pick **API version = v1** (not the dated `2024-…` versions).
3. Set the API URL suffix to **`openai/v1`**.
4. **Subscription required: On.**

The template gives you `POST /responses`, `GET /models`, etc. as operations. The full client-facing route ends up as:

```
https://<apim-host>/openai/v1/responses
```

That is the URL both Junior (with `wireApi=responses`) and Copilot CLI hit.

## Step 2 — API Policy

The Foundry template wires up most of this for you. The only required customizations are: strip inbound auth before forwarding, and swap to managed identity for the backend call.

```xml
<policies>
  <inbound>
    <base />
    <set-header name="api-key" exists-action="delete" />
    <set-header name="Authorization" exists-action="delete" />
    <authentication-managed-identity
      resource="https://cognitiveservices.azure.com"
      ignore-error="false" />
  </inbound>
  <backend>
    <base />
  </backend>
  <outbound>
    <base />
  </outbound>
  <on-error>
    <base />
  </on-error>
</policies>
```

Notes:

- **Policy order matters.** `authentication-managed-identity` writes the backend `Authorization` header, so it must be the **last** inbound step that touches `Authorization`. If a `set-header name="Authorization" exists-action="delete"` runs after it, the backend gets no token and returns 401. Sovereign and air-gapped clouds enforce this strictly.
- If the backend rejects the audience, switch to `resource="https://ai.azure.com"`. Use only one audience at a time.
- `<set-backend-service base-url=…>` is not needed — the Foundry import template already configures the backend.

## Step 3 — Product and Subscription

1. Create (or reuse) an APIM **Product** and add the new API to it.
2. Create a Product **subscription** — its primary key is what clients send as `api-key`.

## Step 4 — Validate the Route

```powershell
$url = "https://<your-apim-host>.azure-api.net/openai/v1/responses"
$headers = @{ "api-key" = "<APIM_SUBSCRIPTION_KEY>" }
$body = '{"model":"gpt-5.4","input":"hello"}'

Invoke-RestMethod -Uri $url -Method Post -Headers $headers -Body $body `
  -ContentType "application/json" -TimeoutSec 30 -Verbose
```

Expected: `200 OK` with a `response` object from Foundry.

## Step 5 — Client Configuration

### Junior (local agent)

`settings.json`:

```jsonc
{
  "junior.agentProvider": "local",

  "junior.azureOpenAI.provider": "apim",
  "junior.azureOpenAI.apimBaseUrl": "https://<your-apim-host>.azure-api.net",
  "junior.azureOpenAI.authMode": "api-key",

  "junior.azureOpenAI.wireApi": "responses",
  "junior.azureOpenAI.reasoningEffort": "medium",
  "junior.azureOpenAI.reasoningSummary": "auto",

  "junior.azureOpenAI.deployments": [
    { "name": "GPT-5.4", "deploymentId": "gpt-5.4" }
  ],
  "junior.azureOpenAI.activeDeployment": "gpt-5.4",
  "junior.inlineCompletions.deployment": "gpt-5.4"
}
```

Then run **Junior: Set API Key** and paste the APIM subscription key.

> `apimBaseUrl` is the gateway **host root** (no `/openai/...` path). With `wireApi: responses`, the SDK appends `/openai/v1/responses` itself and strips any path you put on the base URL.

### Copilot CLI

```powershell
Get-ChildItem Env: | Where-Object { $_.Name -like 'COPILOT_*' } | Remove-Item -ErrorAction Ignore

$env:COPILOT_HOME = Join-Path $env:TEMP 'copilot-byok-key'
New-Item -ItemType Directory -Force -Path $env:COPILOT_HOME | Out-Null

$env:COPILOT_PROVIDER_TYPE        = 'azure'
$env:COPILOT_PROVIDER_BASE_URL    = 'https://<your-apim-host>.azure-api.net'
$env:COPILOT_PROVIDER_API_KEY     = '<APIM_SUBSCRIPTION_KEY>'
$env:COPILOT_MODEL                = 'gpt-5.4'
$env:COPILOT_PROVIDER_MODEL_ID    = 'gpt-5.4'
$env:COPILOT_PROVIDER_WIRE_MODEL  = 'gpt-5.4'
$env:COPILOT_PROVIDER_WIRE_API    = 'responses'
Remove-Item Env:COPILOT_PROVIDER_AZURE_API_VERSION -ErrorAction Ignore

copilot --model gpt-5.4
```

> `COPILOT_PROVIDER_BASE_URL` is the gateway **host root**. The Azure BYOK provider in Copilot CLI strips any path from this value and always appends `/openai/v1/responses`.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `404 Not Found` | API URL suffix isn't `openai/v1`, or the operation isn't `POST /responses`. Check the operation **Test** tab — its Request URL is ground truth. |
| `401 Invalid subscription key` | Sending the Foundry resource key instead of the APIM subscription key. |
| `AuthenticationTypeDisabled` | APIM forwarded an `api-key` to a Foundry resource with key auth disabled. The `set-header name="api-key" exists-action="delete"` step must run before the backend call. |
| `400 model is required` | The request body has no `model`. For Junior, set `junior.azureOpenAI.activeDeployment`. For CLI, set `COPILOT_PROVIDER_MODEL_ID`. |
| Hangs / slow | An inherited base policy is rewriting the backend, or the managed-identity audience is wrong. Try `resource="https://ai.azure.com"`. |
