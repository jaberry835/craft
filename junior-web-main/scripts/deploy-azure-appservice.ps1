[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ResourceGroup,

  [Parameter(Mandatory = $true)]
  [string]$AppName,

  [string]$AppServicePlan,
  [string]$PackageRoot = '.deploy/package',
  [string]$LinuxRuntime = 'NODE:22-lts',
  [string]$WindowsRuntime = 'NODE|22-lts',
  [switch]$CreateIfMissing,
  [switch]$SkipBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
  throw 'Required command not found: az'
}

if (-not $SkipBuild -and -not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw 'Required command not found: npm'
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

      throw "Azure CLI needs a fresh MFA/claims-challenge login before deployment. Run this, complete the sign-in, then rerun the deploy:`n$loginCommand"
    }

    Write-Error $joinedOutput

    throw 'Azure CLI command failed.'
  }

  $output
}

function Invoke-Npm {
  param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Arguments
  )

  & npm @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw 'npm command failed.'
  }
}

function Test-IsLinuxPlan {
  param(
    [Parameter(Mandatory = $true)]
    [psobject]$Plan
  )

  $topLevelReserved = if ($Plan.PSObject.Properties['reserved']) { [bool]$Plan.reserved } else { $false }
  $nestedReserved = if ($Plan.PSObject.Properties['properties'] -and $Plan.properties -and $Plan.properties.PSObject.Properties['reserved']) {
    [bool]$Plan.properties.reserved
  } else {
    $false
  }
  $kind = if ($Plan.PSObject.Properties['kind'] -and $Plan.kind) {
    [string]$Plan.kind
  } elseif ($Plan.PSObject.Properties['properties'] -and $Plan.properties -and $Plan.properties.PSObject.Properties['kind']) {
    [string]$Plan.properties.kind
  } else {
    ''
  }

  return $topLevelReserved -or $nestedReserved -or ($kind -match 'linux')
}

function Resolve-PlanResourceId {
  param(
    [Parameter(Mandatory = $true)]
    [psobject]$WebApp
  )

  if ($WebApp.PSObject.Properties['serverFarmId'] -and $WebApp.serverFarmId) {
    return [string]$WebApp.serverFarmId
  }

  if ($WebApp.PSObject.Properties['appServicePlanId'] -and $WebApp.appServicePlanId) {
    return [string]$WebApp.appServicePlanId
  }

  if ($WebApp.PSObject.Properties['properties'] -and $WebApp.properties) {
    if ($WebApp.properties.PSObject.Properties['serverFarmId'] -and $WebApp.properties.serverFarmId) {
      return [string]$WebApp.properties.serverFarmId
    }

    if ($WebApp.properties.PSObject.Properties['appServicePlanId'] -and $WebApp.properties.appServicePlanId) {
      return [string]$WebApp.properties.appServicePlanId
    }
  }

  return $null
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$resolvedPackageRoot = if ([System.IO.Path]::IsPathRooted($PackageRoot)) { $PackageRoot } else { Join-Path $repoRoot $PackageRoot }

if (-not $SkipBuild) {
  Write-Host 'Building deployable package...'
  Push-Location $repoRoot
  try {
    Invoke-Npm run build:deploy
  } finally {
    Pop-Location
  }
}

if (-not (Test-Path $resolvedPackageRoot)) {
  throw "Deployment package folder not found: $resolvedPackageRoot"
}

$appInfo = $null
$appExists = $true
try {
  $appInfo = Invoke-AzCli webapp show --resource-group $ResourceGroup --name $AppName --output json | ConvertFrom-Json
} catch {
  $appExists = $false
}

if (-not $appExists) {
  if (-not $CreateIfMissing) {
    throw 'The target web app does not exist. Create it first, or rerun with -CreateIfMissing -AppServicePlan <existing-plan-name>.'
  }

  if (-not $AppServicePlan) {
    throw 'Provide -AppServicePlan when using -CreateIfMissing.'
  }

  Write-Host "Creating web app '$AppName' in existing plan '$AppServicePlan'..."
  $planInfo = Invoke-AzCli appservice plan show --resource-group $ResourceGroup --name $AppServicePlan --output json | ConvertFrom-Json
  if (Test-IsLinuxPlan -Plan $planInfo) {
    Invoke-AzCli webapp create --resource-group $ResourceGroup --plan $AppServicePlan --name $AppName --runtime $LinuxRuntime --output table
    Invoke-AzCli webapp config set --resource-group $ResourceGroup --name $AppName --startup-file 'npm start' --output table
  } else {
    Invoke-AzCli webapp create --resource-group $ResourceGroup --plan $AppServicePlan --name $AppName --runtime $WindowsRuntime --output table
  }

  $appInfo = Invoke-AzCli webapp show --resource-group $ResourceGroup --name $AppName --output json | ConvertFrom-Json
}

if ($CreateIfMissing) {
  $planResourceId = Resolve-PlanResourceId -WebApp $appInfo
  $planName = if ($planResourceId) { Split-Path -Leaf $planResourceId } else { $AppServicePlan }
  if (-not $planName) {
    throw 'Unable to resolve the App Service plan for the target web app.'
  }

  $resolvedPlanInfo = Invoke-AzCli appservice plan show --resource-group $ResourceGroup --name $planName --output json | ConvertFrom-Json
  if (Test-IsLinuxPlan -Plan $resolvedPlanInfo) {
    Invoke-AzCli webapp config set --resource-group $ResourceGroup --name $AppName --startup-file 'npm start' --output table
  }
}

$zipPath = Join-Path ([System.IO.Path]::GetTempPath()) ("$AppName-deploy-$([guid]::NewGuid().ToString('N')).zip")

Write-Host 'Creating deployment zip package...'
Compress-Archive -Path (Join-Path $resolvedPackageRoot '*') -DestinationPath $zipPath -Force

Write-Host "Deploying package to '$AppName'..."
Invoke-AzCli webapp deploy --resource-group $ResourceGroup --name $AppName --src-path $zipPath --type zip --restart true --output table

$hostname = $appInfo.defaultHostName
Write-Host ''
Write-Host 'Deployment complete.'
if ($hostname) {
  Write-Host "App URL: https://$hostname"
}