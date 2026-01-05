param(
    [string]$AppServiceName,
    [string]$ResourceGroupName = "rude-chat-rg"
)

if (-not $AppServiceName) {
    Write-Error "Please provide the App Service name with -AppServiceName parameter"
    exit 1
}

Write-Host "🔍 Verifying deployment for $AppServiceName..." -ForegroundColor Green

# Test the application URL
$appUrl = "https://$AppServiceName.azurewebsites.us"
Write-Host "🌐 Testing application URL: $appUrl" -ForegroundColor Yellow

try {
    $response = Invoke-WebRequest -Uri $appUrl -TimeoutSec 30
    if ($response.StatusCode -eq 200) {
        Write-Host "✅ Application is responding (Status: $($response.StatusCode))" -ForegroundColor Green
    } else {
        Write-Host "⚠️ Application responded with status: $($response.StatusCode)" -ForegroundColor Yellow
    }
} catch {
    Write-Host "❌ Failed to reach application: $($_.Exception.Message)" -ForegroundColor Red
}

# Test health endpoint
$healthUrl = "$appUrl/health"
Write-Host "🔍 Testing health endpoint: $healthUrl" -ForegroundColor Yellow

try {
    $healthResponse = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 10
    Write-Host "✅ Health check passed:" -ForegroundColor Green
    Write-Host "   Status: $($healthResponse.status)" -ForegroundColor White
    Write-Host "   Environment: $($healthResponse.environment)" -ForegroundColor White
    Write-Host "   Timestamp: $($healthResponse.timestamp)" -ForegroundColor White
} catch {
    Write-Host "❌ Health check failed: $($_.Exception.Message)" -ForegroundColor Red
}

# Test API endpoints
$apiEndpoints = @(
    "/api/configuration",
    "/api/document/health",
    "/api/mcp/tools/list"
)

foreach ($endpoint in $apiEndpoints) {
    $endpointUrl = "$appUrl$endpoint"
    Write-Host "🔍 Testing API endpoint: $endpoint" -ForegroundColor Yellow
    
    try {
        $apiResponse = Invoke-WebRequest -Uri $endpointUrl -TimeoutSec 10
        Write-Host "✅ $endpoint - Status: $($apiResponse.StatusCode)" -ForegroundColor Green
    } catch {
        Write-Host "❌ $endpoint - Failed: $($_.Exception.Message)" -ForegroundColor Red
    }
}

# Check Azure App Service logs
Write-Host "📋 Checking recent application logs..." -ForegroundColor Yellow
try {
    $logs = az webapp log tail --name $AppServiceName --resource-group $ResourceGroupName --provider application --num-lines 20 2>$null
    if ($logs) {
        Write-Host "📄 Recent logs:" -ForegroundColor Cyan
        $logs | ForEach-Object { Write-Host "   $_" -ForegroundColor White }
    } else {
        Write-Host "⚠️ No recent logs available" -ForegroundColor Yellow
    }
} catch {
    Write-Host "❌ Failed to retrieve logs: $($_.Exception.Message)" -ForegroundColor Red
}

# Check App Service status
Write-Host "📊 Checking App Service status..." -ForegroundColor Yellow
try {
    $appInfo = az webapp show --name $AppServiceName --resource-group $ResourceGroupName --query "{state:state,defaultHostName:defaultHostName,httpsOnly:httpsOnly}" -o json | ConvertFrom-Json
    Write-Host "✅ App Service Status:" -ForegroundColor Green
    Write-Host "   State: $($appInfo.state)" -ForegroundColor White
    Write-Host "   Default Host: $($appInfo.defaultHostName)" -ForegroundColor White
    Write-Host "   HTTPS Only: $($appInfo.httpsOnly)" -ForegroundColor White
} catch {
    Write-Host "❌ Failed to get App Service status: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host "🎉 Verification completed!" -ForegroundColor Green
Write-Host "🌐 Application URL: $appUrl" -ForegroundColor Cyan
