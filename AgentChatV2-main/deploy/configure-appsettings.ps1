<#
.SYNOPSIS
    Configure Azure App Service application settings for AgentChatV2
    Supports Azure Commercial, Government, and Sovereign Clouds

.DESCRIPTION
    This script configures the application settings for the App Service based on
    the target cloud environment, setting appropriate service endpoints.

.PARAMETER ResourceGroup
    The Azure Resource Group containing the App Service

.PARAMETER AppServiceName
    The name of the Azure App Service

.PARAMETER Cloud
    Target Azure cloud: AzureCloud, AzureUSGovernment, AzureChinaCloud, AzureGermanCloud

.PARAMETER TenantId
    Azure AD Tenant ID for authentication

.PARAMETER ClientId
    Azure AD Client ID for authentication

.PARAMETER CosmosAccountName
    Cosmos DB account name

.PARAMETER SearchServiceName
    Azure AI Search service name

.PARAMETER OpenAiEndpoint
    Azure OpenAI endpoint URL

.PARAMETER AppInsightsConnectionString
    Application Insights connection string (optional)

.EXAMPLE
    .\configure-appsettings.ps1 -ResourceGroup "rg-agentchat" -AppServiceName "app-agentchat-api" -Cloud "AzureUSGovernment" -TenantId "xxx" -ClientId "xxx" -CosmosAccountName "cosmos-xxx" -SearchServiceName "search-xxx" -OpenAiEndpoint "https://xxx.openai.azure.us"
#>

param(
    [Parameter(Mandatory = $true)]
    [string]$ResourceGroup,

    [Parameter(Mandatory = $true)]
    [string]$AppServiceName,

    [Parameter(Mandatory = $false)]
    [ValidateSet("AzureCloud", "AzureUSGovernment", "AzureChinaCloud", "AzureGermanCloud")]
    [string]$Cloud = "AzureUSGovernment",

    [Parameter(Mandatory = $true)]
    [string]$TenantId,

    [Parameter(Mandatory = $true)]
    [string]$ClientId,

    [Parameter(Mandatory = $false)]
    [string]$CosmosAccountName,

    [Parameter(Mandatory = $false)]
    [string]$SearchServiceName,

    [Parameter(Mandatory = $false)]
    [string]$OpenAiEndpoint,

    [Parameter(Mandatory = $false)]
    [string]$AppInsightsConnectionString
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
Write-Host "Configuring App Service Settings" -ForegroundColor Cyan
Write-Host "Target Cloud: $($cloudSettings.name)" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# Build settings hashtable
$settings = @{
    # Azure AD Configuration
    "AZURE_TENANT_ID"         = $TenantId
    "AZURE_CLIENT_ID"         = $ClientId
    "AUTHORITY_HOST"          = $cloudSettings.activeDirectoryEndpoint.TrimEnd('/')
    
    # Cloud-specific endpoints
    "AZURE_CLOUD"             = $Cloud
    "SEARCH_DNS_SUFFIX"       = $cloudSettings.searchServiceSuffix
    "COSMOS_DNS_SUFFIX"       = $cloudSettings.cosmosDbSuffix
    "OPENAI_DNS_SUFFIX"       = $cloudSettings.openAiSuffix
}

# Add service-specific settings if provided
if ($CosmosAccountName) {
    $settings["COSMOS_ENDPOINT"] = "https://$CosmosAccountName.$($cloudSettings.cosmosDbSuffix)"
    $settings["COSMOS_DATABASE"] = "agentchat"
}

if ($SearchServiceName) {
    $settings["SEARCH_ENDPOINT"] = "https://$SearchServiceName.$($cloudSettings.searchServiceSuffix)"
}

if ($OpenAiEndpoint) {
    $settings["AZURE_OPENAI_ENDPOINT"] = $OpenAiEndpoint
}

if ($AppInsightsConnectionString) {
    $settings["APPLICATIONINSIGHTS_CONNECTION_STRING"] = $AppInsightsConnectionString
}

# Convert to CLI format
$settingsArgs = @()
foreach ($key in $settings.Keys) {
    $settingsArgs += "$key=$($settings[$key])"
}

# Set Azure cloud environment
Write-Host "`nSetting Azure cloud to $Cloud..." -ForegroundColor Yellow
az cloud set --name $Cloud

# Apply settings
Write-Host "Applying application settings..." -ForegroundColor Yellow
az webapp config appsettings set `
    --resource-group $ResourceGroup `
    --name $AppServiceName `
    --settings @settingsArgs

if ($LASTEXITCODE -ne 0) {
    Write-Error "Failed to configure app settings"
    exit 1
}

Write-Host "`n========================================" -ForegroundColor Green
Write-Host "Configuration Complete!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host "`nSettings applied:" -ForegroundColor Cyan
foreach ($key in $settings.Keys) {
    if ($key -like "*SECRET*" -or $key -like "*PASSWORD*" -or $key -like "*KEY*") {
        Write-Host "  $key = ********" -ForegroundColor Gray
    }
    else {
        Write-Host "  $key = $($settings[$key])" -ForegroundColor Gray
    }
}
