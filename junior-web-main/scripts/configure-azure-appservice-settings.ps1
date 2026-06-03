[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ResourceGroup,

  [Parameter(Mandatory = $true)]
  [string]$AppName,

  [string]$StartupCommand,
  [string]$NodeEnv = 'production',
  [switch]$DisableBuildDuringDeployment = $true,
  [switch]$EnableRunFromPackage = $true
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
  throw 'Required command not found: az'
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
      $tenantId = if ($joinedOutput -match '--tenant\s+"([^"]+)"') { $matches[1] } else { $null }
      $claimsChallenge = if ($joinedOutput -match '--claims-challenge\s+"([^"]+)"') { $matches[1] } else { $null }
      $loginCommand = if ($tenantId -and $claimsChallenge) {
        "az logout; az login --tenant `"$tenantId`" --use-device-code --scope `"https://management.core.windows.net//.default`" --claims-challenge `"$claimsChallenge`""
      } elseif ($tenantId) {
        "az logout; az login --tenant `"$tenantId`" --use-device-code"
      } else {
        'az logout; az login --use-device-code'
      }

      throw "Azure CLI needs a fresh MFA/claims-challenge login before applying App Service settings. Run this, complete the sign-in, then rerun the script:`n$loginCommand"
    }

    Write-Error $joinedOutput
    throw 'Azure CLI command failed.'
  }

  $output
}

$null = Invoke-AzCli webapp show --resource-group $ResourceGroup --name $AppName --output json

$settings = @("NODE_ENV=$NodeEnv")
if ($EnableRunFromPackage) {
  $settings += 'WEBSITE_RUN_FROM_PACKAGE=1'
}
if ($DisableBuildDuringDeployment) {
  $settings += 'SCM_DO_BUILD_DURING_DEPLOYMENT=false'
}

Invoke-AzCli webapp config appsettings set --resource-group $ResourceGroup --name $AppName --settings @settings --output table

if ($StartupCommand) {
  Invoke-AzCli webapp config set --resource-group $ResourceGroup --name $AppName --startup-file $StartupCommand --output table
}

Write-Host ''
Write-Host 'App Service deployment settings updated.'