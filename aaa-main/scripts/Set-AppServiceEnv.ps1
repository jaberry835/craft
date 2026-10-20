#Requires -Version 7.2
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$SubscriptionId,

    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$ResourceGroup,

    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$AppName,

    [string]$EnvFile = (Join-Path (Split-Path -Parent $PSScriptRoot) '.env'),

    [string]$Slot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$resolvedFile = (Resolve-Path -LiteralPath $EnvFile).ProviderPath
$content = [IO.File]::ReadAllText($resolvedFile).Replace("`r`n", "`n")
$pattern = '(?m)^[ \t]*(?:export[ \t]+)?(?<name>[A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(?:"(?<double>(?:\\.|[^"\\])*)"|''(?<single>[^'']*)''|(?<bare>[^\n#]*))[ \t]*(?:#[^\n]*)?(?:\n|$)'
$assignments = [regex]::Matches($content, $pattern)
$remainder = [regex]::Replace($content, $pattern, '')
$remainder = [regex]::Replace($remainder, '(?m)^[ \t]*(?:#[^\n]*)?(?:\n|$)', '')
if ($remainder.Trim()) {
    throw 'The env file contains an invalid assignment or unsupported quoting. No settings were changed.'
}

$settings = [Collections.Generic.Dictionary[string, string]]::new([StringComparer]::Ordinal)
foreach ($assignment in $assignments) {
    $name = $assignment.Groups['name'].Value
    if ($settings.ContainsKey($name)) {
        throw "Duplicate setting '$name'. No settings were changed."
    }
    if ($assignment.Groups['double'].Success) {
        $value = $assignment.Groups['double'].Value.Replace('\n', "`n").Replace('\r', "`r").Replace('\"', '"')
    } elseif ($assignment.Groups['single'].Success) {
        $value = $assignment.Groups['single'].Value
    } else {
        $value = $assignment.Groups['bare'].Value.Trim()
        if ($value.StartsWith('"') -or $value.StartsWith("'")) {
            throw "Invalid quoted value for '$name'. No settings were changed."
        }
    }
    $settings.Add($name, $value)
}
if ($settings.Count -eq 0) {
    throw 'The env file contains no settings. No settings were changed.'
}

$target = "$ResourceGroup/$AppName"
if ($Slot) { $target += "/slots/$Slot" }
if (-not $PSCmdlet.ShouldProcess($target, "Merge $($settings.Count) env settings (including empty values); App Service may restart")) {
    return
}
if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    throw 'Azure CLI is required. Sign in with az login for the target cloud before running this script.'
}

$temporaryDirectory = Join-Path ([IO.Path]::GetTempPath()) ("aaa-appsettings-" + [guid]::NewGuid().ToString('N'))
$temporaryFile = Join-Path $temporaryDirectory 'settings.json'
try {
    $null = New-Item -ItemType Directory -Path $temporaryDirectory
    if ($IsWindows) {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
        $acl = [Security.AccessControl.DirectorySecurity]::new()
        $acl.SetOwner($identity)
        $acl.SetAccessRuleProtection($true, $false)
        $rule = [Security.AccessControl.FileSystemAccessRule]::new(
            $identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
        Set-Acl -LiteralPath $temporaryDirectory -AclObject $acl
    } else {
        [IO.File]::SetUnixFileMode($temporaryDirectory, [IO.UnixFileMode]::UserRead -bor [IO.UnixFileMode]::UserWrite -bor [IO.UnixFileMode]::UserExecute)
    }
    [IO.File]::WriteAllText($temporaryFile, ($settings | ConvertTo-Json -Depth 3), [Text.UTF8Encoding]::new($false))
    if (-not $IsWindows) {
        [IO.File]::SetUnixFileMode($temporaryFile, [IO.UnixFileMode]::UserRead -bor [IO.UnixFileMode]::UserWrite)
    }
    $arguments = @(
        'webapp', 'config', 'appsettings', 'set',
        '--subscription', $SubscriptionId,
        '--resource-group', $ResourceGroup,
        '--name', $AppName,
        '--settings', "@$temporaryFile",
        '--output', 'none',
        '--only-show-errors'
    )
    if ($Slot) { $arguments += @('--slot', $Slot) }
    # CLI diagnostics can include request bodies; never forward them to the console.
    & az @arguments *> $null
    if ($LASTEXITCODE -ne 0) {
        throw "Azure CLI failed with exit code $LASTEXITCODE. Check sign-in, subscription, resource group, app/slot name, and App Service configuration permissions. CLI output was suppressed to protect setting values."
    }
    Write-Host "Merged $($settings.Count) settings into $target. Values were not printed; unrelated settings were preserved."
} finally {
    if (Test-Path -LiteralPath $temporaryFile) { Remove-Item -LiteralPath $temporaryFile -Force }
    if (Test-Path -LiteralPath $temporaryDirectory) { Remove-Item -LiteralPath $temporaryDirectory -Force }
}
