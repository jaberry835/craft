# Test Python Flask App Endpoints
param(
    [string]$BaseUrl = "https://rude-chat-python.azurewebsites.us"
)

Write-Host "🧪 Testing Python Flask App Endpoints" -ForegroundColor Green
Write-Host "=====================================" -ForegroundColor Green
Write-Host "Base URL: $BaseUrl" -ForegroundColor Yellow

# Test main page
Write-Host "`n🏠 Testing main page..." -ForegroundColor Yellow
try {
    $response = Invoke-WebRequest -Uri $BaseUrl -Method GET -TimeoutSec 30
    Write-Host "✅ Main page: HTTP $($response.StatusCode)" -ForegroundColor Green
    Write-Host "   Content-Type: $($response.Headers.'Content-Type')" -ForegroundColor Gray
    if ($response.Content -like "*<!DOCTYPE html>*") {
        Write-Host "   ✅ Serving HTML content (Angular app)" -ForegroundColor Green
    } else {
        Write-Host "   ❌ Not serving HTML content" -ForegroundColor Red
    }
} catch {
    Write-Host "❌ Main page failed: $($_.Exception.Message)" -ForegroundColor Red
}

# Test API health check
Write-Host "`n❤️ Testing API health..." -ForegroundColor Yellow
try {
    $response = Invoke-WebRequest -Uri "$BaseUrl/api/health" -Method GET -TimeoutSec 30
    Write-Host "✅ API health: HTTP $($response.StatusCode)" -ForegroundColor Green
    $content = $response.Content | ConvertFrom-Json
    Write-Host "   Status: $($content.status)" -ForegroundColor Gray
} catch {
    Write-Host "❌ API health failed: $($_.Exception.Message)" -ForegroundColor Red
}

# Test config endpoint
Write-Host "`n⚙️ Testing config endpoint..." -ForegroundColor Yellow
try {
    $response = Invoke-WebRequest -Uri "$BaseUrl/api/config" -Method GET -TimeoutSec 30
    Write-Host "✅ Config endpoint: HTTP $($response.StatusCode)" -ForegroundColor Green
    $content = $response.Content | ConvertFrom-Json
    Write-Host "   Contains Azure OpenAI config: $($null -ne $content.azureOpenAI)" -ForegroundColor Gray
} catch {
    Write-Host "❌ Config endpoint failed: $($_.Exception.Message)" -ForegroundColor Red
}

# Test static files
Write-Host "`n📁 Testing static files..." -ForegroundColor Yellow
try {
    $response = Invoke-WebRequest -Uri "$BaseUrl/static/favicon.ico" -Method GET -TimeoutSec 30
    Write-Host "✅ Static files: HTTP $($response.StatusCode)" -ForegroundColor Green
} catch {
    Write-Host "❌ Static files failed: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host "`n🎉 Endpoint testing completed!" -ForegroundColor Green
