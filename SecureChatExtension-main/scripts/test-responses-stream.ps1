<#
.SYNOPSIS
    Probe a /v1/responses endpoint to see which streaming events it actually emits.

.DESCRIPTION
    The "thinking bubble" UI in this extension is driven by SSE events of the form:
        response.reasoning_summary_text.delta
        response.reasoning_summary_text.done
        response.reasoning_summary_part.added
        response.output_text.delta
        response.function_call_arguments.delta
        response.completed / response.failed

    Some Azure OpenAI deployments, APIM facades, or "OpenAI-compatible" gateways
    silently drop reasoning summary events (or never emit them because the
    deployed model is not a reasoning model, or the deployment was provisioned
    without summary support, or APIM is buffering and re-chunking the stream).

    This script POSTs a small request with reasoning.summary='auto' and prints
    every SSE event name it sees, with a tally at the end. Use it at the
    customer site to confirm whether the upstream is capable of streaming
    narration / thinking-bubble data at all.

.PARAMETER BaseUrl
    Base URL up to (but NOT including) /openai/v1/responses.
    Examples:
        https://my-aoai.openai.azure.com
        https://my-apim.azure-api.net/foundry        (APIM passthrough)
        https://api.openai.com                       (OpenAI proper)

.PARAMETER Model
    Model / deployment name placed in the request body, e.g. "gpt-5.4",
    "o4-mini", "gpt-4.1". Must be a reasoning-capable model to see any
    reasoning_summary_* events.

.PARAMETER ApiKey
    api-key header value (Azure OpenAI key or APIM subscription key).
    Mutually exclusive with -BearerToken.

.PARAMETER BearerToken
    OAuth access token (Entra). Sent as "Authorization: Bearer ...".
    Mutually exclusive with -ApiKey.

.PARAMETER ApiKeyHeader
    Name of the API key header. Default 'api-key' (Azure OpenAI / APIM key auth).
    Use 'Ocp-Apim-Subscription-Key' if your APIM is configured that way.

.PARAMETER ReasoningEffort
    none | minimal | low | medium | high | xhigh   (default: medium)

.PARAMETER ReasoningSummary
    auto | detailed   (default: auto)

.PARAMETER Prompt
    User prompt to send. Default is a small puzzle that forces the model to
    actually reason for a few hundred ms so the summary stream is non-empty.

.PARAMETER ShowDeltas
    Print every delta payload (very chatty). Off by default — only event
    names + counts are printed.

.PARAMETER RawDump
    Path to a file. If provided, every raw SSE line is appended verbatim.
    Useful to send back to engineering for offline analysis.

.EXAMPLE
    # Direct Azure OpenAI with key
    .\test-responses-stream.ps1 `
        -BaseUrl 'https://contoso-aoai.openai.azure.com' `
        -Model 'o4-mini' `
        -ApiKey $env:AOAI_KEY

.EXAMPLE
    # APIM in front of Foundry, bearer auth
    .\test-responses-stream.ps1 `
        -BaseUrl 'https://contoso-apim.azure-api.net/foundry' `
        -Model 'gpt-5.4' `
        -BearerToken (az account get-access-token --resource https://cognitiveservices.azure.com --query accessToken -o tsv) `
        -RawDump .\responses-trace.txt
#>

[CmdletBinding(DefaultParameterSetName = 'Key')]
param(
    [Parameter(Mandatory)] [string] $BaseUrl,
    [Parameter(Mandatory)] [string] $Model,

    [Parameter(Mandatory, ParameterSetName = 'Key')]    [string] $ApiKey,
    [Parameter(Mandatory, ParameterSetName = 'Bearer')] [string] $BearerToken,

    [string] $ApiKeyHeader = 'api-key',

    [ValidateSet('none','minimal','low','medium','high','xhigh')]
    [string] $ReasoningEffort = 'medium',

    [ValidateSet('auto','detailed')]
    [string] $ReasoningSummary = 'auto',

    [string] $Prompt = 'Three friends split a $30 hotel bill ($10 each). The clerk realizes it should be $25 and gives $5 back to the bellhop, who keeps $2 and returns $1 to each friend. Each paid $9, total $27, plus $2 = $29. Where is the missing dollar? Think it through step-by-step.',

    [switch] $ShowDeltas,
    [string] $RawDump
)

$ErrorActionPreference = 'Stop'

# ── Build request ─────────────────────────────────────────────────────────
# Normalize BaseUrl so all of these forms work and produce a single canonical
# POST target ending in /openai/v1/responses (or just /responses if the user
# already pointed at the v1 root):
#   https://host                                  -> https://host/openai/v1/responses
#   https://host/foundry-keybased                 -> https://host/foundry-keybased/openai/v1/responses
#   https://host/foundry-keybased/openai          -> https://host/foundry-keybased/openai/v1/responses
#   https://host/foundry-keybased/openai/v1       -> https://host/foundry-keybased/openai/v1/responses
#   https://host/.../openai/v1/responses          -> used as-is
$normalized = $BaseUrl.TrimEnd('/')
if     ($normalized -match '/openai/v1/responses$') { $uri = $normalized }
elseif ($normalized -match '/openai/v1$')           { $uri = $normalized + '/responses' }
elseif ($normalized -match '/openai$')              { $uri = $normalized + '/v1/responses' }
else                                                { $uri = $normalized + '/openai/v1/responses' }

$bodyObj = [ordered]@{
    model       = $Model
    stream      = $true
    store       = $false
    instructions = 'You are a careful reasoner. Think before answering.'
    input = @(
        [ordered]@{
            type = 'message'
            role = 'user'
            content = @(
                [ordered]@{ type = 'input_text'; text = $Prompt }
            )
        }
    )
    reasoning = [ordered]@{
        effort  = $ReasoningEffort
        summary = $ReasoningSummary
    }
    max_output_tokens = 1200
}
$json = $bodyObj | ConvertTo-Json -Depth 8 -Compress

Write-Host "POST $uri" -ForegroundColor Cyan
Write-Host "Auth: $($PSCmdlet.ParameterSetName)  Model: $Model  effort=$ReasoningEffort summary=$ReasoningSummary" -ForegroundColor DarkGray
Write-Host ('-' * 72) -ForegroundColor DarkGray

# ── HttpClient (so we can read SSE incrementally) ─────────────────────────
Add-Type -AssemblyName System.Net.Http
$handler = [System.Net.Http.HttpClientHandler]::new()
$client  = [System.Net.Http.HttpClient]::new($handler)
$client.Timeout = [TimeSpan]::FromMinutes(5)

$req = [System.Net.Http.HttpRequestMessage]::new(
    [System.Net.Http.HttpMethod]::Post, $uri)
$req.Content = [System.Net.Http.StringContent]::new(
    $json, [System.Text.Encoding]::UTF8, 'application/json')
$req.Headers.Accept.ParseAdd('text/event-stream')

if ($PSCmdlet.ParameterSetName -eq 'Key') {
    $req.Headers.Add($ApiKeyHeader, $ApiKey)
} else {
    $req.Headers.Authorization =
        [System.Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $BearerToken)
}

$resp = $client.SendAsync(
    $req, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead
).GetAwaiter().GetResult()

$statusColor = if ($resp.IsSuccessStatusCode) { 'Green' } else { 'Red' }
Write-Host "HTTP $([int]$resp.StatusCode) $($resp.ReasonPhrase)" -ForegroundColor $statusColor
foreach ($h in $resp.Headers)        { Write-Host "  $($h.Key): $($h.Value -join ', ')" -ForegroundColor DarkGray }
foreach ($h in $resp.Content.Headers){ Write-Host "  $($h.Key): $($h.Value -join ', ')" -ForegroundColor DarkGray }
Write-Host ('-' * 72) -ForegroundColor DarkGray

if (-not $resp.IsSuccessStatusCode) {
    $err = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    Write-Host $err -ForegroundColor Red
    return
}

# ── Read SSE stream line by line ──────────────────────────────────────────
$stream = $resp.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
$reader = [System.IO.StreamReader]::new($stream)

$counts        = [ordered]@{}
$currentEvent  = $null
$summaryText   = [System.Text.StringBuilder]::new()
$outputText    = [System.Text.StringBuilder]::new()
$sawAnyEvent   = $false
# Track summary delta payload shape — the customer-site "empty thinking bubble"
# bug looks like the upstream sending whitespace-only deltas ("\n\n", "   "),
# which our client treats as truthy and renders into a pre-wrap panel.
$summaryDeltaTotal       = 0   # any reasoning_summary_text.delta event
$summaryDeltaWithText    = 0   # delta with at least one non-whitespace char
$summaryDeltaWhitespace  = 0   # delta that exists but is whitespace-only
$summaryDeltaEmpty       = 0   # delta missing or empty string
$startedAt     = Get-Date

if ($RawDump) {
    Set-Content -Path $RawDump -Value "# $((Get-Date).ToString('o'))  POST $uri`n" -Encoding utf8
}

while (-not $reader.EndOfStream) {
    $line = $reader.ReadLine()
    if ($null -eq $line) { continue }
    if ($RawDump) { Add-Content -Path $RawDump -Value $line -Encoding utf8 }

    if ($line -eq '') {
        $currentEvent = $null
        continue
    }

    if ($line.StartsWith('event:')) {
        $currentEvent = $line.Substring(6).Trim()
        $sawAnyEvent  = $true
        if (-not $counts.Contains($currentEvent)) { $counts[$currentEvent] = 0 }
        $counts[$currentEvent]++

        $color = switch -Wildcard ($currentEvent) {
            '*reasoning_summary*' { 'Magenta' }
            '*reasoning*'         { 'DarkMagenta' }
            '*output_text*'       { 'Green' }
            '*function_call*'     { 'Yellow' }
            'response.failed'     { 'Red' }
            'response.error'      { 'Red' }
            'response.completed'  { 'Cyan' }
            default               { 'Gray' }
        }
        Write-Host "event: $currentEvent" -ForegroundColor $color
        continue
    }

    if ($line.StartsWith('data:')) {
        $payload = $line.Substring(5).TrimStart()
        if ($payload -eq '[DONE]') { Write-Host 'data: [DONE]' -ForegroundColor Cyan; continue }

        # Try to extract delta text for the chatty events
        try { $obj = $payload | ConvertFrom-Json -ErrorAction Stop } catch { $obj = $null }
        if ($obj) {
            switch -Wildcard ($currentEvent) {
                'response.reasoning_summary_text.delta' {
                    $summaryDeltaTotal++
                    $d = $obj.delta
                    if ($null -eq $d -or $d -eq '') {
                        $summaryDeltaEmpty++
                    } elseif ($d -match '\S') {
                        $summaryDeltaWithText++
                        [void]$summaryText.Append($d)
                    } else {
                        $summaryDeltaWhitespace++
                        # still append so concatenated view shows the gap
                        [void]$summaryText.Append($d)
                    }
                    if ($ShowDeltas) {
                        # Render whitespace deltas visibly so they're not invisible in the trace
                        $vis = if ($null -eq $d) { '<null>' }
                               elseif ($d -eq '') { '<empty>' }
                               elseif ($d -notmatch '\S') { '<whitespace:' + ($d -replace "`n",'\n' -replace "`r",'\r' -replace "`t",'\t') + '>' }
                               else { $d }
                        Write-Host "  Δsummary: $vis" -ForegroundColor Magenta
                    }
                }
                'response.output_text.delta' {
                    if ($obj.delta) { [void]$outputText.Append($obj.delta) }
                    if ($ShowDeltas) { Write-Host "  Δtext: $($obj.delta)" -ForegroundColor DarkGreen }
                }
                'response.function_call_arguments.delta' {
                    if ($ShowDeltas) { Write-Host "  Δargs: $($obj.delta)" -ForegroundColor Yellow }
                }
                'response.failed' {
                    Write-Host ($payload) -ForegroundColor Red
                }
                'response.error' {
                    Write-Host ($payload) -ForegroundColor Red
                }
                default { }
            }
        }
    }
}

$elapsed = (Get-Date) - $startedAt

# ── Summary ───────────────────────────────────────────────────────────────
Write-Host ''
Write-Host ('=' * 72) -ForegroundColor Cyan
Write-Host ("Stream finished in {0:n1}s" -f $elapsed.TotalSeconds) -ForegroundColor Cyan
Write-Host ('=' * 72) -ForegroundColor Cyan

if (-not $sawAnyEvent) {
    Write-Host @"
NO 'event:' lines were seen in the SSE response.

That means the upstream is sending plain JSON-only chunks (the legacy
chat-completions style) or APIM is stripping/buffering the SSE. The
'thinking bubble' UI requires named events such as
'response.reasoning_summary_text.delta'. Likely fixes:
  • Confirm the endpoint really is /v1/responses (not /chat/completions).
  • In APIM, disable response buffering for this operation
    (set response-buffering="none" or use <forward-request buffer-response="false"/>).
  • Verify the deployed model is reasoning-capable (o-series, gpt-5.x).
"@ -ForegroundColor Yellow
    return
}

Write-Host 'Event tally:' -ForegroundColor Cyan
$counts.GetEnumerator() | Sort-Object Name | ForEach-Object {
    $color = if ($_.Key -like '*reasoning_summary*') { 'Magenta' }
             elseif ($_.Key -like '*reasoning*')      { 'DarkMagenta' }
             elseif ($_.Key -like '*output_text*')    { 'Green' }
             elseif ($_.Key -like '*function_call*')  { 'Yellow' }
             elseif ($_.Key -eq 'response.failed' -or $_.Key -eq 'response.error') { 'Red' }
             else { 'Gray' }
    Write-Host ("  {0,-50} {1,5}" -f $_.Key, $_.Value) -ForegroundColor $color
}

$hasSummary = $counts.Keys | Where-Object { $_ -like '*reasoning_summary*' }
Write-Host ''
if ($hasSummary) {
    Write-Host "Reasoning summary delta breakdown:" -ForegroundColor Magenta
    Write-Host ("  total deltas              : {0}" -f $summaryDeltaTotal)       -ForegroundColor Magenta
    Write-Host ("  with non-whitespace text  : {0}" -f $summaryDeltaWithText)    -ForegroundColor Magenta
    $wsColor    = if ($summaryDeltaWhitespace -gt 0) { 'Yellow' } else { 'DarkGray' }
    $emptyColor = if ($summaryDeltaEmpty      -gt 0) { 'Yellow' } else { 'DarkGray' }
    Write-Host ("  whitespace-only           : {0}" -f $summaryDeltaWhitespace)  -ForegroundColor $wsColor
    Write-Host ("  empty / null              : {0}" -f $summaryDeltaEmpty)       -ForegroundColor $emptyColor
    Write-Host ''

    if ($summaryDeltaWithText -gt 0) {
        Write-Host "✔ Upstream IS emitting reasoning_summary text." -ForegroundColor Green
        Write-Host "  Concatenated reasoning summary ($($summaryText.Length) chars):" -ForegroundColor Magenta
        Write-Host $summaryText.ToString() -ForegroundColor Magenta
    } else {
        Write-Host "⚠ Upstream emitted reasoning_summary frame events but ZERO deltas with real text." -ForegroundColor Yellow
        Write-Host @"
This matches the "empty thinking bubble" symptom: the panel opens (because
*.part.added / whitespace deltas arrive) but no visible prose ever renders.
The vertical layout 'jump' a moment later is the panel reflowing as more
empty/whitespace deltas arrive or as it auto-collapses.

Likely causes:
  1. Deployment accepted reasoning.summary but the model is not actually
     producing summary text for this prompt (some preview gpt-5.x SKUs).
  2. APIM policy is rewriting the delta payloads (e.g. set-body that
     strips or replaces `delta`). Inspect the raw stream with -RawDump.
  3. Client-side: the parser in src/aoaiResponsesClient.ts treats
     whitespace-only deltas as truthy. Consider trim()-checking before
     forwarding to the webview to avoid opening an empty panel.
"@ -ForegroundColor Yellow
    }
} else {
    Write-Host "✘ Upstream did NOT emit any reasoning_summary_* events." -ForegroundColor Red
    Write-Host @"
Possible causes (in priority order):
  1. The deployed model is not a reasoning model (only o-series and gpt-5.x
     emit summaries). Check the deployment's underlying model.
  2. APIM policy is filtering events. Check for set-body / xml-to-json /
     response transforms on the /responses operation.
  3. The 'reasoning.summary' field in the request body was rejected silently
     by an OpenAI-compatible gateway (some Foundry gateways strip unknown
     fields). Re-run with -RawDump and inspect the first few SSE chunks.
  4. The deployment was provisioned without 'reasoning_summary' capability
     (preview gating). Try a different region / model version.
"@ -ForegroundColor Yellow
}

if ($outputText.Length -gt 0) {
    Write-Host ''
    Write-Host "Final assistant text ($($outputText.Length) chars):" -ForegroundColor Green
    Write-Host $outputText.ToString() -ForegroundColor Green
}

if ($RawDump) {
    Write-Host ''
    Write-Host "Raw SSE saved to: $RawDump" -ForegroundColor DarkGray
}
