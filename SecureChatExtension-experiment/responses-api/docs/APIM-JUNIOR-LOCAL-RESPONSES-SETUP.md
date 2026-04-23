# Junior local + APIM with the v1 Responses API

This guide describes how to point Junior's local agent at Azure AI Foundry's
new **`/openai/v1/responses`** wire API through Azure API Management (APIM).
The Responses API replaces the classic `/openai/deployments/{id}/chat/completions`
route and adds first-class support for typed reasoning events, server-side
conversation state, and a model-in-body request shape (no `api-version`
required).

> Status: experimental. Junior continues to default to the classic
> `chat-completions` wire API. Set `junior.azureOpenAI.wireApi` to
> `responses` to opt in.

## What changes vs. the classic chat-completions setup

| Aspect | `chat-completions` | `responses` |
| --- | --- | --- |
| URL pattern | `/openai/deployments/{id}/chat/completions?api-version=…` | `/openai/v1/responses` |
| Model selector | path parameter (`{deploymentId}`) | request body (`"model": "<deployment-id>"`) |
| `api-version` query | required | not used |
| Reasoning events | not surfaced | typed `response.reasoning.delta` / `response.reasoning_summary_text.delta` |
| Server-side state | n/a | `previous_response_id` chaining |
| System prompt | `role: "system"` message | `instructions` field (Junior coalesces system messages automatically) |

## APIM configuration

Configure your APIM API as follows:

- **API URL suffix**: `openai/v1`
- **Operations**: at minimum `POST /responses` (path: `/responses`)
- **Backend**: your Azure AI Foundry resource, MI-authenticated
- **Subscription required**: false (Junior authenticates with a bearer
  token via the `validate-azure-ad-token` policy)

> The OpenAI Node SDK that Junior (and Copilot CLI) uses constructs request
> URLs with `new URL('/openai/v1/responses', baseURL)`, which **strips the
> path component** of the base URL. The path must therefore be expressed as
> the API URL suffix in APIM, not appended to your `apimBaseUrl` setting in
> Junior. Set `apimBaseUrl` to the gateway host root only
> (e.g. `https://aoai-apim-foundry.azure-api.net`).

The validate-azure-ad-token / token-emit-metric policy from
[APIM-JUNIOR-LOCAL-SETUP.md](APIM-JUNIOR-LOCAL-SETUP.md) Option B works
unchanged for this API.

## Junior settings

Add the following to your VS Code `settings.json` on top of the standard
APIM bearer setup:

```jsonc
{
    "junior.azureOpenAI.wireApi": "responses",
    "junior.azureOpenAI.reasoningEffort": "high",     // minimal | low | medium | high
    "junior.azureOpenAI.reasoningSummary": "auto",    // auto | detailed | none
    "junior.azureOpenAI.useServerSideState": false    // set true to chain previousResponseId across iterations
}
```

The remaining settings (`provider`, `authMode`, `authProviderId`,
`authScopes`, `apimBaseUrl`, `deploymentId`) are identical to the
chat-completions setup. See [samples/apim-bearer.settings.json](../samples/apim-bearer.settings.json).

## What you'll see in the chat view

When `wireApi: responses` is active and the model emits reasoning events,
Junior renders a collapsible **"Thinking"** panel above each assistant
reply. The panel:

- streams reasoning / reasoning-summary chunks as they arrive,
- auto-collapses when the visible answer starts streaming,
- persists with the session transcript so it survives reloads, and
- is hidden entirely when the model emits no reasoning content.

## Troubleshooting

- **404 from APIM with "Resource not found"**: your API URL suffix
  probably isn't `openai/v1`. Verify by opening the operation's *Test*
  tab in the APIM portal — the Request URL there is ground truth.
- **400 "model is required"**: Junior's `deploymentId` setting is empty,
  so the request body has no `model`. Set it to the Foundry deployment
  name to use.
- **Empty reasoning panel**: the deployment isn't a reasoning-capable
  model, or `reasoningSummary` is `none`. Switch to a `gpt-5` /
  `o3` family deployment and set `reasoningSummary` to `auto`.
- **Want to revert?** Remove `junior.azureOpenAI.wireApi` (or set it back
  to `chat-completions`) and reload the window. The classic
  `/openai/deployments/{id}/chat/completions` path will be used again.
