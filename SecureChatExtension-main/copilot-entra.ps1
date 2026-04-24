param(
    [string]$TenantId = '224e1b7d-7931-4c13-bce7-79f3873f0e34',
    [string]$ApiAppId = 'aa6b2ff6-4168-4ffa-b0de-a91ef1726ac6',
    [string]$ScopeName = 'user_impersonation',
    [string]$BaseUrl = 'https://rudeaoaiapi.azure-api.net',
    [string]$Model = 'gpt-5.4',
    [string]$CopilotHome = '',
    [switch]$LaunchCopilot,
    [switch]$ClearExistingCopilotEnv
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Require-Command {
    param([Parameter(Mandatory = $true)][string]$Name)

    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command '$Name' was not found in PATH."
    }
}

function Get-Scope {
    param(
        [Parameter(Mandatory = $true)][string]$AppId,
        [Parameter(Mandatory = $true)][string]$Scope
    )

    return "api://$AppId/$Scope"
}

function Clear-CopilotEnvironment {
    Get-ChildItem Env: | Where-Object { $_.Name -like 'COPILOT_*' } | ForEach-Object {
        Remove-Item -Path ("Env:{0}" -f $_.Name) -ErrorAction SilentlyContinue
    }
}

function Ensure-CopilotHome {
    param([string]$RequestedPath)

    if ([string]::IsNullOrWhiteSpace($RequestedPath)) {
        $RequestedPath = Join-Path $env:TEMP 'copilot-byok-entra'
    }

    New-Item -ItemType Directory -Force -Path $RequestedPath | Out-Null
    return $RequestedPath
}

function Connect-AzureForScope {
    param(
        [Parameter(Mandatory = $true)][string]$Tenant,
        [Parameter(Mandatory = $true)][string]$Scope
    )

    Write-Host "Signing in to Azure for scope $Scope ..." -ForegroundColor Cyan
    az login --tenant $Tenant --scope $Scope | Out-Null
}

function Get-AccessTokenForScope {
    param([Parameter(Mandatory = $true)][string]$Scope)

    $token = az account get-access-token --scope $Scope --query accessToken -o tsv
    if ([string]::IsNullOrWhiteSpace($token)) {
        throw 'Azure CLI did not return an access token.'
    }

    return $token.Trim()
}

function Get-AccessTokenSilentOrLogin {
    param(
        [Parameter(Mandatory = $true)][string]$Tenant,
        [Parameter(Mandatory = $true)][string]$Scope
    )

    # Try silently first; az caches a refresh token (~90 days) so this usually
    # succeeds without any browser prompt. Only fall back to interactive login
    # if the cached refresh token is missing or expired.
    $token = $null
    try {
        $token = az account get-access-token --scope $Scope --query accessToken -o tsv 2>$null
    } catch {
        $token = $null
    }

    if ([string]::IsNullOrWhiteSpace($token)) {
        Connect-AzureForScope -Tenant $Tenant -Scope $Scope
        $token = Get-AccessTokenForScope -Scope $Scope
    }

    return $token.Trim()
}

Require-Command -Name 'az'
Require-Command -Name 'copilot'

if ($ClearExistingCopilotEnv) {
    Clear-CopilotEnvironment
}

$scope = Get-Scope -AppId $ApiAppId -Scope $ScopeName
$resolvedCopilotHome = Ensure-CopilotHome -RequestedPath $CopilotHome

$token = Get-AccessTokenSilentOrLogin -Tenant $TenantId -Scope $scope

$env:COPILOT_HOME = $resolvedCopilotHome
$env:COPILOT_PROVIDER_TYPE = 'azure'
$env:COPILOT_PROVIDER_BASE_URL = $BaseUrl
$env:COPILOT_MODEL = $Model
$env:COPILOT_PROVIDER_MODEL_ID = $Model
$env:COPILOT_PROVIDER_WIRE_MODEL = $Model
$env:COPILOT_PROVIDER_BEARER_TOKEN = $token
$env:COPILOT_PROVIDER_WIRE_API = 'responses'

Remove-Item Env:COPILOT_PROVIDER_API_KEY -ErrorAction SilentlyContinue
Remove-Item Env:COPILOT_PROVIDER_AZURE_API_VERSION -ErrorAction SilentlyContinue

# Stash settings on the session so the helper functions below can refresh
# without the caller re-passing every parameter.
$global:JuniorCopilotCliSession = [pscustomobject]@{
    TenantId = $TenantId
    Scope    = $scope
    Model    = $Model
    BaseUrl  = $BaseUrl
}

function Refresh-CopilotToken {
    <#
    .SYNOPSIS
    Refreshes COPILOT_PROVIDER_BEARER_TOKEN for the current shell.

    .DESCRIPTION
    Mints a new access token for the scope captured when this script was
    dot-sourced and updates the env var in place. Run this after the Copilot
    CLI starts returning 401s, then relaunch `copilot --model ...`.
    Note: an already-running copilot process will NOT pick up the new token;
    it only reads env vars at startup.
    #>
    [CmdletBinding()]
    param()

    if (-not $global:JuniorCopilotCliSession) {
        throw 'No Copilot CLI session state found. Dot-source copilot-entra.ps1 first.'
    }

    $s = $global:JuniorCopilotCliSession
    $fresh = Get-AccessTokenSilentOrLogin -Tenant $s.TenantId -Scope $s.Scope
    $env:COPILOT_PROVIDER_BEARER_TOKEN = $fresh
    Write-Host "COPILOT_PROVIDER_BEARER_TOKEN refreshed for scope $($s.Scope)." -ForegroundColor Green
}

function Start-Copilot {
    <#
    .SYNOPSIS
    Refreshes the bearer token and launches the Copilot CLI in a relaunch loop.

    .DESCRIPTION
    Each iteration: silently mint a fresh token (no prompt if az's refresh
    token is still valid), then `copilot --model <Model>`. When copilot exits,
    asks whether to refresh and relaunch. This is the smoothest workaround for
    the fact that copilot can't hot-reload its bearer mid-session.
    #>
    [CmdletBinding()]
    param(
        [string]$Model
    )

    if (-not $global:JuniorCopilotCliSession) {
        throw 'No Copilot CLI session state found. Dot-source copilot-entra.ps1 first.'
    }

    if ([string]::IsNullOrWhiteSpace($Model)) {
        $Model = $global:JuniorCopilotCliSession.Model
    }

    while ($true) {
        Refresh-CopilotToken
        Write-Host "Launching copilot --model $Model ..." -ForegroundColor Cyan
        copilot --model $Model

        Write-Host ''
        $reply = Read-Host 'Copilot exited. Refresh token and relaunch? [y/N]'
        if ($reply -notmatch '^(y|yes)$') { break }
    }
}

Write-Host ''
Write-Host 'Copilot CLI bearer-mode environment is set for this PowerShell session.' -ForegroundColor Green
Write-Host ''
Get-ChildItem Env: | Where-Object { $_.Name -like 'COPILOT_*' } | Sort-Object Name | Format-Table -AutoSize

Write-Host ''
Write-Host 'To use these variables in your current shell, dot-source this script:' -ForegroundColor Yellow
Write-Host '  . .\copilot-entra.ps1' -ForegroundColor Yellow
Write-Host ''
Write-Host 'Helper functions registered in this session:' -ForegroundColor Yellow
Write-Host '  Refresh-CopilotToken   # mint a new bearer (silent if az cache is warm)' -ForegroundColor Yellow
Write-Host '  Start-Copilot          # refresh + launch copilot, with relaunch loop on exit' -ForegroundColor Yellow

if ($LaunchCopilot) {
    Write-Host ''
    Write-Host "Launching copilot --model $Model ..." -ForegroundColor Cyan
    copilot --model $Model
}