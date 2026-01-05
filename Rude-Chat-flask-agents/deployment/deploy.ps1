param(
    [string]$ConfigFile = "config.json",
    [switch]$SkipBuild,
    [switch]$SkipDeploy
)

# Load configuration
if (-not (Test-Path $ConfigFile)) {
    Write-Error "Configuration file '$ConfigFile' not found. Please copy config.json and update with your values."
    exit 1
}

$config = Get-Content $ConfigFile | ConvertFrom-Json

Write-Host "🚀 Starting Azure deployment for Rude Chat..." -ForegroundColor Green

# Set variables
$subscriptionId = $config.azure.subscriptionId
$resourceGroupName = $config.azure.resourceGroupName
$location = $config.azure.location
$appServicePlanName = $config.azure.appServicePlanName
$appServiceName = $config.azure.appServiceName
$sku = $config.azure.sku

# Login and set subscription
Write-Host "📋 Setting Azure subscription..." -ForegroundColor Yellow
az account set --subscription $subscriptionId

# Create resource group if it doesn't exist
Write-Host "📁 Creating resource group..." -ForegroundColor Yellow
az group create --name $resourceGroupName --location $location

# Create App Service Plan if it doesn't exist
Write-Host "⚙️ Creating App Service Plan..." -ForegroundColor Yellow
az appservice plan create --name $appServicePlanName --resource-group $resourceGroupName --sku $sku --location $location

# Create App Service if it doesn't exist
Write-Host "🌐 Creating App Service..." -ForegroundColor Yellow
az webapp create --name $appServiceName --resource-group $resourceGroupName --plan $appServicePlanName --runtime "DOTNETCORE:8.0"

# Configure App Settings
Write-Host "⚙️ Configuring application settings..." -ForegroundColor Yellow
$appSettings = @()
$config.applicationSettings.PSObject.Properties | ForEach-Object {
    $appSettings += "$($_.Name)=$($_.Value)"
}

if ($appSettings.Count -gt 0) {
    az webapp config appsettings set --name $appServiceName --resource-group $resourceGroupName --settings $appSettings
}

if (-not $SkipBuild) {
    # Build Angular app with production configuration
    Write-Host "🔨 Building Angular application..." -ForegroundColor Yellow
    Set-Location "../"
    
    # Update environment.prod.ts with actual values from config
    $envTemplate = Get-Content "src/environments/environment.prod.template.ts" -Raw
    $envContent = $envTemplate
    $envContent = $envContent -replace "__CLIENT_ID__", $config.applicationSettings."Angular__ClientId"
    $envContent = $envContent -replace "__AUTHORITY__", $config.applicationSettings."Angular__Authority"
    $envContent = $envContent -replace "__REDIRECT_URI__", $config.applicationSettings."Angular__RedirectUri"
    $envContent = $envContent -replace "__OPENAI_ENDPOINT__", $config.applicationSettings."Angular__OpenAI__Endpoint"
    $envContent = $envContent -replace "__OPENAI_DEPLOYMENT__", $config.applicationSettings."Angular__OpenAI__DeploymentName"
    $envContent = $envContent -replace "__SEARCH_ENDPOINT__", $config.applicationSettings."Angular__Search__Endpoint"
    $envContent = $envContent -replace "__SEARCH_INDEX__", $config.applicationSettings."Angular__Search__IndexName"
    $envContent = $envContent -replace "__API_BASE_URL__", $config.applicationSettings."Angular__ApiBaseUrl"
    $envContent = $envContent -replace "__MCP_API_BASE_URL__", $config.applicationSettings."Angular__MCPApiBaseUrl"
    
    Set-Content "src/environments/environment.prod.ts" -Value $envContent
      npm install
    npm run build -- --configuration=production    # Copy Angular build to .NET wwwroot
    Write-Host "📋 Copying Angular build to .NET project..." -ForegroundColor Yellow
    $distPath = "dist/rude-chat-app"
    $wwwrootPath = "MCP-Server/MCPServer/wwwroot"
    
    if (Test-Path $wwwrootPath) {
        Remove-Item $wwwrootPath -Recurse -Force
    }
    
    # Create wwwroot directory
    New-Item -ItemType Directory -Path $wwwrootPath -Force | Out-Null
    
    if (Test-Path $distPath) {
        # Check if there's a browser subfolder (Angular 18+ structure)
        $browserPath = "$distPath/browser"
        if (Test-Path $browserPath) {
            Write-Host "📋 Detected Angular 18+ build structure, copying from browser/ subfolder..." -ForegroundColor Yellow
            # Copy files directly from browser subfolder to wwwroot root
            Copy-Item "$browserPath/*" $wwwrootPath -Recurse -Force
        } else {
            Write-Host "📋 Copying Angular files directly from dist folder..." -ForegroundColor Yellow
            # Copy files directly from dist folder to wwwroot root
            Copy-Item "$distPath/*" $wwwrootPath -Recurse -Force
        }
        
        Write-Host "✅ Angular build copied directly to wwwroot root" -ForegroundColor Green
    } else {
        Write-Error "Angular build not found at $distPath. Available dist folders:"
        if (Test-Path "dist") {
            Get-ChildItem "dist" | ForEach-Object { Write-Host "  - dist/$($_.Name)" }
        }
        exit 1
    }
    
    # Build .NET application
    Write-Host "🔨 Building .NET application..." -ForegroundColor Yellow
    Set-Location "MCP-Server/MCPServer"
    dotnet publish -c Release -o ./publish
    
    Set-Location "../../deployment"
}

if (-not $SkipDeploy) {
    # Deploy to Azure
    Write-Host "🚀 Deploying to Azure App Service..." -ForegroundColor Yellow
    $publishPath = "../MCP-Server/MCPServer/publish"
    
    if (-not (Test-Path $publishPath)) {
        Write-Error "Publish folder not found at $publishPath. Please run with build first."
        exit 1
    }
    
    # Create deployment package
    $zipFile = "deployment.zip"
    if (Test-Path $zipFile) {
        Remove-Item $zipFile
    }
    
    Compress-Archive -Path "$publishPath/*" -DestinationPath $zipFile
    
    # Deploy using Azure CLI
    az webapp deploy --name $appServiceName --resource-group $resourceGroupName --src-path $zipFile --type zip
    
    # Clean up
    Remove-Item $zipFile
    
    Write-Host "✅ Deployment completed successfully!" -ForegroundColor Green
    Write-Host "🌐 Application URL: https://$appServiceName.azurewebsites.us" -ForegroundColor Cyan
    
    # Open browser
    Start-Process "https://$appServiceName.azurewebsites.us"
}

Write-Host "🎉 Deployment script completed!" -ForegroundColor Green
