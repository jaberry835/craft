[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [array]$Controls
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

foreach ($control in $Controls) {
    $params = @{}
    foreach ($property in $control.settings.PSObject.Properties) {
        $params[$property.Name] = $property.Value
    }
    if ($params.Count -gt 0) {
        Set-MpPreference @params
    }
}
