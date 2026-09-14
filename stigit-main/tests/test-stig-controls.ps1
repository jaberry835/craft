[CmdletBinding()]
param(
    [string]$BaselinePath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'stig\baselines\win11.json'),
    [string]$OverlayPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'stig\overlays\org-password-policy.json'),
    [string]$ExceptionsPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'stig\exceptions\win11.exceptions.json')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Read-Json {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Missing required JSON file: $Path"
    }
    return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
}

function Assert-Property {
    param($Object, [string]$Name, [string]$Context)
    if (-not ($Object.PSObject.Properties.Name -contains $Name)) {
        throw "$Context is missing property '$Name'"
    }
}

$baseline = Read-Json -Path $BaselinePath
$overlay = Read-Json -Path $OverlayPath
$exceptions = Read-Json -Path $ExceptionsPath

Assert-Property -Object $baseline -Name 'metadata' -Context 'baseline'
Assert-Property -Object $baseline -Name 'controls' -Context 'baseline'
Assert-Property -Object $overlay -Name 'passwordPolicy' -Context 'overlay'
Assert-Property -Object $exceptions -Name 'controls' -Context 'exceptions'

$ids = @{}
foreach ($control in $baseline.controls) {
    foreach ($required in @('id', 'title', 'type', 'severity')) {
        Assert-Property -Object $control -Name $required -Context "control $($control.id)"
    }
    if ($ids.ContainsKey($control.id)) {
        throw "Duplicate control id: $($control.id)"
    }
    $ids[$control.id] = $true
}

foreach ($exception in $exceptions.controls) {
    Assert-Property -Object $exception -Name 'id' -Context 'exception'
    Assert-Property -Object $exception -Name 'reason' -Context "exception $($exception.id)"
}

Write-Host "Source validation passed for $($baseline.controls.Count) baseline controls."
