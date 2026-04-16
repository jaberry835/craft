# APIM Setup for GitHub Copilot CLI BYOK with Foundry: Bearer-Only Mode

This guide documents a bearer-only setup where the client authenticates to APIM with `Authorization: Bearer ...` from Azure Entra or another external STS and APIM authenticates to Foundry with managed identity.

## When to Use This Pattern

Use this pattern when:

1. You want APIM to identify end users from JWT claims.
2. You want per-user rate limiting, token governance, or analytics.
3. You do not want the client to use an APIM subscription key.
4. You want APIM to validate user identity before forwarding to Foundry.

## Important Constraint

Copilot CLI supports both an API key and a bearer token, but the bearer token takes precedence. In practice, that means the cleanest design is:

1. Do not require an APIM subscription key for this API.
2. Require a bearer token on `Authorization`.
3. Validate the JWT in APIM.
4. Use the JWT subject or another claim for rate limiting, quotas, and analytics.
5. Use managed identity from APIM to Foundry.

If you require both a subscription key and a bearer token, Copilot CLI does not provide a great built-in way to supply both as separate client credentials for this provider flow.

## Copilot CLI Behavior That Matters

For GPT-5-class models, the working Copilot CLI configuration uses the `responses` wire API.

The CLI calls:

```text
POST /openai/v1/responses
```

The working public URL shape is:

```text
https://<apim-host>/openai/v1/responses
```

## Recommended APIM API Design

Recommended API settings:

1. Display name: `cli-openai`
2. Name: `cli-openai`
3. API URL suffix: `openai`
4. Web service URL: `https://agent-poc-resource.services.ai.azure.com/openai`
5. API URL suffix: `openai`
6. Subscription required: `Off`
7. User authorization: `None`

Recommended operation:

1. `POST /v1/responses`

## Backend Authentication to Foundry

Foundry backend auth should still use APIM managed identity, not the end-user bearer token.

### Required Azure Setup

1. Enable a system-assigned or user-assigned managed identity on the APIM instance.
2. Grant that identity inference access on the Foundry/Azure OpenAI resource.

## Working Azure Entra Policy

This is the policy shape that worked for Azure Entra bearer-token auth in testing.

Replace the tenant ID and audience values with your own if they differ.

```xml
<policies>
  <inbound>
    <set-backend-service base-url="https://agent-poc-resource.services.ai.azure.com/openai" />

    <validate-azure-ad-token
      tenant-id="224e1b7d-7931-4c13-bce7-79f3873f0e34"
      header-name="Authorization"
      failed-validation-httpcode="401"
      failed-validation-error-message="Unauthorized">
      <audiences>
        <audience>api://aa6b2ff6-4168-4ffa-b0de-a91ef1726ac6</audience>
        <audience>aa6b2ff6-4168-4ffa-b0de-a91ef1726ac6</audience>
      </audiences>
    </validate-azure-ad-token>

    <authentication-managed-identity
      resource="https://cognitiveservices.azure.com"
      ignore-error="false" />

    <set-header name="api-key" exists-action="delete" />
    <set-header name="Authorization" exists-action="delete" />
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

If the backend rejects that audience, try:

```xml
resource="https://ai.azure.com"
```

## Generic External STS Variant

If you are not using Azure Entra, use `validate-jwt` with your issuer metadata instead of `validate-azure-ad-token`.

```xml
<validate-jwt header-name="Authorization"
              require-scheme="Bearer"
              require-expiration-time="true"
              require-signed-tokens="true"
              failed-validation-httpcode="401"
              failed-validation-error-message="Unauthorized">
  <openid-config url="https://sts.example.com/.well-known/openid-configuration" />
  <required-claims>
    <claim name="aud">
      <value>copilot-apim</value>
    </claim>
  </required-claims>
</validate-jwt>
```

## Copilot CLI Environment for Bearer Mode

```powershell
Get-ChildItem Env: | Where-Object { $_.Name -like 'COPILOT_*' } | Remove-Item -ErrorAction Ignore

$env:COPILOT_HOME = Join-Path $env:TEMP 'copilot-byok-jwt'
New-Item -ItemType Directory -Force -Path $env:COPILOT_HOME | Out-Null

$env:COPILOT_PROVIDER_TYPE = 'azure'
$env:COPILOT_PROVIDER_BASE_URL = 'https://rudeaoaiapi.azure-api.net'
$env:COPILOT_MODEL = 'gpt-5.4'
$env:COPILOT_PROVIDER_MODEL_ID = 'gpt-5.4'
$env:COPILOT_PROVIDER_WIRE_MODEL = 'gpt-5.4'
$env:COPILOT_PROVIDER_BEARER_TOKEN = '<BEARER_TOKEN>'
$env:COPILOT_PROVIDER_WIRE_API = 'responses'
Remove-Item Env:COPILOT_PROVIDER_AZURE_API_VERSION -ErrorAction Ignore

copilot --model gpt-5.4
```

## Tracking User Usage

With JWT mode, APIM can track users by token claims such as:

1. `sub`
2. `oid`
3. `upn`
4. tenant-specific custom claims

Useful patterns:

1. `rate-limit-by-key` keyed on JWT subject
2. `azure-openai-token-limit` keyed on a claim for token-based governance
3. Application Insights diagnostics with claim-derived correlation data

Example user-based rate limit:

```xml
<rate-limit-by-key calls="60"
                   renewal-period="60"
                   counter-key="@(context.Request.Headers.GetValueOrDefault(&quot;Authorization&quot;,&quot;&quot;).AsJwt()?.Subject)" />
```

## Recommended Architecture

Use this pattern:

1. User authenticates with Azure Entra or your external STS.
2. Client obtains a JWT for APIM.
3. Copilot CLI sends the JWT in `Authorization: Bearer ...`.
4. APIM validates JWT and records usage by user claim.
5. APIM calls Foundry using its own managed identity.

This keeps Foundry isolated from user tokens and lets APIM own client identity, quotas, and analytics.

## Manual Validation

If you have a bearer token for APIM, validate the route like this:

```powershell
$url = "https://rudeaoaiapi.azure-api.net/openai/v1/responses"
$headers = @{ "Authorization" = "Bearer <BEARER_TOKEN>" }
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

## Troubleshooting

### 401 Unauthorized

Common causes:

1. invalid issuer configuration in `validate-jwt` or `validate-azure-ad-token`
2. wrong `aud` claim
3. expired token
4. missing `Bearer` scheme
5. using JSON-wrapped `az account get-access-token` output instead of the raw token string

### 403 or Backend Auth Errors

Usually means APIM managed identity does not have backend inference access or the managed-identity audience is wrong.

### 404 Not Found

Usually means the public route shape is wrong.

Check that the client reaches:

```text
/openai/v1/responses
```

not a path-prefixed variant.

## Notes from the Working Azure Entra Test

The working bearer-mode test used these API settings:

1. `Web service URL`: `https://agent-poc-resource.services.ai.azure.com/openai`
2. `API URL suffix`: `openai`
3. Operation: `POST /v1/responses`
4. `Subscription required`: off
5. `User authorization`: `None`

And the manual validation succeeded with:

```powershell
$token = az account get-access-token `
  --scope "api://aa6b2ff6-4168-4ffa-b0de-a91ef1726ac6/user_impersonation" `
  --query accessToken `
  -o tsv

$url = "https://rudeaoaiapi.azure-api.net/openai/v1/responses"
$headers = @{ "Authorization" = "Bearer $token" }
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