[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [array]$Controls
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-RegistryPath {
    param([Parameter(Mandatory)][pscustomobject]$Control)
    switch ($Control.hive) {
        'HKLM' { return "Registry::HKEY_LOCAL_MACHINE\$($Control.path)" }
        'HKCU' { return "Registry::HKEY_CURRENT_USER\$($Control.path)" }
        default { throw "Unsupported registry hive '$($Control.hive)' for control $($Control.id)" }
    }
}

foreach ($control in $Controls) {
    $registryPath = Resolve-RegistryPath -Control $control
    New-Item -Path $registryPath -Force | Out-Null

    if ($control.valueType -eq 'DWord') {
        New-ItemProperty -Path $registryPath -Name $control.name -Value ([int]$control.value) -PropertyType DWord -Force | Out-Null
    }
    elseif ($control.valueType -eq 'String') {
        New-ItemProperty -Path $registryPath -Name $control.name -Value ([string]$control.value) -PropertyType String -Force | Out-Null
    }
    else {
        throw "Unsupported registry value type '$($control.valueType)' for control $($control.id)"
    }
}
