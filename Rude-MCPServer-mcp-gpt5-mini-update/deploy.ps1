# Simple deployment script for existing Azure App Service (PowerShell)
# This script deploys the Rude MCP Server to an existing Azure App Service

param(
    [Parameter(Mandatory=$false)]
    [string]$AppServiceName = "",  # Your existing App Service name
    
    [Parameter(Mandatory=$false)]
    [string]$ResourceGroup = "",   # Resource group containing your App Service
    
    [Parameter(Mandatory=$false)]
    [string]$SubscriptionId = ""   # Your Azure subscription ID (optional)
)

# Configuration - Update these values or pass as parameters
if (-not $AppServiceName) { $AppServiceName = "" }  # Update this
if (-not $ResourceGroup) { $ResourceGroup = "" }    # Update this
if (-not $SubscriptionId) { $SubscriptionId = "" }  # Update this (optional)

# Colors for output
$ErrorColor = "Red"
$SuccessColor = "Green"
$WarningColor = "Yellow"
$InfoColor = "Cyan"

function Write-Status {
    param([string]$Message)
    Write-Host "[INFO] $Message" -ForegroundColor $InfoColor
}

function Write-Success {
    param([string]$Message)
    Write-Host "[SUCCESS] $Message" -ForegroundColor $SuccessColor
}

function Write-Warning {
    param([string]$Message)
    Write-Host "[WARNING] $Message" -ForegroundColor $WarningColor
}

function Write-Error {
    param([string]$Message)
    Write-Host "[ERROR] $Message" -ForegroundColor $ErrorColor
}

function Check-Prerequisites {
    Write-Status "Checking prerequisites..."
    
    # Check if Azure CLI is installed
    try {
        $null = Get-Command az -ErrorAction Stop
        Write-Success "Azure CLI is available"
    }
    catch {
        Write-Error "Azure CLI is not installed. Please install it first."
        exit 1
    }
    
    # Check if Compress-Archive is available (built into PowerShell 5+)
    try {
        $null = Get-Command Compress-Archive -ErrorAction Stop
        Write-Success "Archive tools are available"
    }
    catch {
        Write-Error "Compress-Archive cmdlet not available. Please use PowerShell 5.0 or later."
        exit 1
    }
    
    Write-Success "All prerequisites are available"
}

function Validate-Config {
    if (-not $AppServiceName) {
        Write-Error "APP_SERVICE_NAME is not set. Please update the script or pass -AppServiceName parameter."
        exit 1
    }
    
    if (-not $ResourceGroup) {
        Write-Error "RESOURCE_GROUP is not set. Please update the script or pass -ResourceGroup parameter."
        exit 1
    }
    
    Write-Success "Configuration validated"
}

function Check-AzureLogin {
    Write-Status "Checking Azure CLI login status..."
    
    try {
        $account = az account show | ConvertFrom-Json
        if (-not $account) {
            throw "Not logged in"
        }
    }
    catch {
        Write-Error "Not logged in to Azure CLI. Please run 'az login' first."
        exit 1
    }
    
    # Set subscription if provided
    if ($SubscriptionId) {
        Write-Status "Setting Azure subscription to: $SubscriptionId"
        az account set --subscription $SubscriptionId
        if ($LASTEXITCODE -ne 0) {
            Write-Error "Failed to set subscription"
            exit 1
        }
    }
    
    # Display current account
    $currentAccount = az account show --query "name" -o tsv
    Write-Success "Logged in to Azure account: $currentAccount"
}

function Verify-AppService {
    Write-Status "Verifying App Service exists..."
    
    try {
        $appService = az webapp show --name $AppServiceName --resource-group $ResourceGroup | ConvertFrom-Json
        if (-not $appService) {
            throw "App Service not found"
        }
        
        $script:AppServiceUrl = $appService.defaultHostName
        Write-Success "App Service found: https://$AppServiceUrl"
    }
    catch {
        Write-Error "App Service '$AppServiceName' not found in resource group '$ResourceGroup'"
        exit 1
    }
}

function Prepare-Deployment {
    Write-Status "Preparing deployment package..."
    
    # Create deployment directory
    $timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
    $script:DeployDir = "deploy_$timestamp"
    New-Item -ItemType Directory -Path $DeployDir -Force | Out-Null
    
    # Copy application files
    Write-Status "Copying application files..."
    Copy-Item "main.py" -Destination $DeployDir
    Copy-Item "startup.py" -Destination $DeployDir
    Copy-Item "requirements.txt" -Destination $DeployDir
    
    # Copy context.py (required for shared context variables)
    if (Test-Path "context.py") {
        Copy-Item "context.py" -Destination $DeployDir
        Write-Status "Copied context.py"
    }
    else {
        Write-Error "context.py file not found - deployment will fail!"
        exit 1
    }
    
    # Copy the tools directory and all its contents
    if (Test-Path "tools") {
        Copy-Item "tools" -Destination $DeployDir -Recurse
        Write-Status "Copied tools directory"
    }
    else {
        Write-Error "Tools directory not found - deployment will fail!"
        exit 1
    }
    
    # Copy root __init__.py if it exists (helps with module imports)
    if (Test-Path "__init__.py") {
        Copy-Item "__init__.py" -Destination $DeployDir
        Write-Status "Copied root __init__.py"
    }
    
    if (Test-Path ".env") {
        Copy-Item ".env" -Destination $DeployDir
    }
    else {
        Write-Warning ".env file not found, skipping"
    }
    
    # Create zip package
    Write-Status "Creating deployment package..."
    $zipPath = "$DeployDir.zip"
    Compress-Archive -Path "$DeployDir\*" -DestinationPath $zipPath -Force
    
    Write-Success "Deployment package created: $zipPath"
}

function Configure-AppService {
    Write-Status "Configuring App Service settings..."
    
    # Set Python runtime
    Write-Status "Setting Python runtime to 3.13..."
    $runtimeVersion = "PYTHON|3.13"
    cmd /c "az webapp config set --name $AppServiceName --resource-group $ResourceGroup --linux-fx-version `"$runtimeVersion`""
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to set Python runtime"
        exit 1
    }
    
    # Set startup command
    Write-Status "Setting startup command..."
    $startupCommand = "python startup.py"
    cmd /c "az webapp config set --name $AppServiceName --resource-group $ResourceGroup --startup-file `"$startupCommand`""
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to set startup command"
        exit 1
    }
    
    # Configure app settings from .env file if it exists
    if (Test-Path ".env") {
        Write-Status "Configuring app settings from .env file..."
        
        $envSettings = @()
        Get-Content ".env" | ForEach-Object {
            $line = $_.Trim()
            # Skip comments and empty lines
            if ($line -match "^#" -or $line -eq "") {
                return
            }
            
            # Extract key=value pairs
            if ($line -match "^([^=]+)=(.*)$") {
                $key = $matches[1]
                $value = $matches[2] -replace '^"(.*)"$', '$1'  # Remove quotes
                
                Write-Status "Setting: $key"
                $envSettings += "$key=$value"
            }
        }
        
        if ($envSettings.Count -gt 0) {
            # Build settings string for cmd execution
            $settingsString = ""
            foreach ($setting in $envSettings) {
                $settingsString += " --settings `"$setting`""
            }
            cmd /c "az webapp config appsettings set --name $AppServiceName --resource-group $ResourceGroup$settingsString"
            if ($LASTEXITCODE -ne 0) {
                Write-Warning "Some app settings may have failed to apply"
            }
        }
    }
    else {
        Write-Warning ".env file not found. You may need to configure app settings manually."
    }
    
    # Set additional required settings
    Write-Status "Setting additional app settings..."
    cmd /c "az webapp config appsettings set --name $AppServiceName --resource-group $ResourceGroup --settings `"SCM_DO_BUILD_DURING_DEPLOYMENT=true`" `"ENABLE_ORYX_BUILD=true`" `"PYTHONUNBUFFERED=1`" `"PYTHONDONTWRITEBYTECODE=1`""
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to set app settings"
        exit 1
    }
    
    Write-Success "App Service configuration completed"
}

function Deploy-Application {
    Write-Status "Deploying application to Azure App Service..."
    
    $zipPath = "$DeployDir.zip"
    cmd /c "az webapp deployment source config-zip --name $AppServiceName --resource-group $ResourceGroup --src `"$zipPath`""
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Deployment failed"
        exit 1
    }
    
    Write-Success "Application deployed successfully"
}

function Verify-Deployment {
    Write-Status "Verifying deployment..."
    
    # Wait a moment for the app to start
    Start-Sleep -Seconds 10
    
    # Check health endpoint
    $healthUrl = "https://$AppServiceUrl/health"
    Write-Status "Checking health endpoint: $healthUrl"
    
    try {
        $response = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -ErrorAction Stop
        if ($response.StatusCode -eq 200) {
            Write-Success "Health check passed! Application is running."
            
            # Show MCP endpoint info
            $mcpUrl = "https://$AppServiceUrl/mcp"
            Write-Status "MCP endpoint available at: $mcpUrl"
            Write-Status "You can connect MCP clients to this URL"
        }
        else {
            Write-Warning "Health check returned status: $($response.StatusCode)"
        }
    }
    catch {
        Write-Warning "Health check failed. Check the App Service logs for details."
        Write-Status "You can view logs with: az webapp log tail --name $AppServiceName --resource-group $ResourceGroup"
    }
}

function Cleanup {
    Write-Status "Cleaning up temporary files..."
    
    # Clean up current deployment files
    if (Test-Path $DeployDir) {
        try {
            Remove-Item -Path $DeployDir -Recurse -Force
            Write-Status "Removed deployment directory: $DeployDir"
        }
        catch {
            Write-Warning "Failed to remove deployment directory: $DeployDir"
        }
    }
    
    if (Test-Path "$DeployDir.zip") {
        try {
            Remove-Item -Path "$DeployDir.zip" -Force
            Write-Status "Removed deployment package: $DeployDir.zip"
        }
        catch {
            Write-Warning "Failed to remove deployment package: $DeployDir.zip"
        }
    }
    
    # Clean up any old deployment files (deploy_* pattern)
    Write-Status "Cleaning up old deployment files..."
    $oldDeployDirs = Get-ChildItem -Path "." -Directory -Name "deploy_*" -ErrorAction SilentlyContinue
    $oldDeployZips = Get-ChildItem -Path "." -File -Name "deploy_*.zip" -ErrorAction SilentlyContinue
    
    foreach ($dir in $oldDeployDirs) {
        try {
            Remove-Item -Path $dir -Recurse -Force
            Write-Status "Removed old deployment directory: $dir"
        }
        catch {
            Write-Warning "Failed to remove old deployment directory: $dir"
        }
    }
    
    foreach ($zip in $oldDeployZips) {
        try {
            Remove-Item -Path $zip -Force
            Write-Status "Removed old deployment package: $zip"
        }
        catch {
            Write-Warning "Failed to remove old deployment package: $zip"
        }
    }
    
    Write-Success "Cleanup completed"
}

function Main {
    Write-Host "==================================" -ForegroundColor White
    Write-Host "  Rude MCP Server Deployment" -ForegroundColor White
    Write-Host "==================================" -ForegroundColor White
    Write-Host ""
    
    try {
        # Validate configuration first
        Validate-Config
        
        # Check prerequisites
        Check-Prerequisites
        
        # Check Azure login
        Check-AzureLogin
        
        # Verify App Service exists
        Verify-AppService
        
        # Prepare deployment
        Prepare-Deployment
        
        # Configure App Service
        Configure-AppService
        
        # Deploy application
        Deploy-Application
        
        # Verify deployment
        Verify-Deployment
        
        Write-Host ""
        Write-Host "==================================" -ForegroundColor White
        Write-Success "Deployment completed successfully!"
        Write-Host "==================================" -ForegroundColor White
        Write-Host ""
        Write-Host "App Service URL: https://$AppServiceUrl"
        Write-Host "Health Check: https://$AppServiceUrl/health"
        Write-Host "MCP Endpoint: https://$AppServiceUrl/mcp"
        Write-Host ""
        Write-Host "To monitor logs:"
        Write-Host "  az webapp log tail --name $AppServiceName --resource-group $ResourceGroup"
        Write-Host ""
    }
    catch {
        Write-Error "Deployment failed: $($_.Exception.Message)"
        Write-Host ""
    }
    finally {
        # Always cleanup, even if deployment failed
        Cleanup
    }
}

# Show usage if no configuration is provided
if (-not $AppServiceName -or -not $ResourceGroup) {
    Write-Host "Usage: Update the configuration section at the top of this script or use parameters:" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  .\deploy.ps1 -AppServiceName 'your-app-service-name' -ResourceGroup 'your-resource-group' [-SubscriptionId 'your-subscription-id']"
    Write-Host ""
    Write-Host "Or update the script variables directly:"
    Write-Host "  `$AppServiceName = 'your-app-service-name'"
    Write-Host "  `$ResourceGroup = 'your-resource-group'"
    Write-Host "  `$SubscriptionId = 'your-subscription-id'  # Optional"
    Write-Host ""
    exit 1
}

# Run main function
Main
