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
    
    # Check if Angular CLI is installed
    if (!(Get-Command ng -ErrorAction SilentlyContinue)) {
        Write-Error "Angular CLI is not installed. Please install it with: npm install -g @angular/cli"
        exit 1
    }
    
    # Check if Azure CLI is installed
    if (!(Get-Command az -ErrorAction SilentlyContinue)) {
        Write-Error "Azure CLI is not installed. Please install it from: https://docs.microsoft.com/en-us/cli/azure/install-azure-cli"
        exit 1
    }
    
    # Check if user is logged in to Azure
    try {
        az account show --query "name" --output tsv | Out-Null
    }
    catch {
        Write-Error "You are not logged in to Azure. Please run: az login"
        exit 1
    }
    
    # Check for running processes that might interfere with npm
    $nodeProcesses = Get-Process -Name "node" -ErrorAction SilentlyContinue
    $esbuildProcesses = Get-Process -Name "esbuild" -ErrorAction SilentlyContinue
    
    if ($nodeProcesses -or $esbuildProcesses) {
        Write-Warning "Found running Node.js or esbuild processes that might interfere with npm install."
        $response = Read-Host "Do you want to stop these processes? (y/N)"
        if ($response -eq "y" -or $response -eq "Y") {
            Write-Info "Stopping interfering processes..."
            $nodeProcesses | Stop-Process -Force -ErrorAction SilentlyContinue
            $esbuildProcesses | Stop-Process -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 2
        }
    }
    
    Write-Success "Prerequisites check passed!"
}

# Function to get deployment configuration
function Get-DeploymentConfig {
    Write-Info "Setting up deployment configuration..."
    
    if ([string]::IsNullOrEmpty($AppName)) {
        $AppName = Read-Host "Enter your Azure App Service name"
    }
    
    if ([string]::IsNullOrEmpty($ResourceGroup)) {
        $ResourceGroup = Read-Host "Enter your Azure Resource Group name"
    }
    
    Write-Host ""
    Write-Info "Deployment Configuration:"
    Write-Host "  App Name: $AppName"
    Write-Host "  Resource Group: $ResourceGroup"
    Write-Host "  Location: $Location"
    Write-Host "  Python Version: $PythonVersion"
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

# Function to build Angular application
function Build-Angular {
    Write-Info "Building Angular application..."
    
    # Check if node_modules exists and try to clean it if npm ci fails
    Write-Info "Preparing npm environment..."
    
    # First attempt: npm ci (fastest, uses existing package-lock.json)
    Write-Info "Installing npm dependencies..."
    npm ci
    
    # If npm ci fails, try alternative approaches but be more conservative
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "npm ci failed, trying alternative approaches..."
        
        # Try to kill any running node processes
        Write-Info "Stopping any running Node.js processes..."
        Get-Process -Name "node" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
        Get-Process -Name "esbuild" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
        
        # Wait a moment for processes to stop
        Start-Sleep -Seconds 2
        
        # Try npm ci again
        Write-Info "Retrying npm ci..."
        npm ci
        
        # If still failing, try npm install with force (but keep node_modules)
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "npm ci still failing, trying npm install --force..."
            npm install --force
            
            # Only as absolute last resort, offer to clean and reinstall
            if ($LASTEXITCODE -ne 0) {
                Write-Warning "npm install --force also failed."
                $cleanResponse = Read-Host "Do you want to clean node_modules and try fresh install? This will affect your local dev environment. (y/N)"
                
                if ($cleanResponse -eq "y" -or $cleanResponse -eq "Y") {
                    Write-Warning "Cleaning node_modules and trying fresh install..."
                    
                    # Remove node_modules if it exists
                    if (Test-Path "node_modules") {
                        Write-Info "Removing node_modules directory..."
                        Remove-Item "node_modules" -Recurse -Force -ErrorAction SilentlyContinue
                    }
                    
                    # Remove package-lock.json if it exists
                    if (Test-Path "package-lock.json") {
                        Write-Info "Removing package-lock.json..."
                        Remove-Item "package-lock.json" -Force -ErrorAction SilentlyContinue
                    }
                    
                    # Try npm install
                    Write-Info "Fresh npm install..."
                    npm install
                    
                    if ($LASTEXITCODE -ne 0) {
                        Write-Error "All npm install attempts failed. Please try running as Administrator or check for antivirus interference."
                        Write-Error "You can also try manually running: npm install --force"
                        exit 1
                    }
                    else {
                        Write-Warning "Fresh install succeeded, but you may need to run 'npm install' again after deployment to restore your local dev environment."
                    }
                }
                else {
                    Write-Error "Cannot proceed without npm dependencies. Please resolve npm issues manually and run the script again."
                    Write-Error "Try: 1) Run as Administrator, 2) Disable antivirus temporarily, 3) npm cache clean --force"
                    exit 1
                }
            }
        }
    }
    
    Write-Success "npm dependencies installed successfully!"
    
    # Build Angular for production
    Write-Info "Building Angular for production..."
    ng build --configuration=production
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Angular build failed"
        exit 1
    }
    
    # Check for build output in newer Angular structure
    if (Test-Path "dist\rude-chat-app\browser") {
        Write-Info "Angular build found in: dist\rude-chat-app\browser\"
    }
    elseif (Test-Path "dist\rude-chat-app") {
        Write-Info "Angular build found in: dist\rude-chat-app\"
    }
    else {
        Write-Error "Angular build failed - no dist directory found"
        exit 1
    }
    
    Write-Success "Angular build completed successfully!"
}

# Function to copy Angular files to Flask static directory
function Copy-AngularToFlask {
    Write-Info "Copying Angular files to Flask static directory..."
    
    # Create static directory in PythonAPI
    if (!(Test-Path "PythonAPI\static")) {
        New-Item -ItemType Directory -Path "PythonAPI\static" -Force | Out-Null
    }
    
    # Check for newer Angular build structure (dist/app-name/browser/)
    $angularBuildPath = ""
    if (Test-Path "dist\rude-chat-app\browser") {
        $angularBuildPath = "dist\rude-chat-app\browser\*"
        Write-Info "Using newer Angular build structure: dist\rude-chat-app\browser\"
    }
    elseif (Test-Path "dist\rude-chat-app") {
        $angularBuildPath = "dist\rude-chat-app\*"
        Write-Info "Using standard Angular build structure: dist\rude-chat-app\"
    }
    else {
        Write-Error "Angular build directory not found. Expected dist\rude-chat-app\ or dist\rude-chat-app\browser\"
        exit 1
    }
    
    # Copy Angular build files
    Copy-Item -Path $angularBuildPath -Destination "PythonAPI\static\" -Recurse -Force
    
    # Verify copy was successful
    if (!(Test-Path "PythonAPI\static\index.html")) {
        Write-Error "Failed to copy Angular files - index.html not found"
        exit 1
    }
    
    Write-Success "Angular files copied to Flask static directory!"
}

# Function to create Azure App Service resources
function New-AzureResources {
    param([hashtable]$Config)
    
    Write-Info "Creating Azure App Service resources..."
    
    # Check if resource group exists
    $rgExists = az group show --name $Config.ResourceGroup --query "name" --output tsv 2>$null
    if ([string]::IsNullOrEmpty($rgExists)) {
        Write-Info "Creating resource group: $($Config.ResourceGroup)"
        az group create --name $Config.ResourceGroup --location $Config.Location
        if ($LASTEXITCODE -ne 0) {
            Write-Error "Failed to create resource group"
            exit 1
        }
    }
    else {
        Write-Info "Resource group '$($Config.ResourceGroup)' already exists"
    }
    
    # Check if app service exists
    $appExists = az webapp show --name $Config.AppName --resource-group $Config.ResourceGroup --query "name" --output tsv 2>$null
    if ([string]::IsNullOrEmpty($appExists)) {
        Write-Info "Creating App Service: $($Config.AppName)"
        az webapp up `
            --name $Config.AppName `
            --resource-group $Config.ResourceGroup `
            --runtime "PYTHON|$($Config.PythonVersion)" `
            --location $Config.Location `
            --sku "B1"
        if ($LASTEXITCODE -ne 0) {
            Write-Error "Failed to create App Service"
            exit 1
        }
    }
    else {
        Write-Info "App Service '$($Config.AppName)' already exists"
    }
    
    Write-Success "Azure resources ready!"
}

# Function to set environment variables
function Set-EnvironmentVariables {
    param([hashtable]$Config)
    
    Write-Info "Setting environment variables..."
    
    # Set the startup command to use gunicorn with SSE-optimized settings
    az webapp config set `
        --name $Config.AppName `
        --resource-group $Config.ResourceGroup `
        --startup-file "gunicorn --bind 0.0.0.0:8000 --workers 1 --threads 4 --timeout 300 --keep-alive 75 --no-sendfile --max-requests 1000 --max-requests-jitter 50 --access-logfile - --error-logfile - wsgi:app"
    
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Failed to set startup command, trying alternative approach..."
        # Try setting via app settings as fallback
        az webapp config appsettings set `
            --name $Config.AppName `
            --resource-group $Config.ResourceGroup `
            --settings `
            STARTUP_COMMAND="gunicorn --bind 0.0.0.0:8000 --workers 1 --threads 4 --timeout 300 --keep-alive 75 --no-sendfile --max-requests 1000 --max-requests-jitter 50 --access-logfile - --error-logfile - wsgi:app"
    }
    
    # Set Python version and build settings
    az webapp config set `
        --name $Config.AppName `
        --resource-group $Config.ResourceGroup `
        --linux-fx-version "PYTHON|$($Config.PythonVersion)"
    
    # Force Python app detection and dependency installation
    az webapp config appsettings set `
        --name $Config.AppName `
        --resource-group $Config.ResourceGroup `
        --settings `
        SCM_DO_BUILD_DURING_DEPLOYMENT="true" `
        ENABLE_ORYX_BUILD="true" `
        BUILD_FLAGS="UseAppInsights=false" `
        PYTHONPATH="/home/site/wwwroot"
    
    # Set application settings based on your local .env file structure
    Write-Info "Setting application environment variables..."
    
    # Core Flask settings
    az webapp config appsettings set `
        --name $Config.AppName `
        --resource-group $Config.ResourceGroup `
        --settings `
        FLASK_ENV="production" `
        FLASK_DEBUG="false" `
        LOG_LEVEL="INFO" `
        API_HOST="0.0.0.0" `
        API_PORT="8000" `
        MCP_SERVER_NAME="PythonAPI_MCP_Server" `
        MCP_SERVER_PORT="3001" `
        MCP_MOUNT_PATH="/mcp" `
        DEFAULT_USER_ID="system"
    
    # Configure Azure App Service for SSE support
    Write-Info "Configuring Azure App Service for Server-Sent Events (SSE)..."
    
    # Disable response buffering for SSE to work properly
    az webapp config appsettings set `
        --name $Config.AppName `
        --resource-group $Config.ResourceGroup `
        --settings `
        WEBSITE_DISABLE_RESPONSE_BUFFERING="true" `
        WEBSITE_HTTPLOGGING_RETENTION_DAYS="3" `
        WEBSITE_LOAD_CERTIFICATES="*" `
        WEBSITE_NODE_DEFAULT_VERSION="18-lts" `
        WEBSITE_PYTHON_DEFAULT_VERSION="3.13" `
        WEBSITE_TIME_ZONE="UTC" `
        WEBSITE_ENABLE_SYNC_UPDATE_SITE="true" `
        WEBSITE_SKIP_CONTENTSHARE_VALIDATION="1"
    
    # Set additional App Service configurations for better SSE support
    az webapp config set `
        --name $Config.AppName `
        --resource-group $Config.ResourceGroup `
        --always-on true `
        --http20-enabled true
    
    # Enable Application Request Routing (ARR) affinity for sticky sessions
    # This helps with SSE connection stability
    az webapp config set `
        --name $Config.AppName `
        --resource-group $Config.ResourceGroup `
        --client-affinity-enabled true
    
    Write-Warning "IMPORTANT: You need to set your Azure-specific environment variables:"
    Write-Warning "Run the following commands with your actual values:"
    Write-Host ""
    Write-Host "# Azure OpenAI settings"
    Write-Host "az webapp config appsettings set --name $($Config.AppName) --resource-group $($Config.ResourceGroup) --settings OPENAI_ENDPOINT='your-openai-endpoint' OPENAI_API_KEY='your-api-key' OPENAI_DEPLOYMENT='your-deployment-name'"
    Write-Host ""
    Write-Host "# Azure Cosmos DB settings"
    Write-Host "az webapp config appsettings set --name $($Config.AppName) --resource-group $($Config.ResourceGroup) --settings COSMOS_DB_ENDPOINT='your-cosmos-endpoint' COSMOS_DB_KEY='your-cosmos-key' COSMOS_DB_DATABASE='your-database-name'"
    Write-Host ""
    Write-Host "# Azure Blob Storage settings"
    Write-Host "az webapp config appsettings set --name $($Config.AppName) --resource-group $($Config.ResourceGroup) --settings STORAGE_ACCOUNT_NAME='your-storage-account' STORAGE_ACCOUNT_KEY='your-storage-key'"
    Write-Host ""
    Write-Host "# Azure AI Search settings"
    Write-Host "az webapp config appsettings set --name $($Config.AppName) --resource-group $($Config.ResourceGroup) --settings SEARCH_ENDPOINT='your-search-endpoint' SEARCH_KEY='your-search-key'"
    Write-Host ""
    
    Write-Success "Base environment variables set!"
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
        
        if (!(Test-Path "PythonAPI\wsgi.py")) {
            Write-Error "wsgi.py not found in PythonAPI directory" 
            exit 1
        }
        
        Write-Info "Including main.py, wsgi.py, and requirements.txt in deployment..."
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
        $requiredFiles = @("requirements.txt", "main.py", "wsgi.py")
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
    
    Write-Success "Deployment completed successfully!"
    Write-Host ""
    Write-Info "Application Information:"
    Write-Host "  App URL: https://$($Config.AppName).azurewebsites.us"
    Write-Host "  API Health: https://$($Config.AppName).azurewebsites.us/health"
    Write-Host "  API Endpoints: https://$($Config.AppName).azurewebsites.us/api/v1"
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
    Write-Host "Azure App Service Deployment Script"
    Write-Host "Flask API + Angular Frontend"
    Write-Host "========================================================"
    Write-Host ""
    
    # Check prerequisites
    Test-Prerequisites
    
    # Get deployment configuration
    $config = Get-DeploymentConfig
    
    # Build Angular
    Build-Angular
    
    # Copy Angular files to Flask
    Copy-AngularToFlask
    
    # Create Azure resources
    New-AzureResources -Config $config
    
    # Set environment variables
    Set-EnvironmentVariables -Config $config
    
    # Deploy application
    Deploy-Application -Config $config
    
    # Show deployment info
    Show-DeploymentInfo -Config $config
}

# Run main function
Main
