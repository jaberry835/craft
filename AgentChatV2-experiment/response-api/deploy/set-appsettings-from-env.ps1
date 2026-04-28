<#
.SYNOPSIS
    Set Azure App Service application settings from a local .env file
    Supports Azure Commercial, Government, and Sovereign Clouds

.DESCRIPTION
    This script reads environment variables from a .env file and sets them
    as application settings on an Azure App Service.

.PARAMETER ResourceGroup
    The Azure Resource Group containing the App Service

.PARAMETER AppServiceName
    The name of the Azure App Service

.PARAMETER EnvFile
    Path to the .env file. Default: ../backend/.env

.PARAMETER Cloud
    Target Azure cloud: AzureCloud, AzureUSGovernment, AzureChinaCloud, AzureGermanCloud

.PARAMETER McpServerEndpoint
    Override the MCP_SERVER_ENDPOINT value from .env. Use this to set the production MCP server URL.

.PARAMETER BackendUrl
    Override the BACKEND_URL value from .env. This is the deployed backend URL for A2A agent communication.
    Example: https://app-agentchat-api.azurewebsites.us

.PARAMETER ExcludePatterns
    Patterns to exclude from upload (e.g., secrets you don't want in App Service)

.EXAMPLE
    .\set-appsettings-from-env.ps1 -ResourceGroup "rg-agentchat" -AppServiceName "app-agentchat-api"

.EXAMPLE
    .\set-appsettings-from-env.ps1 -ResourceGroup "rg-agentchat" -AppServiceName "app-agentchat-api" -McpServerEndpoint "https://mcp-prod.azurewebsites.us" -BackendUrl "https://app-agentchat-api.azurewebsites.us"

.EXAMPLE
    .\set-appsettings-from-env.ps1 -ResourceGroup "rg-agentchat" -AppServiceName "app-agentchat-api" -EnvFile "C:\path\to\.env"
#>

param(
    [Parameter(Mandatory = $true)]
    [string]$ResourceGroup,

    [Parameter(Mandatory = $true)]
    [string]$AppServiceName,

    [Parameter(Mandatory = $false)]
    [string]$EnvFile,

    [Parameter(Mandatory = $false)]
    [ValidateSet("AzureCloud", "AzureUSGovernment", "AzureChinaCloud", "AzureGermanCloud")]
    [string]$Cloud = "AzureUSGovernment",

    [Parameter(Mandatory = $false)]
    [string]$McpServerEndpoint,

    [Parameter(Mandatory = $false)]
    [string]$BackendUrl,

    [Parameter(Mandatory = $false)]
    [string[]]$ExcludePatterns = @()
)

$ErrorActionPreference = "Stop"

# Note: AZURE_TENANT_ID and AZURE_CLIENT_ID are needed for token validation
# Authentication uses managed identity in production, Azure CLI locally
$alwaysExclude = @()

# Default .env file path
$scriptPath = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $EnvFile) {
    $EnvFile = Join-Path (Split-Path -Parent $scriptPath) "backend\.env"
}

# Verify .env file exists
if (-not (Test-Path $EnvFile)) {
    Write-Error "Environment file not found: $EnvFile"
    Write-Host "Tip: Copy backend\.env.example to backend\.env and configure it first." -ForegroundColor Yellow
    exit 1
}

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Set App Service Settings from .env" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Source: $EnvFile" -ForegroundColor Gray
Write-Host "Target: $AppServiceName" -ForegroundColor Gray

# Set Azure cloud environment
Write-Host "`n[1/4] Setting Azure cloud environment to $Cloud..." -ForegroundColor Yellow
az cloud set --name $Cloud
if ($LASTEXITCODE -ne 0) {
    Write-Error "Failed to set Azure cloud environment"
    exit 1
}

# Verify login
Write-Host "`n[2/4] Verifying Azure login..." -ForegroundColor Yellow
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

# Parse .env file
Write-Host "`n[3/4] Parsing .env file..." -ForegroundColor Yellow

$settings = @{}
$skipped = @()

Get-Content $EnvFile | ForEach-Object {
    $line = $_.Trim()
    
    # Skip empty lines and comments
    if ([string]::IsNullOrWhiteSpace($line) -or $line.StartsWith("#")) {
        return
    }
    
    # Parse KEY=VALUE
    $eqIndex = $line.IndexOf("=")
    if ($eqIndex -gt 0) {
        $key = $line.Substring(0, $eqIndex).Trim()
        $value = $line.Substring($eqIndex + 1).Trim()
        
        # Remove inline comments (# followed by space or end of line)
        # Be careful not to strip # from URLs or other valid uses
        $commentIndex = $value.IndexOf("  #")  # Look for double-space + # pattern
        if ($commentIndex -eq -1) {
            $commentIndex = $value.IndexOf("`t#")  # Or tab + #
        }
        if ($commentIndex -gt 0) {
            $value = $value.Substring(0, $commentIndex).Trim()
        }
        
        # Remove quotes if present
        if (($value.StartsWith('"') -and $value.EndsWith('"')) -or 
            ($value.StartsWith("'") -and $value.EndsWith("'"))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        
        # Check exclusion patterns
        $excluded = $false
        foreach ($pattern in $ExcludePatterns) {
            if ($key -like $pattern) {
                $excluded = $true
                $skipped += $key
                break
            }
        }
        
        # Check always-excluded settings (client secrets - use managed identity instead)
        if (-not $excluded -and $alwaysExclude -contains $key) {
            $excluded = $true
            $skipped += "$key (use managed identity)"
        }
        
        # Skip empty values and placeholder values
        if (-not $excluded) {
            if ([string]::IsNullOrWhiteSpace($value) -or 
                $value -eq "your-tenant-id" -or 
                $value -eq "your-client-id" -or
                $value -eq "your-client-secret" -or
                $value -like "your-*" -or
                $value -like "*your-*-key*") {
                $skipped += "$key (placeholder/empty)"
            }
            else {
                $settings[$key] = $value
            }
        }
    }
}

Write-Host "Found $($settings.Count) settings to apply" -ForegroundColor Green
if ($skipped.Count -gt 0) {
    Write-Host "Skipped $($skipped.Count) entries: $($skipped -join ', ')" -ForegroundColor Gray
}

# Force ENVIRONMENT=production for App Service deployments
# This ensures DefaultAzureCredential (managed identity) is used instead of AzureCliCredential
if ($settings.ContainsKey("ENVIRONMENT") -and $settings["ENVIRONMENT"] -ne "production") {
    Write-Host "Overriding ENVIRONMENT from '$($settings["ENVIRONMENT"])' to 'production'" -ForegroundColor Yellow
}
$settings["ENVIRONMENT"] = "production"
Write-Host "Set ENVIRONMENT=production (required for managed identity auth)" -ForegroundColor Cyan

# Override MCP_SERVER_ENDPOINT if provided as parameter
if ($McpServerEndpoint) {
    if ($settings.ContainsKey("MCP_SERVER_ENDPOINT")) {
        Write-Host "Overriding MCP_SERVER_ENDPOINT from '$($settings["MCP_SERVER_ENDPOINT"])' to '$McpServerEndpoint'" -ForegroundColor Yellow
    } else {
        Write-Host "Setting MCP_SERVER_ENDPOINT='$McpServerEndpoint'" -ForegroundColor Yellow
    }
    $settings["MCP_SERVER_ENDPOINT"] = $McpServerEndpoint
}

# Override BACKEND_URL if provided as parameter (for A2A agent communication)
if ($BackendUrl) {
    if ($settings.ContainsKey("BACKEND_URL")) {
        Write-Host "Overriding BACKEND_URL from '$($settings["BACKEND_URL"])' to '$BackendUrl'" -ForegroundColor Yellow
    } else {
        Write-Host "Setting BACKEND_URL='$BackendUrl'" -ForegroundColor Yellow
    }
    $settings["BACKEND_URL"] = $BackendUrl
}

if ($settings.Count -eq 0) {
    Write-Warning "No valid settings found in .env file"
    exit 0
}

# Preview settings (mask sensitive values)
Write-Host "`nSettings to apply:" -ForegroundColor Yellow
$sensitivePatterns = @("*KEY*", "*SECRET*", "*PASSWORD*", "*CONNECTION_STRING*")
foreach ($key in $settings.Keys | Sort-Object) {
    $value = $settings[$key]
    $isSensitive = $false
    foreach ($pattern in $sensitivePatterns) {
        if ($key -like $pattern) {
            $isSensitive = $true
            break
        }
    }
    
    if ($isSensitive) {
        $maskedValue = if ($value.Length -gt 8) { $value.Substring(0, 4) + "****" + $value.Substring($value.Length - 4) } else { "****" }
        Write-Host "  $key = $maskedValue" -ForegroundColor Gray
    }
    else {
        # Truncate long values
        $displayValue = if ($value.Length -gt 60) { $value.Substring(0, 57) + "..." } else { $value }
        Write-Host "  $key = $displayValue" -ForegroundColor Gray
    }
}

# Confirm before applying
Write-Host ""
$confirm = Read-Host "Apply these settings to $AppServiceName? (y/N)"
if ($confirm -ne "y" -and $confirm -ne "Y") {
    Write-Host "Cancelled." -ForegroundColor Yellow
    exit 0
}

# Apply settings
Write-Host "`n[4/4] Applying settings to App Service..." -ForegroundColor Yellow

# Build the settings string for az cli
$settingsArgs = @()
foreach ($key in $settings.Keys) {
    $value = $settings[$key]
    # Escape special characters for the command line
    $settingsArgs += "$key=$value"
}

# Apply in batches to avoid command line length limits
$batchSize = 10
$batches = [Math]::Ceiling($settingsArgs.Count / $batchSize)

for ($i = 0; $i -lt $batches; $i++) {
    $start = $i * $batchSize
    $batch = $settingsArgs | Select-Object -Skip $start -First $batchSize
    
    Write-Host "  Applying batch $($i + 1) of $batches..." -ForegroundColor Gray
    
    az webapp config appsettings set `
        --resource-group $ResourceGroup `
        --name $AppServiceName `
        --settings @batch | Out-Null
    
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to apply settings batch $($i + 1)"
        exit 1
    }
}

Write-Host "`n========================================" -ForegroundColor Green
Write-Host "Settings Applied Successfully!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host "Applied $($settings.Count) settings to $AppServiceName" -ForegroundColor Cyan
Write-Host "`nNote: You may need to restart the App Service for changes to take effect:" -ForegroundColor Yellow
Write-Host "  az webapp restart -g $ResourceGroup -n $AppServiceName" -ForegroundColor Gray
