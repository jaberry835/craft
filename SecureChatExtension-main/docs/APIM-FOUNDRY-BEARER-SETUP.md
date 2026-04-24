# APIM in front of Azure AI Foundry — Bearer (Entra) Auth

This is the recommended APIM setup for **both** Junior (local agent) and GitHub Copilot CLI when the client authenticates to APIM with `Authorization: Bearer …` from Microsoft Entra (or another external STS) and APIM authenticates to Foundry with managed identity.

Both clients use the same APIM API and the same `/openai/v1/responses` route.

## When to Use Bearer Mode

Pick this over the [subscription-key path](APIM-FOUNDRY-KEY-SETUP.md) when you want:

- Per-user identity at the gateway (claims like `oid`, `upn`, `tid`).
- Per-user rate limiting, quotas, or analytics.
- No client-side key material — the user signs in through VS Code (Junior) or with `az account get-access-token` (CLI).

> Copilot CLI supports both an API key and a bearer token, but the bearer token wins. The cleanest design is **bearer only**: turn off APIM subscription requirement on this API and validate the JWT instead.

## Prerequisites

1. An Azure AI Foundry (or Azure OpenAI) resource with at least one chat deployment (e.g. `gpt-5.4`).
2. An Azure API Management (APIM) instance with a **system-assigned managed identity** enabled.
3. The APIM managed identity has been granted inference access on the Foundry resource — start with **Cognitive Services OpenAI User**.
4. An Entra app registration whose `Application ID URI` is the audience APIM will validate (e.g. `api://aa6b2ff6-…`). Users / VS Code / `az` request tokens for this audience.
5. (For VS Code sign-in) the two-app pattern from [ENTRA-VSCODE-AUTH-APP-SETUP.md](ENTRA-VSCODE-AUTH-APP-SETUP.md) so VS Code can broker tokens.

## Step 1 — Import the Foundry API

In the APIM portal:

1. **APIs → + Add API → Azure AI Foundry / Azure OpenAI** (the dedicated Foundry import template).
2. Point it at your Foundry resource and pick **API version = v1**.
3. Set the API URL suffix to **`openai/v1`**.
4. **Subscription required: Off.**

That gives you `POST /responses` and produces the client-facing route:

```
https://<apim-host>/openai/v1/responses
```

## Step 2 — API Policy (Entra-validated bearer)

Replace `tenant-id` and the `<audience>` value with your own.

```xml
<policies>
    <inbound>
        <base />
        <validate-azure-ad-token tenant-id="224e1b7d-7931-4c13-bce7-79f3873f0e34"
                                 header-name="Authorization"
                                 failed-validation-httpcode="401"
                                 failed-validation-error-message="Unauthorized">
            <audiences>
                <audience>api://aa6b2ff6-4168-4ffa-b0de-a91ef1726ac6</audience>
            </audiences>
        </validate-azure-ad-token>

        <!-- Decode the inbound user bearer JWT (null if missing/invalid). -->
        <set-variable name="userJwt" value="@(context.Request.Headers.GetValueOrDefault("Authorization","").StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase) ? context.Request.Headers.GetValueOrDefault("Authorization","").Substring(7).AsJwt() : null)" />
        <set-variable name="userId" value="@{
            var jwt = (Jwt)context.Variables.GetValueOrDefault("userJwt");
            return jwt == null ? "anonymous"
                : jwt.Claims.GetValueOrDefault("oid",
                  jwt.Claims.GetValueOrDefault("sub", "unknown"));
        }" />
        <set-variable name="userName" value="@{
            var jwt = (Jwt)context.Variables.GetValueOrDefault("userJwt");
            return jwt == null ? "anonymous"
                : jwt.Claims.GetValueOrDefault("preferred_username",
                  jwt.Claims.GetValueOrDefault("upn",
                  jwt.Claims.GetValueOrDefault("unique_name",
                  jwt.Claims.GetValueOrDefault("name", "unknown"))));
        }" />
        <set-variable name="tenantId" value="@{
            var jwt = (Jwt)context.Variables.GetValueOrDefault("userJwt");
            return jwt == null ? "unknown" : jwt.Claims.GetValueOrDefault("tid", "unknown");
        }" />

        <azure-openai-emit-token-metric namespace="FoundryProxy">
            <dimension name="API ID" />
            <dimension name="Operation ID" />
            <dimension name="User ID"   value="@((string)context.Variables["userId"])" />
            <dimension name="User Name" value="@((string)context.Variables["userName"])" />
            <dimension name="Tenant ID" value="@((string)context.Variables["tenantId"])" />
            <dimension name="Subscription ID" />
        </azure-openai-emit-token-metric>

        <!-- Strip the inbound user token, then attach the MI token for the backend. -->
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

> **Policy order matters.** APIM evaluates inbound policies top-to-bottom. `authentication-managed-identity` writes the backend `Authorization: Bearer <MI token>`, so it must be the **last** inbound step that touches `Authorization`. If a `delete` runs after it, the backend gets no token and returns 401. Some commercial regions tolerate the wrong order; sovereign and air-gapped clouds do not.

If the backend rejects the audience, switch to `resource="https://ai.azure.com"`. Use only one audience at a time.

## Generic External STS Variant

If you are not using Entra, swap `validate-azure-ad-token` for `validate-jwt` with your own issuer metadata:

```xml
<validate-jwt header-name="Authorization"
              require-scheme="Bearer"
              require-expiration-time="true"
              require-signed-tokens="true"
              failed-validation-httpcode="401"
              failed-validation-error-message="Unauthorized">
  <openid-config url="https://sts.example.com/.well-known/openid-configuration" />
  <required-claims>
    <claim name="aud"><value>copilot-apim</value></claim>
  </required-claims>
</validate-jwt>
```

## Validate the Route

```powershell
$token = az account get-access-token `
  --scope "api://aa6b2ff6-4168-4ffa-b0de-a91ef1726ac6/user_impersonation" `
  --query accessToken -o tsv

$url = "https://<your-apim-host>.azure-api.net/openai/v1/responses"
$headers = @{ "Authorization" = "Bearer $token" }
$body = '{"model":"gpt-5.4","input":"hello"}'

Invoke-RestMethod -Uri $url -Method Post -Headers $headers -Body $body `
  -ContentType "application/json" -TimeoutSec 30 -Verbose
```

Expected: `200 OK` with a `response` object from Foundry.

## Client Configuration

### Junior — VS Code Sign-In (recommended)

`settings.json`:

```jsonc
{
  "junior.agentProvider": "local",

  "junior.azureOpenAI.provider": "apim",
  "junior.azureOpenAI.apimBaseUrl": "https://<your-apim-host>.azure-api.net",

  "junior.azureOpenAI.authMode": "vscode-auth-session",
  "junior.azureOpenAI.bearerTokenSource": "vscode-auth-session",
  "junior.azureOpenAI.authProviderId": "microsoft",
  "junior.azureOpenAI.authScopes": [
    "api://<apim-app-clientid>/user_impersonation",
    "VSCODE_CLIENT_ID:<vscode-client-app-id>",
    "VSCODE_TENANT:<tenant-id>"
  ],

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

Then run **Junior: Sign In for Azure/APIM Bearer Mode** once.

> `apimBaseUrl` is the gateway **host root**. With `wireApi: responses`, the SDK appends `/openai/v1/responses` itself and strips any path on the base URL.

> Use `"junior.azureOpenAI.authProviderId": "microsoft-sovereign-cloud"` in sovereign / Gov clouds and configure the matching `microsoft-sovereign-cloud.customEnvironment` block.

### Junior — Raw Bearer Token (fallback)

```jsonc
{
  "junior.azureOpenAI.authMode": "bearer-token",
  "junior.azureOpenAI.bearerToken": "<BEARER_TOKEN>"
}
```

Use this only if VS Code sign-in is not an option (e.g. CI / scripted scenarios).

### Copilot CLI

```powershell
Get-ChildItem Env: | Where-Object { $_.Name -like 'COPILOT_*' } | Remove-Item -ErrorAction Ignore

$env:COPILOT_HOME = Join-Path $env:TEMP 'copilot-byok-bearer'
New-Item -ItemType Directory -Force -Path $env:COPILOT_HOME | Out-Null

$env:COPILOT_PROVIDER_TYPE         = 'azure'
$env:COPILOT_PROVIDER_BASE_URL     = 'https://<your-apim-host>.azure-api.net'
$env:COPILOT_PROVIDER_BEARER_TOKEN = '<BEARER_TOKEN>'   # az account get-access-token
$env:COPILOT_MODEL                 = 'gpt-5.4'
$env:COPILOT_PROVIDER_MODEL_ID     = 'gpt-5.4'
$env:COPILOT_PROVIDER_WIRE_MODEL   = 'gpt-5.4'
$env:COPILOT_PROVIDER_WIRE_API     = 'responses'
Remove-Item Env:COPILOT_PROVIDER_AZURE_API_VERSION -ErrorAction Ignore

copilot --model gpt-5.4
```

## Per-User Tracking

With JWT mode, APIM can key on token claims:

- `oid`, `sub`, `upn`, `preferred_username`, `tid`

Useful patterns:

- `rate-limit-by-key` keyed on `oid` / `sub`
- `azure-openai-token-limit` keyed on a claim for token-budget governance
- `azure-openai-emit-token-metric` (already in the policy above) feeds Application Insights

Example user-based rate limit:

```xml
<rate-limit-by-key calls="60" renewal-period="60"
                   counter-key="@(((Jwt)context.Variables["userJwt"])?.Subject ?? "anonymous")" />
```

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `401 Unauthorized` from APIM | Wrong audience, expired token, missing `Bearer` scheme, wrong tenant in `validate-azure-ad-token`, or you pasted the JSON-wrapped `az account get-access-token` output instead of the raw token. |
| `401` from the **backend** even though the user JWT validated | Policy order: a `set-header name="Authorization" exists-action="delete"` is running **after** `authentication-managed-identity`, wiping the MI token. Move the delete above. |
| `403` from the backend | APIM managed identity lacks inference role on the Foundry resource, or the MI audience is wrong (try `https://ai.azure.com`). |
| `404 Not Found` | API URL suffix isn't `openai/v1`, or the operation isn't `POST /responses`. |
| `AADSTS500113` (reply URL not registered) | VS Code sign-in needs the two-app Entra pattern from [ENTRA-VSCODE-AUTH-APP-SETUP.md](ENTRA-VSCODE-AUTH-APP-SETUP.md). |
| `400 model is required` | Empty `model` in the body. Set `junior.azureOpenAI.activeDeployment` (or `COPILOT_PROVIDER_MODEL_ID` for CLI). |
