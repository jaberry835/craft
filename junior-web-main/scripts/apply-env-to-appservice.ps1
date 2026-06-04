[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [Parameter(Mandatory = $true)]
  [string]$ResourceGroup,

  [Parameter(Mandatory = $true)]
  [string]$AppName,

  [string]$EnvFile = '.env',

  # When set, existing app settings whose keys are not in the .env file are removed.
  # Default behavior is additive: only keys in the .env file are set; other settings are preserved.
  [switch]$Replace
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
  throw 'Required command not found: az'
}

if (-not (Test-Path -LiteralPath $EnvFile)) {
  throw "Env file not found: $EnvFile"
}

function Invoke-AzCli {
  param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Arguments
  )

  $output = & az @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) {
    $joinedOutput = ($output | Out-String)
    if ($joinedOutput -match 'AADSTS50076' -or $joinedOutput -match 'claims-challenge') {
      throw "Azure CLI needs a fresh MFA/claims-challenge login. Run 'az logout; az login --use-device-code' and retry.`n$joinedOutput"
    }
    Write-Error $joinedOutput
    throw 'Azure CLI command failed.'
  }
  $output
}

function Read-EnvFile {
  param([string]$Path)

  $entries = [ordered]@{}
  $lineNumber = 0
  foreach ($rawLine in Get-Content -LiteralPath $Path) {
    $lineNumber++
    $line = $rawLine.Trim()
    if (-not $line) { continue }
    if ($line.StartsWith('#')) { continue }

    # Allow optional `export ` prefix used in shell-style env files.
    if ($line -match '^(?i)export\s+(.+)$') {
      $line = $matches[1]
    }

    $eqIndex = $line.IndexOf('=')
    if ($eqIndex -lt 1) {
      Write-Warning "Skipping malformed line ${lineNumber}: $rawLine"
      continue
    }

    $key = $line.Substring(0, $eqIndex).Trim()
    $value = $line.Substring($eqIndex + 1).Trim()

    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or
        ($value.StartsWith("'") -and $value.EndsWith("'"))) {
      $value = $value.Substring(1, $value.Length - 2)
    }

    if (-not ($key -match '^[A-Za-z_][A-Za-z0-9_]*$')) {
      Write-Warning "Skipping invalid key on line ${lineNumber}: $key"
      continue
    }

    $entries[$key] = $value
  }

  return $entries
}

$envEntries = Read-EnvFile -Path $EnvFile
if ($envEntries.Count -eq 0) {
  throw "No usable settings parsed from $EnvFile."
}

# Verify the web app exists in the target subscription.
$null = Invoke-AzCli webapp show --resource-group $ResourceGroup --name $AppName --output json

$keys = @($envEntries.Keys)
Write-Host "Applying $($keys.Count) setting(s) from $EnvFile to App Service '$AppName' in resource group '$ResourceGroup'."
foreach ($key in $keys) {
  Write-Host " - $key"
}

# Build settings file payload as a JSON object so values containing spaces,
# quotes, or special characters are passed safely. `az webapp config
# appsettings set --settings @file.json` expects {"KEY":"VALUE",...}.
$settingsObject = [ordered]@{}
foreach ($key in $keys) {
  $settingsObject[$key] = [string]$envEntries[$key]
}
$settingsJson = ConvertTo-Json -Depth 1 -InputObject $settingsObject
$settingsPath = Join-Path ([System.IO.Path]::GetTempPath()) ("appsettings-" + [Guid]::NewGuid().ToString('N') + ".json")
Set-Content -LiteralPath $settingsPath -Value $settingsJson -Encoding UTF8

try {
  if ($PSCmdlet.ShouldProcess("$AppName ($ResourceGroup)", "Apply $($keys.Count) app settings from $EnvFile")) {
    Invoke-AzCli webapp config appsettings set --resource-group $ResourceGroup --name $AppName --settings "@$settingsPath" --output table | Out-Null

    if ($Replace) {
      $existingJson = Invoke-AzCli webapp config appsettings list --resource-group $ResourceGroup --name $AppName --output json
      $existing = $existingJson | ConvertFrom-Json
      $reservedPrefixes = @('WEBSITE_', 'SCM_', 'APPSETTING_', 'DIAGNOSTICS_', 'APPLICATIONINSIGHTS_', 'APPINSIGHTS_', 'WEBSITES_')
      $toRemove = @()
      foreach ($entry in $existing) {
        $name = $entry.name
        if ($envEntries.Contains($name)) { continue }
        if ($name -eq 'NODE_ENV') { continue }
        $skip = $false
        foreach ($prefix in $reservedPrefixes) {
          if ($name.StartsWith($prefix)) { $skip = $true; break }
        }
        if ($skip) { continue }
        $toRemove += $name
      }

      if ($toRemove.Count -gt 0) {
        Write-Host "Removing $($toRemove.Count) setting(s) not present in ${EnvFile}:"
        foreach ($name in $toRemove) { Write-Host " - $name" }
        Invoke-AzCli webapp config appsettings delete --resource-group $ResourceGroup --name $AppName --setting-names @toRemove --output table | Out-Null
      }
    }

    Write-Host ''
    Write-Host 'App Service application settings updated from .env.'
  }
}
finally {
  Remove-Item -LiteralPath $settingsPath -ErrorAction SilentlyContinue
}
