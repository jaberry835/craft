[CmdletBinding()]
param(
    [string]$BaselinePath = 'C:\StigBuild\baseline.json',
    [string]$OverlayPath = 'C:\StigBuild\overlay.json',
    [string]$ExceptionsPath = 'C:\StigBuild\exceptions.json',
    [string]$ReportPath = 'C:\StigBuild\stig-validation-report.json'
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

function Resolve-RegistryPath {
    param([Parameter(Mandatory)][pscustomobject]$Control)
    switch ($Control.hive) {
        'HKLM' { return "Registry::HKEY_LOCAL_MACHINE\$($Control.path)" }
        'HKCU' { return "Registry::HKEY_CURRENT_USER\$($Control.path)" }
        default { throw "Unsupported registry hive '$($Control.hive)' for control $($Control.id)" }
    }
}

function Get-EffectivePolicyValue {
    param(
        [string]$Name,
        $BaselinePolicy,
        $OverlayPolicy
    )
    if ($OverlayPolicy -and $OverlayPolicy.PSObject.Properties.Name -contains $Name) {
        return [string]$OverlayPolicy.$Name
    }
    if ($BaselinePolicy -and $BaselinePolicy.PSObject.Properties.Name -contains $Name) {
        return [string]$BaselinePolicy.$Name
    }
    return $null
}

function Add-Result {
    param(
        [System.Collections.Generic.List[object]]$Results,
        [string]$Id,
        [string]$Type,
        [string]$Status,
        [string]$Expected,
        [string]$Actual,
        [string]$Message
    )
    $Results.Add([pscustomobject]@{
        id = $Id
        type = $Type
        status = $Status
        expected = $Expected
        actual = $Actual
        message = $Message
    })
}

$baseline = Read-JsonFile -Path $BaselinePath
$overlay = Read-JsonFile -Path $OverlayPath
$exceptions = Read-JsonFile -Path $ExceptionsPath
$exceptionMap = Get-ExceptionMap -Exceptions $exceptions
$results = [System.Collections.Generic.List[object]]::new()

foreach ($control in $baseline.controls) {
    if ($exceptionMap.ContainsKey($control.id)) {
        Add-Result -Results $results -Id $control.id -Type $control.type -Status 'Exception' -Expected '' -Actual '' -Message $exceptionMap[$control.id].reason
        continue
    }

    if ($control.type -eq 'registry') {
        $path = Resolve-RegistryPath -Control $control
        $property = Get-ItemProperty -Path $path -Name $control.name -ErrorAction Stop
        $actual = $property.PSObject.Properties[$control.name].Value
        $status = if ([string]$actual -eq [string]$control.value) { 'Pass' } else { 'Fail' }
        Add-Result -Results $results -Id $control.id -Type $control.type -Status $status -Expected ([string]$control.value) -Actual ([string]$actual) -Message $control.title
    }
    elseif ($control.type -eq 'service') {
        $service = Get-Service -Name $control.serviceName -ErrorAction Stop
        $startup = (Get-CimInstance -ClassName Win32_Service -Filter "Name='$($control.serviceName)'").StartMode
        $expected = "$($control.startupType)/$($control.desiredStatus)"
        $actual = "$startup/$($service.Status)"
        $status = if ($service.Status -eq $control.desiredStatus) { 'Pass' } else { 'Fail' }
        Add-Result -Results $results -Id $control.id -Type $control.type -Status $status -Expected $expected -Actual $actual -Message $control.title
    }
    elseif ($control.type -eq 'firewall') {
        $profile = Get-NetFirewallProfile -Profile $control.profile
        $expected = "$($control.enabled)/$($control.defaultInboundAction)/$($control.defaultOutboundAction)"
        $actual = "$($profile.Enabled)/$($profile.DefaultInboundAction)/$($profile.DefaultOutboundAction)"
        $status = if ($actual -eq $expected) { 'Pass' } else { 'Fail' }
        Add-Result -Results $results -Id $control.id -Type $control.type -Status $status -Expected $expected -Actual $actual -Message $control.title
    }
    else {
        Add-Result -Results $results -Id $control.id -Type $control.type -Status 'NotChecked' -Expected '' -Actual '' -Message 'Validation for this control type is not implemented yet.'
    }
}

$exportPath = Join-Path (Split-Path -Parent $ReportPath) 'effective-security-policy.inf'
secedit.exe /export /cfg $exportPath | Out-Host
if ($LASTEXITCODE -ne 0) {
    throw "secedit export failed with exit code $LASTEXITCODE"
}
$exportedSecurityPolicy = Get-Content -LiteralPath $exportPath

foreach ($name in @('MinimumPasswordAge', 'MaximumPasswordAge', 'MinimumPasswordLength', 'PasswordComplexity', 'PasswordHistorySize')) {
    $expected = Get-EffectivePolicyValue -Name $name -BaselinePolicy $baseline.passwordPolicy -OverlayPolicy $overlay.passwordPolicy
    if ($null -eq $expected) {
        continue
    }
    $line = $exportedSecurityPolicy | Where-Object { $_ -match "^\s*$name\s*=" } | Select-Object -First 1
    $actual = if ($line) { ($line -split '=', 2)[1].Trim() } else { '' }
    $status = if ($actual -eq $expected) { 'Pass' } else { 'Fail' }
    Add-Result -Results $results -Id "PASSWORD-$name" -Type 'passwordPolicy' -Status $status -Expected $expected -Actual $actual -Message $name
}

$report = [pscustomobject]@{
    generatedAt = (Get-Date).ToUniversalTime().ToString('o')
    baseline = $baseline.metadata
    overlay = $overlay.metadata
    results = $results
    summary = [pscustomobject]@{
        pass = ($results | Where-Object status -eq 'Pass').Count
        fail = ($results | Where-Object status -eq 'Fail').Count
        exception = ($results | Where-Object status -eq 'Exception').Count
        notChecked = ($results | Where-Object status -eq 'NotChecked').Count
    }
}

$report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $ReportPath -Encoding UTF8

if ($report.summary.fail -gt 0) {
    throw "STIG validation failed. Report written to $ReportPath"
}

Write-Host "STIG validation passed. Report written to $ReportPath"
