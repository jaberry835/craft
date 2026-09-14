[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [array]$Controls
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

foreach ($control in $Controls) {
    $success = if ($control.success) { 'enable' } else { 'disable' }
    $failure = if ($control.failure) { 'enable' } else { 'disable' }

    auditpol.exe /set /subcategory:"$($control.subcategory)" /success:$success /failure:$failure | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw "auditpol failed for control $($control.id) with exit code $LASTEXITCODE"
    }
}
