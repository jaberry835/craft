[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$BaselinePath,

    [Parameter(Mandatory)]
    [string]$OverlayPath,

    [Parameter(Mandatory)]
    [string]$ExceptionsPath,

    [string]$WorkDir = 'C:\StigBuild'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Read-JsonFile {
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "JSON file not found: $Path"
    }
    return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
}

function Get-ExceptionMap {
    param([pscustomobject]$Exceptions)
    $map = @{}
    if ($Exceptions.controls) {
        foreach ($item in $Exceptions.controls) {
            $map[$item.id] = $item
        }
    }
    return $map
}

function Test-IsExcepted {
    param(
        [string]$ControlId,
        [hashtable]$ExceptionMap
    )
    return $ExceptionMap.ContainsKey($ControlId)
}

function ConvertTo-HashtableArray {
    param($Items)
    $result = @()
    if (-not $Items) {
        return $result
    }
    foreach ($item in $Items) {
        $result += $item
    }
    return $result
}

New-Item -Path $WorkDir -ItemType Directory -Force | Out-Null

$baseline = Read-JsonFile -Path $BaselinePath
$overlay = Read-JsonFile -Path $OverlayPath
$exceptions = Read-JsonFile -Path $ExceptionsPath
$exceptionMap = Get-ExceptionMap -Exceptions $exceptions

$registryControls = ConvertTo-HashtableArray $baseline.controls | Where-Object { $_.type -eq 'registry' -and -not (Test-IsExcepted -ControlId $_.id -ExceptionMap $exceptionMap) }
$auditControls = ConvertTo-HashtableArray $baseline.controls | Where-Object { $_.type -eq 'auditPolicy' -and -not (Test-IsExcepted -ControlId $_.id -ExceptionMap $exceptionMap) }
$serviceControls = ConvertTo-HashtableArray $baseline.controls | Where-Object { $_.type -eq 'service' -and -not (Test-IsExcepted -ControlId $_.id -ExceptionMap $exceptionMap) }
$firewallControls = ConvertTo-HashtableArray $baseline.controls | Where-Object { $_.type -eq 'firewall' -and -not (Test-IsExcepted -ControlId $_.id -ExceptionMap $exceptionMap) }
$defenderControls = ConvertTo-HashtableArray $baseline.controls | Where-Object { $_.type -eq 'defender' -and -not (Test-IsExcepted -ControlId $_.id -ExceptionMap $exceptionMap) }

& (Join-Path $PSScriptRoot 'apply-security-policy.ps1') -Baseline $baseline -Overlay $overlay -WorkDir $WorkDir
& (Join-Path $PSScriptRoot 'apply-registry-policy.ps1') -Controls $registryControls
& (Join-Path $PSScriptRoot 'apply-audit-policy.ps1') -Controls $auditControls
& (Join-Path $PSScriptRoot 'apply-services-policy.ps1') -Controls $serviceControls
& (Join-Path $PSScriptRoot 'apply-firewall-policy.ps1') -Controls $firewallControls
& (Join-Path $PSScriptRoot 'apply-defender-policy.ps1') -Controls $defenderControls

Write-Host "STIG hardening completed."
