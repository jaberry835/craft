# Azure App Service Deployment Script for Python FastAPI API
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
    
    if ([string]::IsNullOrEmpty($Location)) {
        $Location = Read-Host "Enter your Azure Location (e.g., eastus)"
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
        az webapp create `
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

# Function to deploy the application
function Deploy-Application {
    param([hashtable]$Config)
    
    Write-Info "Deploying application to Azure App Service..."
    
    try {
        # Verify deployment zip exists
        $zipPath = "deployment.zip"
        if (!(Test-Path $zipPath)) {
            Write-Error "Deployment package not found: $zipPath"
            exit 1
        }
        
        # Deploy using the newer az webapp deploy command
        az webapp deploy `
            --name $Config.AppName `
            --resource-group $Config.ResourceGroup `
            --src-path $zipPath `
            --type zip `
            --async false
        
        if ($LASTEXITCODE -ne 0) {
            Write-Error "Deployment failed"
            exit 1
        }
        
        Write-Success "Application deployed successfully!"
    }
    catch {
        Write-Error "Deployment failed: $_"
        exit 1
    }
}

# Function to set environment variables
function Set-EnvironmentVariables {
    param([hashtable]$Config)
    
    Write-Info "Setting environment variables..."
    
    az webapp config appsettings set `
        --name $Config.AppName `
        --resource-group $Config.ResourceGroup `
        --settings `
        AZURE_OPENAI_API_KEY="<your-api-key>" `
        AZURE_OPENAI_ENDPOINT="<your-endpoint>" `
        AZURE_OPENAI_API_VERSION="2024-02-01" `
        AZURE_OPENAI_DEPLOYMENT_NAME="gpt-4o"
    
    Write-Success "Environment variables set!"
}

# Major rewrite of Create-DeploymentZip function to include all necessary files
function Create-DeploymentZip {
    Write-Info "Creating deployment ZIP package..."

    $zipPath = "deployment.zip"
    if (Test-Path $zipPath) {
        Write-Info "Removing existing deployment.zip..."
        Remove-Item $zipPath -Force
    }

    # Ensure deployment directory exists
    $deployDir = "deployment"
    if (!(Test-Path $deployDir)) {
        Write-Info "Deployment directory does not exist, creating: $deployDir"
        New-Item -ItemType Directory -Path $deployDir
    }

    # Clear deployment directory before each deployment
    if (Test-Path $deployDir) {
        Write-Info "Clearing existing deployment directory: $deployDir"
        Remove-Item -Path "$deployDir/*" -Recurse -Force
    }

    # Populate deployment directory with all necessary files
    Write-Info "Populating deployment directory with required files..."
    $filesToInclude = @(
        "main.py",
        "requirements.txt",
        "swagger_config.py",
        "models.py",
        "azure_openai_service.py",
        "config.py"
    )

    foreach ($file in $filesToInclude) {
        if (Test-Path $file) {
            Copy-Item -Path $file -Destination $deployDir -Force
        } else {
            Write-Warning "File not found: $file"
        }
    }

    # Create ZIP file from deployment directory contents
    Compress-Archive -Path "$deployDir/*" -DestinationPath $zipPath -Force

    if (Test-Path $zipPath) {
        Write-Success "Deployment ZIP created successfully: $zipPath"
    } else {
        Write-Error "Failed to create deployment ZIP"
        exit 1
    }
}

# Function to install dependencies on Azure App Service
function Install-Dependencies {
    param([hashtable]$Config)

    Write-Info "Installing dependencies on Azure App Service..."

    az webapp ssh --name $Config.AppName --resource-group $Config.ResourceGroup --command "pip install -r requirements.txt --trusted-host pypi.org --trusted-host pypi.python.org --trusted-host files.pythonhosted.org"

    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to install dependencies"
        exit 1
    }

    Write-Success "Dependencies installed successfully!"
}

# Main deployment function
function Main {
    Write-Host "========================================================"
    Write-Host "Azure App Service Deployment Script"
    Write-Host "Python FastAPI API"
    Write-Host "========================================================"
    Write-Host ""
    
    # Check prerequisites
    Test-Prerequisites
    
    # Create deployment ZIP
    Create-DeploymentZip
    
    # Get deployment configuration
    $config = Get-DeploymentConfig
    
    # Create Azure resources
    New-AzureResources -Config $config
    
    # Deploy application
    Deploy-Application -Config $config
    
    # Install dependencies
    Install-Dependencies -Config $config
    
    # Set environment variables
    Set-EnvironmentVariables -Config $config
    
    Write-Success "Deployment completed successfully!"
    Write-Info "Application URL: https://$($config.AppName).azurewebsites.net"
}

# Run main function
Main