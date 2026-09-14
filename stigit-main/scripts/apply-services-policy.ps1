[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [array]$Controls
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

foreach ($control in $Controls) {
    $service = Get-Service -Name $control.serviceName -ErrorAction SilentlyContinue
    if (-not $service) {
        throw "Service '$($control.serviceName)' not found for control $($control.id)"
    }

    Set-Service -Name $control.serviceName -StartupType $control.startupType
    if ($control.desiredStatus -eq 'Stopped' -and $service.Status -ne 'Stopped') {
        Stop-Service -Name $control.serviceName -Force
    }
    elseif ($control.desiredStatus -eq 'Running' -and $service.Status -ne 'Running') {
        Start-Service -Name $control.serviceName
    }
}
