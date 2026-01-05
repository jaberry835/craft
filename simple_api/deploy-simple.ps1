# Simple Azure App Service Deployment Script
# This is a simplified version that relies on Azure's automatic Python detection

param(
    [Parameter(Mandatory=$true)]
    [string]$AppServiceName,
    
    [Parameter(Mandatory=$true)]
    [string]$ResourceGroupName,
    
    [Parameter(Mandatory=$false)]
    [string]$SubscriptionId,
    
    [Parameter(Mandatory=$false)]
    [string]$PipIndexUrl,
    
    [Parameter(Mandatory=$false)]
    [string]$PipTrustedHost
)

Write-Host "Simple Azure App Service Deployment" -ForegroundColor Green
Write-Host "====================================" -ForegroundColor Green

# Check if Azure CLI is available
try {
    az version | Out-Null
    Write-Host "✓ Azure CLI found" -ForegroundColor Green
} catch {
    Write-Host "✗ Azure CLI not found. Please install it first." -ForegroundColor Red
    exit 1
}

# Check if logged in
try {
    $account = az account show 2>$null | ConvertFrom-Json
    Write-Host "✓ Logged in as: $($account.user.name)" -ForegroundColor Green
} catch {
    Write-Host "✗ Not logged in to Azure. Run 'az login' first." -ForegroundColor Red
    exit 1
}

# Set subscription if provided
if ($SubscriptionId) {
    Write-Host "Setting subscription: $SubscriptionId" -ForegroundColor Yellow
    az account set --subscription $SubscriptionId
}

# Create deployment package
Write-Host "Creating deployment package..." -ForegroundColor Yellow

# Create a temporary zip file with just the necessary files
$tempDir = "temp_deploy_$(Get-Date -Format 'yyyyMMdd_HHmmss')"
New-Item -ItemType Directory -Path $tempDir | Out-Null

# Copy only the necessary files
Copy-Item "main.py" -Destination $tempDir
Copy-Item "requirements.txt" -Destination $tempDir
Copy-Item "azure_openai_service.py" -Destination $tempDir
Copy-Item "models.py" -Destination $tempDir
Copy-Item "config.py" -Destination $tempDir

# Copy README if it exists
if (Test-Path "README.md") {
    Copy-Item "README.md" -Destination $tempDir
}

# Create a simple web.config for Python (optional, but helps with routing)
$webConfig = @"
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <system.webServer>
    <handlers>
      <add name="PythonHandler" path="*" verb="*" modules="httpPlatformHandler" resourceType="Unspecified"/>
    </handlers>
    <httpPlatform processPath="python" arguments="-m uvicorn main:app --host 0.0.0.0 --port %HTTP_PLATFORM_PORT%" stdoutLogEnabled="true" stdoutLogFile=".\python.log" startupTimeLimit="60" requestTimeout="00:04:00"/>
  </system.webServer>
</configuration>
"@
$webConfig | Out-File -FilePath "$tempDir\web.config" -Encoding UTF8

Write-Host "✓ Files prepared for deployment" -ForegroundColor Green

# Deploy using zip deployment
Write-Host "Deploying to $AppServiceName..." -ForegroundColor Yellow

# Create zip file
$zipFile = "$tempDir.zip"
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($tempDir, $zipFile)

# Deploy
az webapp deployment source config-zip --resource-group $ResourceGroupName --name $AppServiceName --src $zipFile

if ($LASTEXITCODE -eq 0) {
    Write-Host "✓ Deployment successful!" -ForegroundColor Green
    
    # Configure startup command
    Write-Host "Configuring app settings..." -ForegroundColor Yellow
    az webapp config set --resource-group $ResourceGroupName --name $AppServiceName --startup-file "python -m uvicorn main:app --host 0.0.0.0 --port 8000"
    
    # Set custom pip settings if provided
    if ($PipIndexUrl -or $PipTrustedHost) {
        $settings = @()
        if ($PipIndexUrl) { $settings += "PIP_INDEX_URL=$PipIndexUrl" }
        if ($PipTrustedHost) { $settings += "PIP_TRUSTED_HOST=$PipTrustedHost" }
        
        $settingsString = $settings -join " "
        az webapp config appsettings set --resource-group $ResourceGroupName --name $AppServiceName --settings $settingsString
        Write-Host "✓ Custom pip settings configured" -ForegroundColor Green
    }
    
    # Restart app
    Write-Host "Restarting app..." -ForegroundColor Yellow
    az webapp restart --resource-group $ResourceGroupName --name $AppServiceName
    
    Write-Host "" -ForegroundColor Green
    Write-Host "🎉 Deployment Complete!" -ForegroundColor Green
    Write-Host "App URL: https://$AppServiceName.azurewebsites.net" -ForegroundColor Cyan
    Write-Host "Swagger: https://$AppServiceName.azurewebsites.net/docs" -ForegroundColor Cyan
    
} else {
    Write-Host "✗ Deployment failed!" -ForegroundColor Red
    Write-Host "Check logs at: https://$AppServiceName.scm.azurewebsites.net" -ForegroundColor Yellow
}

# Cleanup
Remove-Item -Recurse -Force $tempDir
Remove-Item $zipFile

Write-Host "Cleanup completed." -ForegroundColor Green
