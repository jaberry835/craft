# Deployment Configuration
# Copy this file to deploy.config.ps1 and update with your settings

# Required Parameters
$AppServiceName = "your-app-service-name"
$ResourceGroupName = "your-resource-group-name"

# Optional Parameters
$SubscriptionId = ""  # Leave empty to use current subscription

# Optional Pip Configuration
$PipIndexUrl = ""      # Example: "https://your-private-repo.com/simple"
$PipTrustedHost = ""   # Example: "your-private-repo.com"

# Example usage:
# .\deploy.ps1 -AppServiceName $AppServiceName -ResourceGroupName $ResourceGroupName -PipIndexUrl $PipIndexUrl -PipTrustedHost $PipTrustedHost
