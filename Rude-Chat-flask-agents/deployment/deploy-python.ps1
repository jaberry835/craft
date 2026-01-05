param(
    [string]$ConfigFile = "my-config-python.json",
    [switch]$SkipBuild,
    [switch]$SkipDeploy,
    [switch]$SkipAppSettings
)

# Stop on any error
$ErrorActionPreference = "Stop"

Write-Host "🐍 Python MCP Server + Angular Deployment Script" -ForegroundColor Green
Write-Host "================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Available parameters:" -ForegroundColor Cyan
Write-Host "  -ConfigFile      : Configuration file to use (default: my-config-python.json)" -ForegroundColor White
Write-Host "  -SkipBuild       : Skip Angular build step" -ForegroundColor White
Write-Host "  -SkipDeploy      : Skip Azure deployment step" -ForegroundColor White
Write-Host "  -SkipAppSettings : Skip app settings configuration (speeds up deployment)" -ForegroundColor White
Write-Host ""

# Load configuration
if (-not (Test-Path $ConfigFile)) {
    Write-Error "Configuration file '$ConfigFile' not found. Please create it first using config-python.json as a template."
    exit 1
}

try {
    $config = Get-Content $ConfigFile | ConvertFrom-Json
    Write-Host "✅ Configuration loaded from $ConfigFile" -ForegroundColor Green
} catch {
    Write-Error "Failed to parse configuration file: $_"
    exit 1
}

# Extract configuration values
$subscriptionId = $config.azure.subscriptionId
$resourceGroupName = $config.azure.resourceGroupName
$appServiceName = $config.azure.appServiceName
$location = $config.azure.location

Write-Host "📋 Deployment Configuration:" -ForegroundColor Yellow
Write-Host "   Subscription: $subscriptionId" -ForegroundColor White
Write-Host "   Resource Group: $resourceGroupName" -ForegroundColor White
Write-Host "   App Service: $appServiceName" -ForegroundColor White
Write-Host "   Location: $location" -ForegroundColor White

# Check if logged into Azure
Write-Host "🔐 Checking Azure CLI authentication..." -ForegroundColor Yellow
$account = az account show 2>$null | ConvertFrom-Json
if (-not $account) {
    Write-Host "❌ Not logged into Azure CLI. Please run 'az login' first." -ForegroundColor Red
    exit 1
}

if ($account.id -ne $subscriptionId) {
    Write-Host "🔄 Setting Azure subscription to $subscriptionId..." -ForegroundColor Yellow
    az account set --subscription $subscriptionId
}

Write-Host "✅ Azure CLI authenticated for subscription: $($account.name)" -ForegroundColor Green

# Angular Build
if (-not $SkipBuild) {
    Write-Host "🏗️  Building Angular application..." -ForegroundColor Yellow
    
    # Check if node_modules exists
    if (-not (Test-Path "../node_modules")) {
        Write-Host "📦 Installing npm dependencies..." -ForegroundColor Yellow
        Set-Location ..
        npm install
        if ($LASTEXITCODE -ne 0) {
            Write-Error "npm install failed"
            exit 1
        }
        Set-Location deployment
    }
    
    # Build Angular
    Set-Location ..
    
    # Check if Angular CLI is installed
    Write-Host "🔍 Checking Angular CLI availability..." -ForegroundColor Yellow
    $ngCommand = Get-Command ng -ErrorAction SilentlyContinue
    if (-not $ngCommand) {
        Write-Host "❌ Angular CLI (ng) is not found in PATH." -ForegroundColor Red
        Write-Host "   Please install Angular CLI globally:" -ForegroundColor Red
        Write-Host "   npm install -g @angular/cli" -ForegroundColor Yellow
        Set-Location deployment
        exit 1
    }
    
    # Verify ng command works
    try {
        $ngVersionOutput = ng version 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "ng version command failed"
        }
        Write-Host "✅ Angular CLI is available and working" -ForegroundColor Green
    } catch {
        Write-Host "❌ Angular CLI command failed: $_" -ForegroundColor Red
        Write-Host "   Please ensure Angular CLI is properly installed:" -ForegroundColor Red
        Write-Host "   npm install -g @angular/cli" -ForegroundColor Yellow
        Set-Location deployment
        exit 1
    }
    
    # Build Angular
    Write-Host "🏗️  Running Angular production build..." -ForegroundColor Yellow
    try {
        ng build --configuration production
        if ($LASTEXITCODE -ne 0) {
            throw "ng build command failed with exit code $LASTEXITCODE"
        }
    } catch {
        Write-Host "❌ Angular build failed: $_" -ForegroundColor Red
        Write-Host "   Please check the Angular build output above for specific errors." -ForegroundColor Red
        Set-Location deployment
        exit 1
    }
    Set-Location deployment
    
    if (-not (Test-Path "../dist")) {
        Write-Error "Angular build failed - no dist folder found"
        exit 1
    }
    
    Write-Host "✅ Angular application built successfully" -ForegroundColor Green
}

# Python Deployment
if (-not $SkipDeploy) {
    Write-Host "🚀 Deploying Python application to Azure App Service..." -ForegroundColor Yellow
    
    $pythonAppPath = "../Python-MCP-Server"
    
    if (-not (Test-Path $pythonAppPath)) {
        Write-Error "Python application folder not found at $pythonAppPath"
        exit 1
    }
    
    # Create deployment package
    $zipFile = "python-deployment.zip"
    if (Test-Path $zipFile) {
        Remove-Item $zipFile
    }
    
    # Create a temporary deployment folder with only necessary files
    $tempDeployPath = "temp-deploy"
    if (Test-Path $tempDeployPath) {
        Remove-Item $tempDeployPath -Recurse -Force
    }
    New-Item -ItemType Directory -Path $tempDeployPath -Force | Out-Null
    
    # Copy Python files (excluding __pycache__, .git, etc.)
    Write-Host "📦 Packaging Python application..." -ForegroundColor Yellow
    robocopy $pythonAppPath $tempDeployPath /E /XD __pycache__ .git .pytest_cache /XF *.pyc .gitignore README.md config.example.json
    
    # Copy Angular build output to Python static folder
    Write-Host "📋 Copying Angular build to Python static folder..." -ForegroundColor Yellow
    New-Item -ItemType Directory -Path "$tempDeployPath/static" -Force | Out-Null
    robocopy "../dist/rude-chat-app/browser" "$tempDeployPath/static" /E
    
    # Copy the web.config and startup script for Azure App Service
    Copy-Item "web-python.config" "$tempDeployPath/web.config" -Force
    Copy-Item "startup.sh" "$tempDeployPath/startup.sh" -Force
    
    # Create the zip package
    Compress-Archive -Path "$tempDeployPath/*" -DestinationPath $zipFile
    
    # Set application settings
    if (-not $SkipAppSettings) {
        Write-Host "⚙️  Configuring Azure App Service settings..." -ForegroundColor Yellow
        
        # Set Python runtime and startup command
        Write-Host "🐍 Setting Python runtime version..." -ForegroundColor Yellow
        az webapp config set --name $appServiceName --resource-group $resourceGroupName --linux-fx-version `"PYTHON`|3.12`"
        if ($LASTEXITCODE -ne 0) {
            Write-Error "Failed to set Python runtime version"
            exit 1
        }
        
        Write-Host "🚀 Setting startup command..." -ForegroundColor Yellow
        # Use gunicorn directly since Oryx extracts to a temp directory
        az webapp config set --name $appServiceName --resource-group $resourceGroupName --startup-file "gunicorn --bind=0.0.0.0:8000 --workers 1 --timeout 30 --access-logfile - --error-logfile - --log-level info chat_api_server:app"
        if ($LASTEXITCODE -ne 0) {
            Write-Error "Failed to set startup command"
            exit 1
        }
        
        # Set application settings from config
        $appSettings = @()
        foreach ($setting in $config.applicationSettings.PSObject.Properties) {
            $appSettings += "$($setting.Name)=$($setting.Value)"
        }
        
        if ($appSettings.Count -gt 0) {
            Write-Host "🔧 Setting application configuration..." -ForegroundColor Yellow
            foreach ($setting in $config.applicationSettings.PSObject.Properties) {
                Write-Host "   Setting: $($setting.Name) = $($setting.Value)" -ForegroundColor Gray
                $result = az webapp config appsettings set --name $appServiceName --resource-group $resourceGroupName --settings "$($setting.Name)=$($setting.Value)" 2>&1
                if ($LASTEXITCODE -ne 0) {
                    Write-Host "   ⚠️  Warning: Failed to set $($setting.Name): $result" -ForegroundColor Yellow
                } else {
                    Write-Host "   ✅ Set $($setting.Name)" -ForegroundColor Green
                }
            }
        }
    } else {
        Write-Host "⏭️  Skipping app settings configuration (SkipAppSettings flag is set)" -ForegroundColor Yellow
    }
    
    # Deploy using Azure CLI
    Write-Host "🚢 Deploying application package..." -ForegroundColor Yellow
    $deployResult = az webapp deploy --name $appServiceName --resource-group $resourceGroupName --src-path $zipFile --type zip 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "❌ Deployment failed!" -ForegroundColor Red
        Write-Host "Error details: $deployResult" -ForegroundColor Red
        Write-Host "Please check the deployment logs at: https://$appServiceName.scm.azurewebsites.us/api/deployments/latest" -ForegroundColor Yellow
        
        # Clean up
        Remove-Item $zipFile -ErrorAction SilentlyContinue
        Remove-Item $tempDeployPath -Recurse -Force -ErrorAction SilentlyContinue
        exit 1
    } else {
        Write-Host "✅ Deployment package uploaded successfully!" -ForegroundColor Green
    }
    
    # Clean up
    Remove-Item $zipFile
    Remove-Item $tempDeployPath -Recurse -Force
    
    Write-Host "✅ Deployment completed successfully!" -ForegroundColor Green
    Write-Host "🌐 Application URL: https://$appServiceName.azurewebsites.us" -ForegroundColor Cyan
    
    # Open browser
    Start-Process "https://$appServiceName.azurewebsites.us"
}

Write-Host "🎉 Python deployment script completed!" -ForegroundColor Green