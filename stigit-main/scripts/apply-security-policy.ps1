[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [pscustomobject]$Baseline,

    [Parameter(Mandatory)]
    [pscustomobject]$Overlay,

    [Parameter(Mandatory)]
    [string]$WorkDir
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-PolicyValue {
    param(
        [string]$Name,
        $BaselinePolicy,
        $OverlayPolicy
    )

    if ($OverlayPolicy -and $OverlayPolicy.PSObject.Properties.Name -contains $Name) {
        return $OverlayPolicy.$Name
    }
    if ($BaselinePolicy -and $BaselinePolicy.PSObject.Properties.Name -contains $Name) {
        return $BaselinePolicy.$Name
    }
    return $null
}

$baselinePassword = $Baseline.passwordPolicy
$overlayPassword = $Overlay.passwordPolicy

$baselineLockout = $Baseline.accountLockoutPolicy
$overlayLockout = $Overlay.accountLockoutPolicy

$settings = [ordered]@{
    MinimumPasswordAge = Get-PolicyValue -Name 'MinimumPasswordAge' -BaselinePolicy $baselinePassword -OverlayPolicy $overlayPassword
    MaximumPasswordAge = Get-PolicyValue -Name 'MaximumPasswordAge' -BaselinePolicy $baselinePassword -OverlayPolicy $overlayPassword
    MinimumPasswordLength = Get-PolicyValue -Name 'MinimumPasswordLength' -BaselinePolicy $baselinePassword -OverlayPolicy $overlayPassword
    PasswordComplexity = Get-PolicyValue -Name 'PasswordComplexity' -BaselinePolicy $baselinePassword -OverlayPolicy $overlayPassword
    PasswordHistorySize = Get-PolicyValue -Name 'PasswordHistorySize' -BaselinePolicy $baselinePassword -OverlayPolicy $overlayPassword
    LockoutBadCount = Get-PolicyValue -Name 'LockoutBadCount' -BaselinePolicy $baselineLockout -OverlayPolicy $overlayLockout
    ResetLockoutCount = Get-PolicyValue -Name 'ResetLockoutCount' -BaselinePolicy $baselineLockout -OverlayPolicy $overlayLockout
    LockoutDuration = Get-PolicyValue -Name 'LockoutDuration' -BaselinePolicy $baselineLockout -OverlayPolicy $overlayLockout
}

$infPath = Join-Path $WorkDir 'security-policy.inf'
$lines = @(
    '[Unicode]',
    'Unicode=yes',
    '[Version]',
    'signature="$CHICAGO$"',
    'Revision=1',
    '[System Access]'
)

foreach ($entry in $settings.GetEnumerator()) {
    if ($null -ne $entry.Value) {
        $lines += "$($entry.Key) = $($entry.Value)"
    }
}

$lines | Set-Content -LiteralPath $infPath -Encoding Unicode

$dbPath = Join-Path $WorkDir 'security-policy.sdb'
secedit.exe /configure /db $dbPath /cfg $infPath /areas SECURITYPOLICY | Out-Host
if ($LASTEXITCODE -ne 0) {
    throw "secedit failed with exit code $LASTEXITCODE"
}
