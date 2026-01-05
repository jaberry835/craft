# Azure App Service Deployment Script for Flask API + Angular Frontend
# PowerShell version for Windows

param(
    [string]$AppName = "",
    [string]$ResourceGroup = "",
    [string]$Location = "",
    [string]$PythonVersion = "3.13"
)

# Color functions for output
function Write-Info { param([string]$Message) Write-Host "[INFO] $Message" -ForegroundColor Blue }
function Write-Success { param([string]$Message) Write-Host "[SUCCESS] $Message" -ForegroundColor Green }
function Write-Warning { param([string]$Message) Write-Host "[WARNING] $Message" -ForegroundColor Yellow }
function Write-Error { param([string]$Message) Write-Host "[ERROR] $Message" -ForegroundColor Red }

# Function to check prerequisites
function Test-Prerequisites {
    Write-Info "Checking prerequisites..."
        
    # Check if user is logged in to Azure
    try {
        az account show --query "name" --output tsv | Out-Null
    }
    catch {
        Write-Error "You are not logged in to Azure. Please run: az login"
        exit 1
    }
        
    Write-Success "Prerequisites check passed!"
}

# Function to get deployment configuration
function Get-DeploymentConfig {
    Write-Info "Setting up InvestigatorAgent deployment configuration..."
    
    if ([string]::IsNullOrEmpty($AppName)) {
        $AppName = Read-Host "Enter your InvestigatorAgent App Service name (e.g., myapp-InvestigatorAgent)"
    }
    
    if ([string]::IsNullOrEmpty($ResourceGroup)) {
        $ResourceGroup = Read-Host "Enter your Azure Resource Group name"
    }
    
    if ([string]::IsNullOrEmpty($Location)) {
        $Location = "East US"
    }
    
    Write-Host ""
    Write-Info "InvestigatorAgent Deployment Configuration:"
    Write-Host "  App Name: $AppName"
    Write-Host "  Resource Group: $ResourceGroup"
    Write-Host "  Location: $Location"
    Write-Host "  Python Version: $PythonVersion"
    Write-Host "  Startup Command: gunicorn src.remote_agents.investigator_agent_wsgi:application"
    Write-Host ""
    Write-Host ""
    
    $confirm = Read-Host "Continue with deployment? (y/N)"
    if ($confirm -ne "y" -and $confirm -ne "Y") {
        Write-Warning "Deployment cancelled by user"
        exit 0
    }
    
    return @{
        AppName = $AppName
        ResourceGroup = $ResourceGroup
        Location = $Location
        PythonVersion = $PythonVersion
    }
}





# Function to set environment variables
function Set-EnvironmentVariables {
    param([hashtable]$Config)
    
    Write-Info "Setting environment variables..."
    
    # Set the startup command to use gunicorn with correct module path for investigator Agent
    az webapp config set `
        --name $Config.AppName `
        --resource-group $Config.ResourceGroup `
        --startup-file "gunicorn --bind 0.0.0.0:8000 --workers 1 --threads 4 --timeout 300 --keep-alive 75 --no-sendfile --max-requests 1000 --max-requests-jitter 50 --access-logfile - --error-logfile - src.remote_agents.investigator_agent_wsgi:application"
    
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Failed to set startup command, trying alternative approach..."
        # Try setting via app settings as fallback with correct module path
        az webapp config appsettings set `
            --name $Config.AppName `
            --resource-group $Config.ResourceGroup `
            --settings `
            STARTUP_COMMAND="gunicorn --bind 0.0.0.0:8000 --workers 1 --threads 4 --timeout 300 --keep-alive 75 --no-sendfile --max-requests 1000 --max-requests-jitter 50 --access-logfile - --error-logfile - src.remote_agents.investigator_agent_wsgi:application"
    }
    
    # Set Python version and build settings
    az webapp config set `
        --name $Config.AppName `
        --resource-group $Config.ResourceGroup `
        --linux-fx-version "PYTHON|$($Config.PythonVersion)"
    
    # Force Python app detection and dependency installation for investigator Agent
    az webapp config appsettings set `
        --name $Config.AppName `
        --resource-group $Config.ResourceGroup `
        --settings `
        SCM_DO_BUILD_DURING_DEPLOYMENT="true" `
        ENABLE_ORYX_BUILD="true" `
        BUILD_FLAGS="UseAppInsights=false" `
        PYTHONPATH="/home/site/wwwroot"
    
    # Set application settings based on your local .env file structure
    #Write-Info "Setting application environment variables..."
    
    # # Core Flask settings
    # az webapp config appsettings set `
    #     --name $Config.AppName `
    #     --resource-group $Config.ResourceGroup `
    #     --settings `
    #     FLASK_ENV="production" `
    #     FLASK_DEBUG="false" `
    #     LOG_LEVEL="INFO" `
    #     API_HOST="0.0.0.0" `
    #     API_PORT="8000" `
    #     MCP_SERVER_NAME="PythonAPI_MCP_Server" `
    #     MCP_SERVER_PORT="3001" `
    #     MCP_MOUNT_PATH="/mcp" `
    #     DEFAULT_USER_ID="system"
    

 
}

# Function to deploy the application
function Deploy-Application {
    param([hashtable]$Config)
    
    Write-Info "Deploying application to Azure App Service..."
    
    try {
        # Create deployment zip from PythonAPI contents (not the directory itself)
        Write-Info "Creating deployment package from PythonAPI contents..."
        $zipPath = "deploy.zip"
        $fullZipPath = Join-Path (Get-Location) $zipPath
        
        if (Test-Path $fullZipPath) {
            Remove-Item $fullZipPath -Force
        }
        
        # Create zip with contents of PythonAPI directory (not the directory itself)
        $excludePatterns = @("__pycache__", "*.pyc", ".git", ".pytest_cache", "node_modules", ".deployment")
        Write-Info "Creating deployment package (excluding: $($excludePatterns -join ', '))..."
        
        # Verify required files exist in PythonAPI directory
        if (!(Test-Path "PythonAPI\main.py")) {
            Write-Error "main.py not found in PythonAPI directory"
            exit 1
        }
        
        if (!(Test-Path "PythonAPI\requirements.txt")) {
            Write-Error "requirements.txt not found in PythonAPI directory" 
            exit 1
        }
        
        if (!(Test-Path "PythonAPI\src\remote_agents\investigator_agent_wsgi.py")) {
            Write-Error "investigator_agent_wsgi.py not found in PythonAPI directory" 
            exit 1
        }
        
        Write-Info "Including main.py, investigator_agent_wsgi.py, and requirements.txt in deployment..."
        Write-Info "Creating zip with PythonAPI contents at root level..."
        
        # Get all files and directories from PythonAPI, excluding patterns
        $pythonApiItems = Get-ChildItem -Path "PythonAPI" | Where-Object { 
            $item = $_
            # Exclude common patterns
            $shouldExclude = $excludePatterns | Where-Object { $item.Name -like "*$_*" -or $item.FullName -like "*$_*" }
            return $shouldExclude.Count -eq 0
        }
        
        Write-Info "Files to include in zip:"
        $pythonApiItems | ForEach-Object { Write-Host "  - $($_.Name)" }
        
        # Create zip directly from PythonAPI contents
        $pythonApiPath = "PythonAPI\*"
        Compress-Archive -Path $pythonApiPath -DestinationPath $fullZipPath -Force
        
        # Verify zip contents
        Write-Info "Verifying deployment zip contents..."
        if (!(Test-Path $fullZipPath)) {
            Write-Error "Zip file not found at: $fullZipPath"
            exit 1
        }
        
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $zipCheck = [System.IO.Compression.ZipFile]::OpenRead($fullZipPath)
        $zipEntries = $zipCheck.Entries | ForEach-Object { $_.FullName }
        $zipCheck.Dispose()
        
        Write-Info "Zip file contains:"
        $zipEntries | ForEach-Object { Write-Host "  - $_" }
        
        # Verify critical files are at root level  
        $requiredFiles = @("requirements.txt", "main.py", "src/remote_agents/investigator_agent_wsgi.py")
        $missingFiles = @()
        
        foreach ($file in $requiredFiles) {
            if ($zipEntries -notcontains $file) {
                $missingFiles += $file
            }
        }
        
        if ($missingFiles.Count -gt 0) {
            Write-Error "Missing required files at root level: $($missingFiles -join ', ')"
            exit 1
        }
        
        Write-Success "Zip file verification passed - all required files at root level"
        
        # Deploy using the newer az webapp deploy command
        Write-Info "Uploading application to Azure..."
        az webapp deploy `
            --name $Config.AppName `
            --resource-group $Config.ResourceGroup `
            --src-path $fullZipPath `
            --type zip `
            --async false
        
        if ($LASTEXITCODE -ne 0) {
            Write-Error "Deployment failed"
            exit 1
        }
        
        # Clean up
        if (Test-Path $fullZipPath) {
            Remove-Item $fullZipPath -Force
        }
        
        Write-Success "Application deployed successfully!"
        Write-Info "Files should now be at /home/site/wwwroot/ root level"
    }
    catch {
        Write-Error "Deployment failed: $_"
        exit 1
    }
}

# Function to show post-deployment information
function Show-DeploymentInfo {
    param([hashtable]$Config)

    Write-Info "Investigator Agent deployment completed successfully!"
    Write-Host ""
    Write-Info "Investigator Agent Information:"
    Write-Host "  App URL: https://$($Config.AppName).azurewebsites.us"
    Write-Host "  Health Check: https://$($Config.AppName).azurewebsites.us/a2a/card"
    Write-Host "  A2A Endpoint: https://$($Config.AppName).azurewebsites.us/a2a/message"
    Write-Host ""
    Write-Info "Next Steps:"
    Write-Host "1. Set your Azure service environment variables using the commands shown above"
    Write-Host "2. Monitor logs: az webapp log tail --name $($Config.AppName) --resource-group $($Config.ResourceGroup)"
    Write-Host "3. View application settings: az webapp config appsettings list --name $($Config.AppName) --resource-group $($Config.ResourceGroup)"
    Write-Host "4. Test your application at: https://$($Config.AppName).azurewebsites.us"
    Write-Host ""
    Write-Warning "Remember to configure your Azure services (OpenAI, Cosmos DB, etc.) and update the environment variables!"
}

# Main deployment function
function Main {
    Write-Host "========================================================"
    Write-Host "Investigator Agent Deployment Script"
    Write-Host "Investigator Agent Service"
    Write-Host "========================================================"
    Write-Host ""
    
    # Check prerequisites
    Test-Prerequisites
    
    # Get deployment configuration
    $config = Get-DeploymentConfig
    
    # Build Angular
    
    
    # Copy Angular files to Flask
    
    
    # Create Azure resources
    
    
    # Set environment variables
    Set-EnvironmentVariables -Config $config
    
    # Deploy application
    Deploy-Application -Config $config
    
    # Show deployment info
    Show-DeploymentInfo -Config $config
}

# Run main function
Main
