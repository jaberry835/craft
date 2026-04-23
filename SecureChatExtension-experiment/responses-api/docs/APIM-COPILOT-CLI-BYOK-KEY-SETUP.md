# APIM Setup for GitHub Copilot CLI BYOK with Foundry: Subscription Key Mode

This guide documents the working setup where the client authenticates to APIM with an APIM subscription key and APIM authenticates to Foundry with managed identity.

## When to Use This Pattern

Use this pattern when:

1. You want the simplest working Copilot CLI setup.
2. You are comfortable authenticating the client to APIM with an APIM subscription key.
3. You do not need end-user identity from a bearer token at the APIM layer.

## Copilot CLI Behavior That Matters

For GPT-5-class models, the working Copilot CLI configuration uses the `responses` wire API.

The CLI calls:

```text
POST /openai/v1/responses
```

Important behavior observed during testing:

1. The Azure BYOK provider appends `/openai/v1/responses` itself.
2. The Azure BYOK provider does not preserve extra path prefixes in `COPILOT_PROVIDER_BASE_URL`.
3. The working public URL shape is:

```text
https://<apim-host>/openai/v1/responses
```

## Recommended APIM API Design

Create a dedicated API for Copilot CLI instead of reusing a path-prefixed Foundry API.

Recommended API settings:

1. Display name: `cli-openai`
2. Name: `cli-openai`
3. API URL suffix: `openai`
4. Web service URL: `https://agent-poc-resource.services.ai.azure.com/openai`
5. Subscription required: `On`

Recommended operation:

1. `POST /v1/responses`

Optional operations if needed later:

1. `GET /v1/models`
2. `GET /v1/models/{model}`
3. `POST /deployments/{deployment-id}/chat/completions`

## Backend Authentication to Foundry

If key-based authentication is disabled on the Foundry resource, APIM must authenticate to the backend with managed identity.

### Required Azure Setup

1. Enable a system-assigned or user-assigned managed identity on the APIM instance.
2. Grant that identity inference access on the Foundry/Azure OpenAI resource.
3. Start with the built-in role that allows model inference, such as `Cognitive Services OpenAI User`, if your environment permits it.

### API Policy

Apply this API-level policy to the `cli-openai` API:

```xml
<policies>
  <inbound>
    <set-backend-service base-url="https://agent-poc-resource.services.ai.azure.com/openai" />
    <set-header name="api-key" exists-action="delete" />
    <set-header name="Authorization" exists-action="delete" />
    <authentication-managed-identity
      resource="https://cognitiveservices.azure.com"
      ignore-error="false" />
  </inbound>
  <backend>
    <forward-request timeout="60" />
  </backend>
  <outbound />
  <on-error>
    <base />
  </on-error>
</policies>
```

If the backend returns an authorization error, try changing the managed identity audience to:

```xml
resource="https://ai.azure.com"
```

Only one audience should be used at a time.

## APIM Product and Subscription

1. Create a Product, for example `Copilot CLI`.
2. Add the `cli-openai` API to that Product.
3. Create a subscription for the Product.
4. Use the APIM subscription key as the client `api-key`.

## Manual Validation

```powershell
$url = "https://rudeaoaiapi.azure-api.net/openai/v1/responses"
$headers = @{ "api-key" = "<APIM_SUBSCRIPTION_KEY>" }
$body = '{"model":"gpt-5.4","input":"hello"}'

Invoke-RestMethod `
  -Uri $url `
  -Method Post `
  -Headers $headers `
  -Body $body `
  -ContentType "application/json" `
  -TimeoutSec 30 `
  -Verbose
```

Expected result: `200 OK` with a valid `response` object from Foundry.

## Copilot CLI Environment

```powershell
Get-ChildItem Env: | Where-Object { $_.Name -like 'COPILOT_*' } | Remove-Item -ErrorAction Ignore

$env:COPILOT_HOME = Join-Path $env:TEMP 'copilot-byok-clean'
New-Item -ItemType Directory -Force -Path $env:COPILOT_HOME | Out-Null

$env:COPILOT_PROVIDER_TYPE = 'azure'
$env:COPILOT_PROVIDER_BASE_URL = 'https://rudeaoaiapi.azure-api.net'
$env:COPILOT_MODEL = 'gpt-5.4'
$env:COPILOT_PROVIDER_MODEL_ID = 'gpt-5.4'
$env:COPILOT_PROVIDER_WIRE_MODEL = 'gpt-5.4'
$env:COPILOT_PROVIDER_API_KEY = '<APIM_SUBSCRIPTION_KEY>'
$env:COPILOT_PROVIDER_WIRE_API = 'responses'
Remove-Item Env:COPILOT_PROVIDER_AZURE_API_VERSION -ErrorAction Ignore

copilot --model gpt-5.4
```

## Important Notes

1. `COPILOT_PROVIDER_BASE_URL` must be the APIM host root, not `/openai` and not `/foundryapi`.
2. `COPILOT_PROVIDER_WIRE_API` should be `responses` for GPT-5.
3. `COPILOT_PROVIDER_AZURE_API_VERSION` should be unset so the CLI uses `/openai/v1/responses`.
4. The client key is the APIM subscription key, not the Foundry key.
5. APIM should not forward a backend `api-key` when the Foundry resource has key-based authentication disabled.

## Troubleshooting

### 404 Not Found

Usually means the public route shape is wrong.

Check that the client reaches:

```text
/openai/v1/responses
```

not a path-prefixed variant.

### 401 Invalid Subscription Key

Usually means the client is sending the wrong `api-key` to APIM.

Use an APIM subscription key, not the Foundry key.

### AuthenticationTypeDisabled

Usually means APIM forwarded an `api-key` to a Foundry resource that has key-based auth disabled.

Delete `api-key` before forwarding and use `authentication-managed-identity`.

### Hanging Requests

Common causes:

1. inherited APIM policies via `<base />` that still rewrite backend settings
2. wrong managed-identity audience
3. backend credential configuration still present on the API or backend entity

Use a minimal isolated API policy while debugging.