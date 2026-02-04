<#
.SYNOPSIS
    Deploy AgentChatV2 Frontend to Azure App Service (as container or static files)
    Supports Azure Commercial, Government, and Sovereign Clouds

.DESCRIPTION
    This script builds and deploys the Angular frontend as a container to an existing Azure App Service.

.PARAMETER ResourceGroup
    The Azure Resource Group containing the App Service

.PARAMETER AppServiceName
    The name of the existing Azure App Service for the frontend

.PARAMETER ContainerRegistry
    The Azure Container Registry name (without suffix)

.PARAMETER BackendUrl
    The URL of the backend API (e.g., https://api.example.com)

.PARAMETER Cloud
    Target Azure cloud: AzureCloud, AzureUSGovernment, AzureChinaCloud, AzureGermanCloud
    Default: AzureUSGovernment

.PARAMETER ImageTag
    Docker image tag. Default: latest

.PARAMETER SkipBuild
    Skip Docker build step (use existing image)

.EXAMPLE
    .\deploy-frontend.ps1 -ResourceGroup "rg-agentchat" -AppServiceName "app-agentchat-web" -ContainerRegistry "cracr123" -BackendUrl "https://api-agentchat.azurewebsites.us"
#>

param(
    [Parameter(Mandatory = $true)]
    [string]$ResourceGroup,

    [Parameter(Mandatory = $true)]
    [string]$AppServiceName,

    [Parameter(Mandatory = $true)]
    [string]$ContainerRegistry,

    [Parameter(Mandatory = $false)]
    [string]$BackendUrl,

    [Parameter(Mandatory = $false)]
    [ValidateSet("AzureCloud", "AzureUSGovernment", "AzureChinaCloud", "AzureGermanCloud")]
    [string]$Cloud = "AzureUSGovernment",

    [Parameter(Mandatory = $false)]
    [string]$ImageTag = "latest",

    [Parameter(Mandatory = $false)]
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

# Load cloud configuration
$scriptPath = Split-Path -Parent $MyInvocation.MyCommand.Path
$cloudConfig = Get-Content -Path "$scriptPath\cloud-config.json" | ConvertFrom-Json
$cloudSettings = $cloudConfig.clouds.$Cloud

if (-not $cloudSettings) {
    Write-Error "Unknown cloud: $Cloud"
    exit 1
}

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "AgentChatV2 Frontend Deployment" -ForegroundColor Cyan
Write-Host "Target Cloud: $($cloudSettings.name)" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# Set Azure cloud environment
Write-Host "`n[1/6] Setting Azure cloud environment to $Cloud..." -ForegroundColor Yellow
az cloud set --name $Cloud
if ($LASTEXITCODE -ne 0) {
    Write-Error "Failed to set Azure cloud environment"
    exit 1
}

# Verify login
Write-Host "`n[2/6] Verifying Azure login..." -ForegroundColor Yellow
$account = az account show 2>$null | ConvertFrom-Json
if (-not $account) {
    Write-Host "Not logged in. Initiating login..." -ForegroundColor Yellow
    az login
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Azure login failed"
        exit 1
    }
}
Write-Host "Logged in as: $($account.user.name)" -ForegroundColor Green
Write-Host "Subscription: $($account.name)" -ForegroundColor Green

# Container Registry details
$acrSuffix = $cloudSettings.containerRegistrySuffix
$acrLoginServer = "$ContainerRegistry.$acrSuffix"
$imageName = "agentchatv2-frontend"
$fullImageName = "$acrLoginServer/${imageName}:$ImageTag"

# Login to ACR
Write-Host "`n[3/6] Logging into Azure Container Registry..." -ForegroundColor Yellow
az acr login --name $ContainerRegistry
if ($LASTEXITCODE -ne 0) {
    Write-Error "Failed to login to ACR: $ContainerRegistry"
    exit 1
}

# Build Docker image
if (-not $SkipBuild) {
    Write-Host "`n[4/6] Building Docker image (no-cache to ensure code changes are included)..." -ForegroundColor Yellow
    $frontendPath = Join-Path (Split-Path -Parent $scriptPath) "frontend"
    
    Push-Location $frontendPath
    try {
        # Build with backend URL if provided
        if ($BackendUrl) {
            Write-Host "  Backend URL: $BackendUrl" -ForegroundColor Gray
            docker build --no-cache -t $fullImageName --build-arg BACKEND_URL=$BackendUrl .
        } else {
            docker build --no-cache -t $fullImageName .
        }
        if ($LASTEXITCODE -ne 0) {
            Write-Error "Docker build failed"
            exit 1
        }
    }
    finally {
        Pop-Location
    }

    # Push to ACR
    Write-Host "`n[5/6] Pushing image to ACR..." -ForegroundColor Yellow
    docker push $fullImageName
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to push image to ACR"
        exit 1
    }
}
else {
    Write-Host "`n[4/6] Skipping Docker build (using existing image)..." -ForegroundColor Yellow
    Write-Host "[5/6] Skipping image push..." -ForegroundColor Yellow
}

# Configure App Service to use the container
Write-Host "`n[6/6] Configuring App Service to use container..." -ForegroundColor Yellow

# Get ACR credentials for App Service
$acrCredentials = az acr credential show --name $ContainerRegistry | ConvertFrom-Json
$acrUsername = $acrCredentials.username
$acrPassword = $acrCredentials.passwords[0].value

# Configure the web app for container
az webapp config container set `
    --resource-group $ResourceGroup `
    --name $AppServiceName `
    --container-image-name $fullImageName `
    --container-registry-url "https://$acrLoginServer" `
    --container-registry-user $acrUsername `
    --container-registry-password $acrPassword

if ($LASTEXITCODE -ne 0) {
    Write-Error "Failed to configure App Service container"
    exit 1
}

# Configure app settings
Write-Host "`nConfiguring App Service settings..." -ForegroundColor Yellow
az webapp config appsettings set `
    --resource-group $ResourceGroup `
    --name $AppServiceName `
    --settings `
        WEBSITES_PORT=80 `
        BACKEND_URL=$BackendUrl `
        DOCKER_ENABLE_CI=true

if ($LASTEXITCODE -ne 0) {
    Write-Warning "Failed to set some app settings, but deployment may still work"
}

# Restart the app
Write-Host "`nRestarting App Service..." -ForegroundColor Yellow
az webapp restart --resource-group $ResourceGroup --name $AppServiceName

# Get the app URL
$appUrl = az webapp show --resource-group $ResourceGroup --name $AppServiceName --query "defaultHostName" -o tsv

Write-Host "`n========================================" -ForegroundColor Green
Write-Host "Deployment Complete!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host "App URL: https://$appUrl" -ForegroundColor Cyan
Write-Host "Image: $fullImageName" -ForegroundColor Cyan
Write-Host "`nNote: It may take a few minutes for the container to start." -ForegroundColor Yellow
