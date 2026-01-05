param(
    [string]$ConfigFile = "my-config-python.json"
)

# Load configuration
if (-not (Test-Path $ConfigFile)) {
    Write-Error "Configuration file '$ConfigFile' not found."
    exit 1
}

$config = Get-Content $ConfigFile | ConvertFrom-Json
$appServiceName = $config.azure.appServiceName
$baseUrl = "https://$appServiceName.azurewebsites.us"

Write-Host "🔍 Verifying Python MCP Server deployment..." -ForegroundColor Green
Write-Host "🌐 Testing URL: $baseUrl" -ForegroundColor Yellow

# Test endpoints
$endpoints = @(
    @{ Path = "/health"; Description = "Health Check" },
    @{ Path = "/api/config"; Description = "Configuration" },
    @{ Path = "/api/chat/sessions"; Description = "Chat Sessions" },
    @{ Path = "/api/mcp/server-info"; Description = "MCP Server Info" },
    @{ Path = "/"; Description = "Angular Application" }
)

$allPassed = $true

foreach ($endpoint in $endpoints) {
    $url = "$baseUrl$($endpoint.Path)"
    Write-Host "🧪 Testing $($endpoint.Description): $url" -ForegroundColor Yellow
    
    try {
        $response = Invoke-WebRequest -Uri $url -Method GET -TimeoutSec 30
        
        if ($response.StatusCode -eq 200) {
            Write-Host "✅ $($endpoint.Description): OK (200)" -ForegroundColor Green
            
            # Additional checks for specific endpoints
            if ($endpoint.Path -eq "/") {
                if ($response.Content -like "*<title>*RudeChat*</title>*" -or $response.Content -like "*ng-version*") {
                    Write-Host "   Angular app detected" -ForegroundColor Green
                } else {
                    Write-Host "   ⚠️  Angular app may not be loading correctly" -ForegroundColor Yellow
                }
            }
            elseif ($endpoint.Path -eq "/api/config") {
                $configData = $response.Content | ConvertFrom-Json
                Write-Host "   Services configured: $($configData.services.PSObject.Properties.Count)" -ForegroundColor Green
                Write-Host "   CORS origins: $($configData.cors_origins.Count)" -ForegroundColor Green
            }
        } else {
            Write-Host "❌ $($endpoint.Description): Failed ($($response.StatusCode))" -ForegroundColor Red
            $allPassed = $false
        }
    }
    catch {
        Write-Host "❌ $($endpoint.Description): Error - $($_.Exception.Message)" -ForegroundColor Red
        $allPassed = $false
    }
    
    Start-Sleep -Seconds 1
}

Write-Host ""
if ($allPassed) {
    Write-Host "🎉 All tests passed! Deployment appears successful." -ForegroundColor Green
    Write-Host "🌐 Open your app: $baseUrl" -ForegroundColor Cyan
    Start-Process $baseUrl
} else {
    Write-Host "❌ Some tests failed. Check the Azure App Service logs for more details." -ForegroundColor Red
    Write-Host "📊 Azure Portal: https://portal.azure.us" -ForegroundColor Cyan
}

Write-Host ""
Write-Host "📋 Additional verification steps:" -ForegroundColor Yellow
Write-Host "   1. Check Azure App Service logs in the portal" -ForegroundColor White
Write-Host "   2. Verify all configuration values are set correctly" -ForegroundColor White
Write-Host "   3. Test authentication and API calls from the UI" -ForegroundColor White
