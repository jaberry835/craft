# test-responses-stream.ps1 — Field Guide

A diagnostic script for verifying that an Azure OpenAI / Foundry / APIM
endpoint actually emits the SSE events the SecureChat extension needs to
render **thinking bubbles** (reasoning narration).

- Script: [test-responses-stream.ps1](test-responses-stream.ps1)
- Consuming code: [src/aoaiResponsesClient.ts](../src/aoaiResponsesClient.ts)

---

## Why this exists

The "thinking bubble" UI is driven by named SSE events on the
`/openai/v1/responses` wire API:

| Event | Drives |
|---|---|
| `response.reasoning_summary_part.added` | New bubble starts |
| `response.reasoning_summary_text.delta` | Streams text into the current bubble |
| `response.reasoning_summary_text.done` | Bubble finalized |
| `response.output_text.delta` | Final assistant answer |
| `response.function_call_arguments.delta` | Tool-call streaming |
| `response.completed` / `response.failed` | Terminal events |

If the customer reports "no bubbles," the cause is one of:

1. **APIM operation missing** — `POST /responses` not imported.
2. **APIM is buffering** — response arrives as one blob (`Content-Length`
   header) instead of chunked SSE (`Transfer-Encoding: chunked`).
3. **APIM policy strips events** — `set-body`, response-transform, or
   `xml-to-json` on the `/responses` operation.
4. **Model is not reasoning-capable** — only `gpt-5.x` and `o-series`
   emit reasoning summaries. Older `gpt-4.x` deployments will stream
   `output_text` only.
5. **Capability gating** — some preview deployments accept the
   `reasoning.summary` field but never emit the events.

This script POSTs one streaming request and prints every SSE event name
it sees, with a tally and a verdict, so you can tell the four cases apart
in seconds.

---

## Usage

```powershell
# Direct AOAI with key
.\scripts\test-responses-stream.ps1 `
    -BaseUrl 'https://contoso-aoai.openai.azure.com' `
    -Model   'o4-mini' `
    -ApiKey  $env:AOAI_KEY

# APIM in front of Foundry, key auth (BaseUrl can include /openai/v1 — it normalizes)
.\scripts\test-responses-stream.ps1 `
    -BaseUrl 'https://contoso-apim.azure-api.net/foundry-keybased/openai/v1' `
    -Model   'gpt-5.4' `
    -ApiKey  $env:APIM_KEY

# APIM bearer auth, capture raw stream for offline analysis
.\scripts\test-responses-stream.ps1 `
    -BaseUrl 'https://contoso-apim.azure-api.net/foundry' `
    -Model   'gpt-5.4' `
    -BearerToken (az account get-access-token --resource https://cognitiveservices.azure.com --query accessToken -o tsv) `
    -RawDump .\customer-trace.sse
```

### Parameters

| Param | Default | Notes |
|---|---|---|
| `-BaseUrl` | required | Any of `https://host`, `…/openai`, `…/openai/v1`, or `…/openai/v1/responses` — script normalizes |
| `-Model` | required | Must be reasoning-capable (`gpt-5.x`, `o*`) to see summary events |
| `-ApiKey` / `-BearerToken` | one required | Mutually exclusive parameter sets |
| `-ApiKeyHeader` | `api-key` | Use `Ocp-Apim-Subscription-Key` for some APIM configs |
| `-ReasoningEffort` | `medium` | `none\|minimal\|low\|medium\|high\|xhigh` |
| `-ReasoningSummary` | `auto` | `auto\|detailed` |
| `-Prompt` | classic missing-dollar puzzle | Forces non-trivial reasoning |
| `-ShowDeltas` | off | Print every delta payload (chatty) |
| `-RawDump <path>` | – | Append every raw SSE line to a file |

---

## Diagnosis matrix

Run the script and compare the response headers + event tally to the
healthy reference below.

| Symptom | Likely cause | Action |
|---|---|---|
| HTTP 404, body `Resource Not Found` | APIM API doesn't expose `POST /responses` | Confirm with `az apim api operation list` (see below). Add the operation. |
| HTTP 200, **no `event:` lines at all** | APIM is buffering OR upstream is sending JSON-only chunks | Check `Content-Type` (must be `text/event-stream`) and look for `Content-Length` instead of `Transfer-Encoding: chunked`. Disable response buffering: `<forward-request buffer-response="false"/>`. |
| HTTP 200, events flow, but **0 `reasoning_summary_*`** | Model isn't reasoning-capable, OR APIM policy is filtering events, OR `reasoning.summary` field was silently dropped | Verify deployed model is gpt-5.x / o-series. Check for `set-body` / response-transform policies on `/responses`. Re-run with `-RawDump` and inspect first chunks. |
| HTTP 200, `reasoning_summary_text.delta` count > 0 **but `with non-whitespace text` count is 0** | Upstream sends only whitespace/empty deltas → "empty thinking bubble" (no text shown, then visible reflow) | Inspect raw deltas with `-ShowDeltas -RawDump`. Likely model preview gating or APIM `set-body` rewriting. Client-side mitigation: have parser trim()-check deltas before forwarding. |
| HTTP 200, `with non-whitespace text` > 0 | Upstream is healthy ✅ | Bug is on the client side — check [src/aoaiResponsesClient.ts](../src/aoaiResponsesClient.ts) parsing/dispatch. |
| HTTP 401/403 | Wrong key/header name, or token audience mismatch | Try `-ApiKeyHeader Ocp-Apim-Subscription-Key`, or for bearer: `--resource https://cognitiveservices.azure.com`. |

### Headers to compare

| Header | Healthy | Unhealthy |
|---|---|---|
| `Content-Type` | `text/event-stream; charset=utf-8` | `application/json` |
| `Transfer-Encoding` | `chunked` | (missing) |
| `Content-Length` | (missing) | a number → APIM buffered the whole stream |

---

## Companion: confirm the APIM operation exists

```powershell
az apim api operation list `
    --resource-group AOAI `
    --service-name aoai-apim-foundry `
    --api-id foundry-keybased `
    --query "[].{method:method, urlTemplate:urlTemplate}" -o table
```

You're looking for these rows:

```
POST  /responses
GET   /responses/{response_id}
DELETE /responses/{response_id}
GET   /responses/{response_id}/input_items
```

If `POST /responses` is missing, the extension cannot use the v1 wire
API at all and will 404 before any reasoning events have a chance to
flow.

---

## Reference: a known-healthy run

Captured 2026-04-28 against
`https://aoai-apim-foundry.azure-api.net/foundry-keybased/openai/v1`
with model `gpt-5.4`.

### Response headers (key ones)

```
HTTP 200 OK
Content-Type: text/event-stream; charset=utf-8
Transfer-Encoding: chunked
x-ms-region: East US 2
x-ratelimit-key: gpt-5.4
x-ratelimit-remaining-tokens: 999922
```

### Event tally

```
response.created                                       1
response.in_progress                                   1
response.output_item.added                             2
response.output_item.done                              2
response.content_part.added                            1
response.content_part.done                             1
response.reasoning_summary_part.added                  1
response.reasoning_summary_part.done                   1
response.reasoning_summary_text.delta                 79     ← thinking bubble stream
response.reasoning_summary_text.done                   1
response.output_text.delta                           328     ← final answer stream
response.output_text.done                              1
response.completed                                     1
```

Stream finished in ~7s.

### Verdict

> ✔ Upstream IS emitting reasoning_summary events.

This is the baseline. At the customer site, capture the same metrics
(`-RawDump customer.sse`) and compare.

---

## "Empty thinking bubble" deep-dive

If the customer reports **the "Thinking" panel appears but no prose ever
shows up, then the layout jumps down a row a moment later**, that's a
distinct failure mode (Candidate C) — different from "no events at all"
or "no events of this type." It usually means the upstream is sending
`reasoning_summary_text.delta` events whose `delta` payload is an empty
string or whitespace only (`"\n\n"`, `"   "`).

The script's verdict block now breaks down summary deltas into:

```
Reasoning summary delta breakdown:
  total deltas              : 79
  with non-whitespace text  : 79     ← real prose
  whitespace-only           : 0
  empty / null              : 0
```

What to look for:

| Pattern | Meaning |
|---|---|
| `with non-whitespace text` ≈ `total` | Healthy ✅ |
| `whitespace-only` > 0 and `with non-whitespace text` = 0 | **Empty bubble bug** — upstream is sending only `\n` / `\n\n` deltas |
| `empty / null` > 0 and `with non-whitespace text` = 0 | Upstream is sending the event with `"delta": ""` or no `delta` field at all |

For the last two, also pass `-ShowDeltas` so the script prints each
delta with whitespace made visible:

```
  Δsummary: <whitespace:\n\n>
  Δsummary: <empty>
  Δsummary: <null>
```

If you confirm Candidate C, the **client-side** mitigation is a 1-line
change in [src/aoaiResponsesClient.ts](../src/aoaiResponsesClient.ts#L242):

```ts
// before
return text ? { kind: 'reasoning_summary_delta', text } : null;
// after — drop whitespace-only deltas so the panel never opens empty
return text && /\S/.test(text) ? { kind: 'reasoning_summary_delta', text } : null;
```

The **upstream-side** investigation is to check APIM for any `set-body`
or response-transform policies on `/responses` that might be rewriting
delta payloads, or to try a different model deployment (some preview
gpt-5.x SKUs accept `reasoning.summary` but never produce text).

---

## Suggested workflow at customer site

1. **Confirm operation exists** — run the `az apim api operation list`
   query above. If `POST /responses` is missing, stop here; that's the
   bug.
2. **Run the script** with the customer's BaseUrl and key/token.
3. **Check headers** — `Content-Type: text/event-stream` and
   `Transfer-Encoding: chunked` must both be present.
4. **Check the tally** for `reasoning_summary_text.delta`:
   - `> 0` → upstream is fine, bug is client-side.
   - `= 0` but other events present → model or APIM-policy issue.
   - No `event:` lines at all → APIM buffering or wrong endpoint.
5. **If unclear**, re-run with `-RawDump trace.sse` and send the file
   back to engineering.

---

## Security note

The script accepts `-ApiKey` as a plain string; avoid pasting it on the
command line in shared terminals or chat sessions (it ends up in shell
history). Prefer:

```powershell
$env:APIM_KEY = Read-Host -AsSecureString | ConvertFrom-SecureString -AsPlainText
.\scripts\test-responses-stream.ps1 -BaseUrl ... -Model ... -ApiKey $env:APIM_KEY
```

If a key is leaked (e.g. pasted into chat), rotate it in APIM
(Subscriptions blade → Regenerate primary/secondary key).
