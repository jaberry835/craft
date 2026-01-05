# Quick Deploy Script
# This is a simplified version for quick deployment

# Update these variables with your Azure App Service details
$AppServiceName = "your-app-service-name"
$ResourceGroupName = "your-resource-group-name"

# Optional: Uncomment and set if you need custom pip configuration
# $PipIndexUrl = "https://your-private-repo.com/simple"
# $PipTrustedHost = "your-private-repo.com"

# Deploy
if ($PipIndexUrl -and $PipTrustedHost) {
    .\deploy.ps1 -AppServiceName $AppServiceName -ResourceGroupName $ResourceGroupName -PipIndexUrl $PipIndexUrl -PipTrustedHost $PipTrustedHost
}
elseif ($PipIndexUrl) {
    .\deploy.ps1 -AppServiceName $AppServiceName -ResourceGroupName $ResourceGroupName -PipIndexUrl $PipIndexUrl
}
elseif ($PipTrustedHost) {
    .\deploy.ps1 -AppServiceName $AppServiceName -ResourceGroupName $ResourceGroupName -PipTrustedHost $PipTrustedHost
}
else {
    .\deploy.ps1 -AppServiceName $AppServiceName -ResourceGroupName $ResourceGroupName
}
