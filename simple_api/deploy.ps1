# PowerShell Deployment Script for Azure App Service
# This script deploys the Python FastAPI application to an existing Azure App Service

param(
    [Parameter(Mandatory=$true)]
    [string]$AppServiceName,
    
    [Parameter(Mandatory=$true)]
    [string]$ResourceGroupName,
    
    [Parameter(Mandatory=$false)]
    [string]$SubscriptionId,
    
    [Parameter(Mandatory=$false)]
    [string]$PipIndexUrl,
    
    [Parameter(Mandatory=$false)]
    [string]$PipTrustedHost,
    
    [Parameter(Mandatory=$false)]
    [string]$BuildPath = ".\build"
)

# Colors for output
$Green = "Green"
$Red = "Red"
$Yellow = "Yellow"

Write-Host "Starting deployment to Azure App Service..." -ForegroundColor $Green

# Function to check if Azure CLI is installed
function Test-AzureCLI {
    try {
        $azVersion = az version --output tsv 2>$null
        if ($LASTEXITCODE -eq 0) {
            Write-Host "Azure CLI is installed" -ForegroundColor $Green
            return $true
        }
    }
    catch {
        Write-Host "Azure CLI is not installed. Please install it first." -ForegroundColor $Red
        return $false
    }
}

# Function to check if user is logged in to Azure
function Test-AzureLogin {
    try {
        $account = az account show --output json 2>$null | ConvertFrom-Json
        if ($account) {
            Write-Host "Logged in as: $($account.user.name)" -ForegroundColor $Green
            return $true
        }
    }
    catch {
        Write-Host "Not logged in to Azure. Please run 'az login' first." -ForegroundColor $Red
        return $false
    }
}

# Check prerequisites
if (-not (Test-AzureCLI)) {
    exit 1
}

if (-not (Test-AzureLogin)) {
    Write-Host "Please login to Azure first:" -ForegroundColor $Yellow
    Write-Host "az login" -ForegroundColor $Yellow
    exit 1
}

# Set subscription if provided
if ($SubscriptionId) {
    Write-Host "Setting subscription to: $SubscriptionId" -ForegroundColor $Yellow
    az account set --subscription $SubscriptionId
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Failed to set subscription" -ForegroundColor $Red
        exit 1
    }
}

# Create build directory
Write-Host "Preparing deployment package..." -ForegroundColor $Yellow
if (Test-Path $BuildPath) {
    Remove-Item -Recurse -Force $BuildPath
}
New-Item -ItemType Directory -Path $BuildPath | Out-Null

# Copy application files (exclude virtual environment and other unnecessary files)
$filesToCopy = @(
    "main.py",
    "requirements.txt",
    "README.md",
    "azure_openai_service.py",
    "models.py",
    "config.py"
)

$foldersToExclude = @(
    ".venv",
    "__pycache__",
    ".git",
    "build",
    ".pytest_cache",
    "*.pyc"
)

Write-Host "Copying application files..." -ForegroundColor $Yellow
foreach ($file in $filesToCopy) {
    if (Test-Path $file) {
        Copy-Item $file -Destination $BuildPath
        Write-Host "  Copied: $file" -ForegroundColor $Green
    }
}

# Create startup command for FastAPI
$startupCmd = "python -m uvicorn main:app --host 0.0.0.0 --port 8000"

# If custom pip configuration is needed, create app settings for it
$appSettings = @()
if ($PipIndexUrl) {
    $appSettings += "PIP_INDEX_URL=$PipIndexUrl"
    Write-Host "Will configure custom pip index URL: $PipIndexUrl" -ForegroundColor $Yellow
}
if ($PipTrustedHost) {
    $appSettings += "PIP_TRUSTED_HOST=$PipTrustedHost"
    Write-Host "Will configure trusted host: $PipTrustedHost" -ForegroundColor $Yellow
}

# Create a zip file for deployment
$zipPath = "$BuildPath.zip"
Write-Host "Creating deployment package: $zipPath" -ForegroundColor $Yellow

if (Test-Path $zipPath) {
    Remove-Item $zipPath
}

# Create zip file
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($BuildPath, $zipPath)

Write-Host "Deployment package created successfully" -ForegroundColor $Green

# Deploy to Azure App Service
Write-Host "Deploying to Azure App Service: $AppServiceName" -ForegroundColor $Yellow
Write-Host "Resource Group: $ResourceGroupName" -ForegroundColor $Yellow

az webapp deployment source config-zip --resource-group $ResourceGroupName --name $AppServiceName --src $zipPath

if ($LASTEXITCODE -eq 0) {
    Write-Host "Deployment completed successfully!" -ForegroundColor $Green
    Write-Host "Your app should be available at: https://$AppServiceName.azurewebsites.net" -ForegroundColor $Green
    Write-Host "Swagger UI: https://$AppServiceName.azurewebsites.net/docs" -ForegroundColor $Green
    
    # Configure startup command
    Write-Host "Configuring startup command..." -ForegroundColor $Yellow
    az webapp config set --resource-group $ResourceGroupName --name $AppServiceName --startup-file "$startupCmd"
    
    # Configure app settings for custom pip configuration if needed
    if ($appSettings.Count -gt 0) {
        Write-Host "Configuring app settings for pip configuration..." -ForegroundColor $Yellow
        $settingsString = $appSettings -join " "
        az webapp config appsettings set --resource-group $ResourceGroupName --name $AppServiceName --settings $settingsString
    }
    
    # Restart the app to apply new settings
    Write-Host "Restarting app to apply new settings..." -ForegroundColor $Yellow
    az webapp restart --resource-group $ResourceGroupName --name $AppServiceName
    
    # Cleanup
    Write-Host "Cleaning up temporary files..." -ForegroundColor $Yellow
    Remove-Item -Recurse -Force $BuildPath
    Remove-Item $zipPath
    
} else {
    Write-Host "Deployment failed!" -ForegroundColor $Red
    Write-Host "Check the deployment logs at: https://$AppServiceName.scm.azurewebsites.net/deployments" -ForegroundColor $Yellow
    exit 1
}

Write-Host "Deployment process completed!" -ForegroundColor $Green
