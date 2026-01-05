# Azure App Service Deployment Script for React App
# This script builds the React app and deploys it to Azure App Service

param(
    [Parameter(Mandatory=$true)]
    [string]$AppName,
    
    [Parameter(Mandatory=$true)]
    [string]$ResourceGroup
)

# Color output functions
function Write-Success { param($Message) Write-Host $Message -ForegroundColor Green }
function Write-Info { param($Message) Write-Host $Message -ForegroundColor Cyan }
function Write-Warning { param($Message) Write-Host $Message -ForegroundColor Yellow }
function Write-Error { param($Message) Write-Host $Message -ForegroundColor Red }

Write-Info "Starting deployment for $AppName..."

# Step 1: Build the React app
Write-Info "Building React application..."
try {
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "Build failed" }
    Write-Success "Build completed successfully"
} catch {
    Write-Error "Failed to build React app: $_"
    exit 1
}

# Step 2: Check if logged into Azure
Write-Info "Checking Azure login status..."
$account = az account show --query "user.name" -o tsv 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Warning "Not logged into Azure. Please log in..."
    az login
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to log into Azure"
        exit 1
    }
}
Write-Success "Logged in as: $account"

# Step 3: Verify resource group exists
Write-Info "Verifying resource group exists..."
$rgExists = az group exists --name $ResourceGroup
if ($rgExists -eq "false") {
    Write-Error "Resource group '$ResourceGroup' does not exist"
    Write-Error "Please create the resource group first or check the name"
    exit 1
} else {
    Write-Success "Resource group exists"
}

# Step 4: Verify Web App exists
Write-Info "Verifying Web App exists..."
$appExists = az webapp show --name $AppName --resource-group $ResourceGroup --query "name" -o tsv 2>$null
if (-not $appExists) {
    Write-Error "Web App '$AppName' does not exist in resource group '$ResourceGroup'"
    Write-Error "Please create the Web App first or check the app name and resource group"
    exit 1
} else {
    Write-Success "Web App exists and ready for deployment"
}

# Step 5: Read environment variables from .env file
Write-Info "Reading environment variables from .env file..."
$envVars = @{}
if (Test-Path ".env") {
    Get-Content ".env" | ForEach-Object {
        if ($_ -match "^([^#][^=]+)=(.*)$") {
            $key = $matches[1].Trim()
            $value = $matches[2].Trim()
            # Remove quotes if present
            $value = $value -replace '^"(.*)"$', '$1'
            $value = $value -replace "^'(.*)'$", '$1'
            $envVars[$key] = $value
        }
    }
    Write-Success "Found $($envVars.Count) environment variables"
} else {
    Write-Warning ".env file not found. Environment variables will need to be set manually."
}

# Step 6: Set environment variables in Azure
if ($envVars.Count -gt 0) {
    Write-Info "Setting environment variables in Azure App Service..."
    $settingsArgs = @()
    foreach ($key in $envVars.Keys) {
        $settingsArgs += "$key=$($envVars[$key])"
    }
    
    az webapp config appsettings set `
        --resource-group $ResourceGroup `
        --name $AppName `
        --settings $settingsArgs
    
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to set environment variables"
        exit 1
    }
    Write-Success "Environment variables configured"
}

# Step 7: Deploy the build folder
Write-Info "Deploying build folder to Azure App Service..."

# Verify build folder exists
if (-not (Test-Path ".\build")) {
    Write-Error "Build folder does not exist. Please run 'npm run build' first."
    exit 1
}

# Create a zip file from the build folder contents
$zipPath = ".\deploy.zip"
Write-Info "Creating deployment zip from build contents..."

# Remove existing zip if it exists
if (Test-Path $zipPath) {
    Remove-Item $zipPath -Force
}

# Compress all files and subdirectories from the build folder recursively
Compress-Archive -Path ".\build\*" -DestinationPath $zipPath -Force
Write-Info "Created deployment zip with all build contents: $zipPath"

try {
    az webapp deployment source config-zip `
        --resource-group $ResourceGroup `
        --name $AppName `
        --src $zipPath
    
    if ($LASTEXITCODE -ne 0) {
        throw "Deployment failed"
    }
    Write-Success "Deployment completed successfully!"
    
    # Clean up zip file
    Remove-Item $zipPath -Force
} catch {
    Write-Error "Failed to deploy: $_"
    # Clean up zip file on error too
    if (Test-Path $zipPath) {
        Remove-Item $zipPath -Force
    }
    exit 1
}

# Step 8: Get the app URL
$appUrl = az webapp show --name $AppName --resource-group $ResourceGroup --query "defaultHostName" -o tsv
Write-Success "App deployed successfully!"
Write-Info "App URL: https://$appUrl"
Write-Info "You can also browse to: https://$appUrl"

# Optional: Open in browser
$response = Read-Host "Open app in browser? (y/n)"
if ($response -eq "y" -or $response -eq "Y") {
    Start-Process "https://$appUrl"
}
