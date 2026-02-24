<#
.SYNOPSIS
    Deploy both AgentChatV2 Backend and Frontend to Azure App Service
    Supports Azure Commercial, Government, and Sovereign Clouds

.DESCRIPTION
    This script orchestrates the deployment of both backend and frontend containers
    to existing Azure App Services.

.PARAMETER ResourceGroup
    The Azure Resource Group containing the App Services

.PARAMETER BackendAppService
    The name of the existing Azure App Service for the backend

.PARAMETER FrontendAppService
    The name of the existing Azure App Service for the frontend

.PARAMETER ContainerRegistry
    The Azure Container Registry name (without suffix)

.PARAMETER Cloud
    Target Azure cloud: AzureCloud, AzureUSGovernment, AzureChinaCloud, AzureGermanCloud
    Default: AzureUSGovernment

.PARAMETER ImageTag
    Docker image tag. Default: latest

.PARAMETER BackendOnly
    Deploy only the backend

.PARAMETER FrontendOnly
    Deploy only the frontend

.EXAMPLE
    .\deploy-all.ps1 -ResourceGroup "rg-agentchat" -BackendAppService "app-agentchat-api" -FrontendAppService "app-agentchat-web" -ContainerRegistry "cracr123"
#>

param(
    [Parameter(Mandatory = $true)]
    [string]$ResourceGroup,

    [Parameter(Mandatory = $false)]
    [string]$BackendAppService,

    [Parameter(Mandatory = $false)]
    [string]$FrontendAppService,

    [Parameter(Mandatory = $true)]
    [string]$ContainerRegistry,

    [Parameter(Mandatory = $false)]
    [ValidateSet("AzureCloud", "AzureUSGovernment", "AzureChinaCloud", "AzureGermanCloud")]
    [string]$Cloud = "AzureUSGovernment",

    [Parameter(Mandatory = $false)]
    [string]$ImageTag = "latest",

    [Parameter(Mandatory = $false)]
    [switch]$BackendOnly,

    [Parameter(Mandatory = $false)]
    [switch]$FrontendOnly
)

$ErrorActionPreference = "Stop"
$scriptPath = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "AgentChatV2 Full Deployment" -ForegroundColor Cyan
Write-Host "Target Cloud: $Cloud" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# Deploy Backend
if (-not $FrontendOnly) {
    if (-not $BackendAppService) {
        Write-Error "BackendAppService parameter is required when deploying backend"
        exit 1
    }
    
    Write-Host "`n--- Deploying Backend ---" -ForegroundColor Magenta
    & "$scriptPath\deploy-backend.ps1" `
        -ResourceGroup $ResourceGroup `
        -AppServiceName $BackendAppService `
        -ContainerRegistry $ContainerRegistry `
        -Cloud $Cloud `
        -ImageTag $ImageTag
    
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Backend deployment failed"
        exit 1
    }
}

# Get backend URL for frontend configuration
$backendUrl = $null
if ($BackendAppService) {
    $backendHostname = az webapp show --resource-group $ResourceGroup --name $BackendAppService --query "defaultHostName" -o tsv
    $backendUrl = "https://$backendHostname"
    Write-Host "Backend URL detected: $backendUrl" -ForegroundColor Gray
}

# Deploy Frontend
if (-not $BackendOnly) {
    if (-not $FrontendAppService) {
        Write-Error "FrontendAppService parameter is required when deploying frontend"
        exit 1
    }
    
    Write-Host "`n--- Deploying Frontend ---" -ForegroundColor Magenta
    
    $frontendParams = @{
        ResourceGroup = $ResourceGroup
        AppServiceName = $FrontendAppService
        ContainerRegistry = $ContainerRegistry
        Cloud = $Cloud
        ImageTag = $ImageTag
    }
    
    if ($backendUrl) {
        $frontendParams.BackendUrl = $backendUrl
    }
    
    & "$scriptPath\deploy-frontend.ps1" @frontendParams
    
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Frontend deployment failed"
        exit 1
    }
}

Write-Host "`n========================================" -ForegroundColor Green
Write-Host "Full Deployment Complete!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green

if ($BackendAppService) {
    $backendHostname = az webapp show --resource-group $ResourceGroup --name $BackendAppService --query "defaultHostName" -o tsv
    Write-Host "Backend URL: https://$backendHostname" -ForegroundColor Cyan
}

if ($FrontendAppService) {
    $frontendHostname = az webapp show --resource-group $ResourceGroup --name $FrontendAppService --query "defaultHostName" -o tsv
    Write-Host "Frontend URL: https://$frontendHostname" -ForegroundColor Cyan
}
