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

Require-Command -Name 'az'
Require-Command -Name 'copilot'

if ($ClearExistingCopilotEnv) {
    Clear-CopilotEnvironment
}

$scope = Get-Scope -AppId $ApiAppId -Scope $ScopeName
$resolvedCopilotHome = Ensure-CopilotHome -RequestedPath $CopilotHome

Connect-AzureForScope -Tenant $TenantId -Scope $scope
$token = Get-AccessTokenForScope -Scope $scope

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

Write-Host ''
Write-Host 'Copilot CLI bearer-mode environment is set for this PowerShell session.' -ForegroundColor Green
Write-Host ''
Get-ChildItem Env: | Where-Object { $_.Name -like 'COPILOT_*' } | Sort-Object Name | Format-Table -AutoSize

Write-Host ''
Write-Host 'To use these variables in your current shell, dot-source this script:' -ForegroundColor Yellow
Write-Host '  . .\setup-copilot-cli-apim-entra.ps1' -ForegroundColor Yellow

if ($LaunchCopilot) {
    Write-Host ''
    Write-Host "Launching copilot --model $Model ..." -ForegroundColor Cyan
    copilot --model $Model
}