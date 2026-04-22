# APIM Setup for GitHub Copilot CLI BYOK with Foundry

This repo now has two focused setup guides:

1. [APIM-COPILOT-CLI-BYOK-KEY-SETUP.md](APIM-COPILOT-CLI-BYOK-KEY-SETUP.md)
2. [APIM-COPILOT-CLI-BYOK-BEARER-SETUP.md](APIM-COPILOT-CLI-BYOK-BEARER-SETUP.md)

Use the key-based guide when the client authenticates to APIM with an APIM subscription key.

Use the bearer-only guide when the client authenticates to APIM with `Authorization: Bearer ...` from Azure Entra or another external STS and APIM is responsible for validating the JWT and tracking usage by user claim.

## Shared Constraints

These constraints apply to both guides:

1. For GPT-5-class models, Copilot CLI should use the `responses` wire API.
2. The Azure BYOK provider calls `POST /openai/v1/responses`.
3. The Azure BYOK provider does not preserve extra path prefixes in `COPILOT_PROVIDER_BASE_URL`.
4. The public endpoint therefore needs to be exposed at the APIM host root as:

```text
https://<apim-host>/openai/v1/responses
```

5. If key-based auth is disabled on the Foundry resource, APIM should authenticate to the backend with managed identity.

## Shared APIM API Shape

Recommended API shape:

1. Display name: `cli-openai`
2. Name: `cli-openai`
3. API URL suffix: `openai`
4. Operation: `POST /v1/responses`
5. Backend root: `https://agent-poc-resource.services.ai.azure.com/openai`

## Shared Backend Policy Pattern

Both auth modes use the same backend pattern: APIM authenticates to Foundry with managed identity and does not forward a backend `api-key`.

Base policy shape:

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

If the backend rejects that audience, try `https://ai.azure.com` instead.