# APIM Setup for Junior Local Mode

This guide documents how to expose Azure OpenAI or Foundry through Azure API Management for Junior's local provider mode.

Use this guide when:

1. `junior.agentProvider` is `local`
2. `junior.azureOpenAI.provider` is `apim`
3. Junior should call Azure OpenAI through APIM instead of connecting directly to the resource

This guide is intentionally separate from the Copilot CLI APIM setup docs because the request shape is different.

## Important Difference from Copilot CLI

Junior local mode preserves the full APIM path prefix that you configure in `junior.azureOpenAI.apimBaseUrl`.

That means this works for Junior local mode:

```text
https://<apim-host>/foundryapi
https://<apim-host>/foundryapi-bearer
```

Junior then calls the Azure-style chat-completions route under that prefix:

```text
POST /openai/deployments/{deployment-id}/chat/completions?api-version={api-version}
```

Example final request shape:

```text
https://rudeaoaiapi.azure-api.net/foundryapi/openai/deployments/gpt-5.4/chat/completions?api-version=2025-03-01-preview
```

This is different from the Copilot CLI Azure BYOK provider, which ignores extra path prefixes and expects a host-root route like `/openai/v1/responses`.

## Recommended APIM Design

For Junior local mode, the cleanest design is to expose two separate APIM APIs:

1. `foundryapi` for subscription-key auth
2. `foundryapi-bearer` for bearer-token auth

That separation avoids mixing client-auth patterns in one API and makes policy behavior clearer.

Recommended shared backend:

```text
https://agent-poc-resource.services.ai.azure.com/openai
```

Recommended shared frontend operation shape:

```text
POST /openai/deployments/{deployment-id}/chat/completions
```

Junior local mode uses the configured `api-version` query parameter from `junior.azureOpenAI.apiVersion` or the per-deployment override.

## Backend Authentication to Foundry

If key-based auth is disabled on the Foundry or Azure OpenAI resource, APIM should authenticate to the backend with managed identity.

Required Azure setup:

1. Enable a system-assigned or user-assigned managed identity on the APIM instance.
2. Grant that identity inference access on the backend AI resource.
3. Start with the built-in role that permits inference access in your environment.

Base backend policy pattern:

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

If the backend rejects that audience, try:

```xml
resource="https://ai.azure.com"
```

Use only one managed-identity audience at a time.

## Option A: APIM with Subscription Key

Use this when Junior should send an `api-key` header to APIM.

### APIM API Settings

Recommended API settings:

1. Display name: `foundryapi`
2. Name: `foundryapi`
3. API URL suffix: `foundryapi`
4. Web service URL: `https://agent-poc-resource.services.ai.azure.com/openai`
5. Subscription required: `On`

Recommended operation:

1. `POST /openai/deployments/{deployment-id}/chat/completions`

### API Policy

```xml
<policies>
  <inbound>
    <set-backend-service base-url="https://agent-poc-resource.services.ai.azure.com/openai" />
    <set-header name="Authorization" exists-action="delete" />
    <set-header name="api-key" exists-action="delete" />
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

The client `api-key` is the APIM subscription key, not the backend Foundry key.

### Junior Settings

```jsonc
{
  "junior.agentProvider": "local",
  "junior.azureOpenAI.provider": "apim",
  "junior.azureOpenAI.apimBaseUrl": "https://rudeaoaiapi.azure-api.net/foundryapi",
  "junior.azureOpenAI.apiVersion": "2025-03-01-preview",
  "junior.azureOpenAI.authMode": "api-key",
  "junior.azureOpenAI.deployments": [
    {
      "name": "GPT-5.4",
      "deploymentId": "gpt-5.4"
    }
  ],
  "junior.azureOpenAI.activeDeployment": "gpt-5.4"
}
```

Then store the APIM subscription key with **Junior: Set API Key**.

## Option B: APIM with Bearer Token

Use this when APIM should authenticate the end user from `Authorization: Bearer ...` and then use APIM managed identity to call the backend.

This is the better option when you want per-user tracking, policy enforcement, or user-based rate limiting at the APIM layer.

### APIM API Settings

Recommended API settings:

1. Display name: `foundryapi-bearer`
2. Name: `foundryapi-bearer`
3. API URL suffix: `foundryapi-bearer`
4. Web service URL: `https://agent-poc-resource.services.ai.azure.com/openai`
5. Subscription required: `Off`

Recommended operation:

1. `POST /openai/deployments/{deployment-id}/chat/completions`

### Azure Entra Validation Policy

This is the bearer-mode policy shape that worked during testing.

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

If you are using a non-Entra STS, replace `validate-azure-ad-token` with `validate-jwt` and your own issuer metadata.

### Junior Settings Using VS Code Sign-In

```jsonc
{
  "junior.agentProvider": "local",
  "junior.azureOpenAI.provider": "apim",
  "junior.azureOpenAI.apimBaseUrl": "https://rudeaoaiapi.azure-api.net/foundryapi-bearer",
  "junior.azureOpenAI.apiVersion": "2025-03-01-preview",
  "junior.azureOpenAI.authMode": "vscode-auth-session",
  "junior.azureOpenAI.bearerTokenSource": "vscode-auth-session",
  "junior.azureOpenAI.authProviderId": "microsoft",
  "junior.azureOpenAI.authScopes": [
    "api://aa6b2ff6-4168-4ffa-b0de-a91ef1726ac6/user_impersonation"
  ],
  "junior.azureOpenAI.deployments": [
    {
      "name": "GPT-5.4",
      "deploymentId": "gpt-5.4"
    }
  ],
  "junior.azureOpenAI.activeDeployment": "gpt-5.4"
}
```

Then run:

1. **Junior: Sign In for Azure/APIM Bearer Mode**

Junior asks VS Code for a token at request time. If silent refresh is possible, requests continue without prompting. If the session is gone or no longer refreshable, VS Code can prompt again on a later request.

### Junior Settings Using a Raw Bearer Token

```jsonc
{
  "junior.agentProvider": "local",
  "junior.azureOpenAI.provider": "apim",
  "junior.azureOpenAI.apimBaseUrl": "https://rudeaoaiapi.azure-api.net/foundryapi-bearer",
  "junior.azureOpenAI.apiVersion": "2025-03-01-preview",
  "junior.azureOpenAI.authMode": "bearer-token",
  "junior.azureOpenAI.bearerToken": "<BEARER_TOKEN>",
  "junior.azureOpenAI.deployments": [
    {
      "name": "GPT-5.4",
      "deploymentId": "gpt-5.4"
    }
  ],
  "junior.azureOpenAI.activeDeployment": "gpt-5.4"
}
```

## Manual Validation

Before testing Junior, validate the APIM route directly.

### Key Mode

```powershell
$url = "https://rudeaoaiapi.azure-api.net/foundryapi/openai/deployments/gpt-5.4/chat/completions?api-version=2025-03-01-preview"
$headers = @{ "api-key" = "<APIM_SUBSCRIPTION_KEY>" }
$body = '{"messages":[{"role":"user","content":"hello"}],"temperature":0.2,"max_tokens":200}'

Invoke-RestMethod `
  -Uri $url `
  -Method Post `
  -Headers $headers `
  -Body $body `
  -ContentType "application/json" `
  -TimeoutSec 30 `
  -Verbose
```

### Bearer Mode

```powershell
$url = "https://rudeaoaiapi.azure-api.net/foundryapi-bearer/openai/deployments/gpt-5.4/chat/completions?api-version=2025-03-01-preview"
$headers = @{ "Authorization" = "Bearer <BEARER_TOKEN>" }
$body = '{"messages":[{"role":"user","content":"hello"}],"temperature":0.2,"max_tokens":200}'

Invoke-RestMethod `
  -Uri $url `
  -Method Post `
  -Headers $headers `
  -Body $body `
  -ContentType "application/json" `
  -TimeoutSec 30 `
  -Verbose
```

Expected result: `200 OK` with a normal chat-completions payload.

## Inline Completions

Junior inline completions use the same local Azure/APIM client and the same auth mode.

That means once chat works against the APIM route, inline completions can use the same gateway configuration. You only need to point `junior.inlineCompletions.deployment` at the intended model if it should differ from the chat model.

## Troubleshooting

### 401 Unauthorized

Common causes:

1. wrong bearer-token audience
2. expired token
3. missing `Bearer` scheme
4. APIM bearer API still has `Subscription required = On`
5. using an APIM subscription key against the bearer route or vice versa

### 404 Not Found

Usually means the APIM suffix or operation path does not match what Junior local mode calls.

The full route needs to include your configured APIM prefix plus:

```text
/openai/deployments/{deployment-id}/chat/completions
```

### AuthenticationTypeDisabled

Usually means APIM forwarded an `api-key` to a backend resource that has key-based auth disabled.

Delete incoming auth headers before forwarding and use APIM managed identity for the backend call.

### Policy Editor Error Around `forward-request`

`<forward-request>` belongs in the `<backend>` section, not `<inbound>`.

Correct shape:

```xml
<backend>
  <forward-request timeout="60" />
</backend>
```

### Junior Still Uses the Wrong Auth Mode

Check these settings carefully:

1. `junior.azureOpenAI.provider`
2. `junior.azureOpenAI.apimBaseUrl`
3. `junior.azureOpenAI.authMode`
4. `junior.azureOpenAI.bearerTokenSource`
5. `junior.azureOpenAI.authScopes`

The `Junior` output channel logs the resolved local auth mode and safe bearer-token claims for bearer flows.

## Working Pattern Summary

For this repo, the working local APIM setup ended up looking like this:

1. `foundryapi` for key mode with `Subscription required = On`
2. `foundryapi-bearer` for bearer mode with `Subscription required = Off`
3. both APIs forward to the backend AI resource using APIM managed identity
4. Junior local mode points `junior.azureOpenAI.apimBaseUrl` at the desired suffix
5. chat and inline completions both use that same local APIM client configuration