param(
    [string]$ConfigFile = "config.json",
    [switch]$UpdateSystemPrompt
)

if (-not (Test-Path $ConfigFile)) {
    Write-Error "Configuration file '$ConfigFile' not found."
    exit 1
}

$config = Get-Content $ConfigFile | ConvertFrom-Json

$appServiceName = $config.azure.appServiceName
$resourceGroupName = $config.azure.resourceGroupName

Write-Host "🔧 Updating App Service configuration for $appServiceName..." -ForegroundColor Green

if ($UpdateSystemPrompt) {
    # Update just the system prompt
    $systemPrompt = $config.applicationSettings."SystemPrompt"
    
    Write-Host "📝 Updating system prompt..." -ForegroundColor Yellow
    az webapp config appsettings set --name $appServiceName --resource-group $resourceGroupName --settings "SystemPrompt=$systemPrompt"
    
    Write-Host "✅ System prompt updated! Changes will take effect immediately." -ForegroundColor Green
    Write-Host "💡 Tip: You can now modify the system prompt in config.json and run this script to update it without redeploying the entire application." -ForegroundColor Cyan
} else {
    # Update all app settings
    Write-Host "⚙️ Updating all application settings..." -ForegroundColor Yellow
    
    $appSettings = @()
    $config.applicationSettings.PSObject.Properties | ForEach-Object {
        $appSettings += "$($_.Name)=$($_.Value)"
    }

    if ($appSettings.Count -gt 0) {
        az webapp config appsettings set --name $appServiceName --resource-group $resourceGroupName --settings $appSettings
        Write-Host "✅ All application settings updated!" -ForegroundColor Green
    } else {
        Write-Host "⚠️ No application settings found in configuration." -ForegroundColor Yellow
    }
}

# Restart the app service to ensure changes take effect
Write-Host "🔄 Restarting App Service to apply changes..." -ForegroundColor Yellow
az webapp restart --name $appServiceName --resource-group $resourceGroupName

Write-Host "🎉 Configuration update completed!" -ForegroundColor Green

# Show the updated system prompt configuration
Write-Host "📋 Current SystemPrompt configuration:" -ForegroundColor Cyan
$currentSystemPrompt = az webapp config appsettings list --name $appServiceName --resource-group $resourceGroupName --query "[?name=='SystemPrompt'].value" -o tsv

if ($currentSystemPrompt) {
    Write-Host "System prompt is configured and ready." -ForegroundColor Green
} else {
    Write-Host "⚠️ SystemPrompt not found in app settings." -ForegroundColor Yellow
}
