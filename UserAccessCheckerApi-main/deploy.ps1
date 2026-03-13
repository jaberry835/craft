#Requires -Modules Az.Accounts, Az.Websites
<#
.SYNOPSIS
    Deploys the UserAccessCheckerApi to an existing Azure App Service (Python 3.12 on Linux).

.DESCRIPTION
    Zip-deploys the application code and configures the startup command.
    The App Service and Resource Group must already exist.

.PARAMETER ResourceGroupName
    Name of the Azure Resource Group containing the App Service.

.PARAMETER AppServiceName
    Name of the Azure App Service (Web App) to deploy to.
#>
param(
    [Parameter(Mandatory)]
    [string]$ResourceGroupName,

    [Parameter(Mandatory)]
    [string]$AppServiceName
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# 1. Verify Azure CLI is available and logged in
# ---------------------------------------------------------------------------
Write-Host "Checking Azure CLI..." -ForegroundColor Cyan
if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    Write-Error "Azure CLI (az) is not installed or not in PATH. Install from https://aka.ms/installazurecli"
}

$account = az account show 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "Not logged in. Running 'az login'..." -ForegroundColor Yellow
    az login
    if ($LASTEXITCODE -ne 0) { Write-Error "Azure login failed." }
}

# ---------------------------------------------------------------------------
# 2. Verify the App Service exists
# ---------------------------------------------------------------------------
Write-Host "Verifying App Service '$AppServiceName' in resource group '$ResourceGroupName'..." -ForegroundColor Cyan
az webapp show --name $AppServiceName --resource-group $ResourceGroupName --output none 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Error "App Service '$AppServiceName' not found in resource group '$ResourceGroupName'. Please create it first in the Azure Portal."
}

# ---------------------------------------------------------------------------
# 3. Enable Oryx build (so pip install -r requirements.txt runs during deploy)
# ---------------------------------------------------------------------------
Write-Host "Enabling Oryx build-during-deployment..." -ForegroundColor Cyan
az webapp config appsettings set `
    --resource-group $ResourceGroupName `
    --name $AppServiceName `
    --settings SCM_DO_BUILD_DURING_DEPLOYMENT=true `
    --output none
if ($LASTEXITCODE -ne 0) { Write-Error "Failed to set build configuration." }

# ---------------------------------------------------------------------------
# 4. Set the startup command
# ---------------------------------------------------------------------------
Write-Host "Configuring startup command..." -ForegroundColor Cyan
$startupCmd = "gunicorn --bind=0.0.0.0:8000 --timeout 120 app:app"
az webapp config set `
    --resource-group $ResourceGroupName `
    --name $AppServiceName `
    --startup-file $startupCmd `
    --output none
if ($LASTEXITCODE -ne 0) { Write-Error "Failed to set startup command." }

# ---------------------------------------------------------------------------
# 5. Create the deployment zip (exclude non-deployment files)
# ---------------------------------------------------------------------------
Write-Host "Creating deployment package..." -ForegroundColor Cyan
$projectRoot = $PSScriptRoot
$zipPath = Join-Path $env:TEMP "useraccesscheckerapi-deploy.zip"

if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

# Collect only the files needed for deployment
$filesToInclude = @(
    "app.py",
    "requirements.txt",
    "startup.txt",
    "data\__init__.py",
    "data\user_access_repository.py",
    "security\__init__.py",
    "security\token_reader.py"
)

# Build the zip using .NET to avoid issues with Compress-Archive and relative paths
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open($zipPath, 'Create')
try {
    foreach ($relativePath in $filesToInclude) {
        $fullPath = Join-Path $projectRoot $relativePath
        if (Test-Path $fullPath) {
            # Normalise to forward-slash for zip entry
            $entryName = $relativePath -replace '\\', '/'
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                $zip, $fullPath, $entryName, [System.IO.Compression.CompressionLevel]::Optimal
            ) | Out-Null
            Write-Host "  + $entryName" -ForegroundColor DarkGray
        } else {
            Write-Warning "File not found, skipping: $relativePath"
        }
    }
} finally {
    $zip.Dispose()
}

Write-Host "Package created: $zipPath" -ForegroundColor Green

# ---------------------------------------------------------------------------
# 6. Deploy via Kudu zipdeploy (triggers Oryx build → pip install)
# ---------------------------------------------------------------------------
Write-Host "Deploying to Azure App Service (Kudu zipdeploy)..." -ForegroundColor Cyan
az webapp deployment source config-zip `
    --resource-group $ResourceGroupName `
    --name $AppServiceName `
    --src $zipPath `
    --timeout 600
if ($LASTEXITCODE -ne 0) { Write-Error "Deployment failed." }

# ---------------------------------------------------------------------------
# 7. Verify
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "Deployment complete!" -ForegroundColor Green
$defaultHostname = az webapp show `
    --resource-group $ResourceGroupName `
    --name $AppServiceName `
    --query "defaultHostName" `
    --output tsv
Write-Host "App URL: https://$defaultHostname" -ForegroundColor Cyan
Write-Host "Health check: https://$defaultHostname/health" -ForegroundColor Cyan
Write-Host ""
Write-Host "Don't forget to configure Application Settings (environment variables) in the portal:" -ForegroundColor Yellow
Write-Host "  AZURE_TENANT_ID, AZURE_AUTHORITY_HOST, API_AUDIENCE" -ForegroundColor Yellow
Write-Host "  AZURE_COSMOS_DB_ENDPOINT, AZURE_COSMOS_DB_DATABASE, AZURE_COSMOS_DB_CONTAINER" -ForegroundColor Yellow
