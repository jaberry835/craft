[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [array]$Controls
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

foreach ($control in $Controls) {
    Set-NetFirewallProfile `
        -Profile $control.profile `
        -Enabled $control.enabled `
        -DefaultInboundAction $control.defaultInboundAction `
        -DefaultOutboundAction $control.defaultOutboundAction
}
