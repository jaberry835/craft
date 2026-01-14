##############################################################################
# Air-Gapped High-Side Deployment Script (PowerShell)
# This script walks through each deployment step with confirmation prompts
# and allows pointing to existing resources.
##############################################################################

#Requires -Version 7.0

# Set strict mode
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Function to print colored output
function Write-Info {
    param([string]$Message)
    Write-Host "ℹ $Message" -ForegroundColor Cyan
}

function Write-Success {
    param([string]$Message)
    Write-Host "✓ $Message" -ForegroundColor Green
}

function Write-Warning {
    param([string]$Message)
    Write-Host "⚠ $Message" -ForegroundColor Yellow
}

function Write-Error {
    param([string]$Message)
    Write-Host "✗ $Message" -ForegroundColor Red
}

function Write-Section {
    param([string]$Title)
    Write-Host ""
    Write-Host "═══════════════════════════════════════════════════════════" -ForegroundColor Cyan
    Write-Host "  $Title" -ForegroundColor Cyan
    Write-Host "═══════════════════════════════════════════════════════════" -ForegroundColor Cyan
    Write-Host ""
}

# Function to prompt for yes/no with default
function Get-YesNo {
    param(
        [string]$Prompt,
        [bool]$Default = $false
    )
    
    $choices = '&Yes', '&No'
    $defaultChoice = if ($Default) { 0 } else { 1 }
    
    $decision = $Host.UI.PromptForChoice('', $Prompt, $choices, $defaultChoice)
    return $decision -eq 0
}

# Function to prompt for input with default
function Get-Input {
    param(
        [string]$Prompt,
        [string]$Default = ""
    )
    
    if ($Default) {
        $response = Read-Host "$Prompt [$Default]"
        if ([string]::IsNullOrWhiteSpace($response)) {
            return $Default
        }
        return $response
    } else {
        $response = Read-Host $Prompt
        return $response
    }
}

# Function to wait for user to continue
function Wait-Continue {
    Write-Host ""
    Read-Host "Press ENTER to continue"
}

# Function to check if Azure CLI is installed
function Test-AzureCLI {
    if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
        Write-Error "Azure CLI is not installed. Please install it first."
        Write-Info "Visit: https://docs.microsoft.com/cli/azure/install-azure-cli"
        exit 1
    }
    Write-Success "Azure CLI is installed"
}

# Function to check if logged into Azure
function Test-AzureLogin {
    try {
        $null = az account show 2>$null
        Write-Success "Logged into Azure"
        
        $currentSub = az account show --query name -o tsv
        Write-Info "Current subscription: $currentSub"
        
        if (-not (Get-YesNo "Continue with this subscription?" $true)) {
            Write-Info "Please run 'az account set --subscription <subscription-id>' to change subscription"
            exit 0
        }
    } catch {
        Write-Error "Not logged into Azure. Please run 'az login' first."
        exit 1
    }
}

# Function to check if Docker is available
function Test-Docker {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        Write-Warning "Docker is not installed. Container image operations will be skipped."
        return $false
    }
    Write-Success "Docker is installed"
    return $true
}

##############################################################################
# Main Script
##############################################################################

Clear-Host
Write-Section "Air-Gapped High-Side Deployment Setup"

Write-Info "This script will guide you through deploying the Image Search application"
Write-Info "in an air-gapped environment. Each step will be explained and you will"
Write-Info "be prompted before any action is taken."
Write-Host ""
Write-Warning "Prerequisites:"
Write-Info "  • Azure CLI installed and configured"
Write-Info "  • Appropriate RBAC permissions"
Write-Info "  • Container image tar file (if deploying containers)"
Write-Info "  • Sample data prepared"
Write-Host ""

if (-not (Get-YesNo "Ready to begin?" $true)) {
    Write-Info "Exiting. Run this script when ready."
    exit 0
}

# Pre-flight checks
Write-Section "Step 1: Pre-flight Checks"

Write-Info "Checking prerequisites..."
Test-AzureCLI
Test-AzureLogin
$hasDocker = Test-Docker

Write-Success "Pre-flight checks passed"
Wait-Continue

##############################################################################
# Configuration
##############################################################################

Write-Section "Step 2: Configuration"

Write-Info "Please provide the deployment configuration."
Write-Host ""

# Basic configuration
$resourceGroup = Get-Input "Resource Group name" "rg-imagesearch-airgap"
$location = Get-Input "Azure region" "usgovvirginia"
$environmentName = Get-Input "Environment name" "airgap"

Write-Host ""
Write-Info "Application configuration:"
$searchIndexName = Get-Input "Search index name" "images-index"
$storageContainerName = Get-Input "Storage container name" "images"

Write-Host ""
Write-Success "Configuration captured"
Wait-Continue

##############################################################################
# Resource Group
##############################################################################

Write-Section "Step 3: Resource Group Setup"

Write-Info "Resource Group: $resourceGroup"
Write-Info "Location: $location"
Write-Host ""

if (Get-YesNo "Use existing resource group?" $false) {
    try {
        $null = az group show --name $resourceGroup 2>$null
        Write-Success "Resource group '$resourceGroup' exists and will be used"
    } catch {
        Write-Error "Resource group '$resourceGroup' not found"
        exit 1
    }
} else {
    Write-Info "Creating resource group '$resourceGroup'..."
    try {
        $null = az group create --name $resourceGroup --location $location 2>$null
        Write-Success "Resource group created"
    } catch {
        Write-Error "Failed to create resource group"
        exit 1
    }
}

Wait-Continue

##############################################################################
# Azure AI Search Service
##############################################################################

Write-Section "Step 4: Azure AI Search Service"

Write-Info "Azure AI Search is required for vector search capabilities."
Write-Host ""

if (Get-YesNo "Use existing Azure AI Search service?" $false) {
    $searchServiceName = Get-Input "Search service name"
    $searchResourceGroup = Get-Input "Search service resource group" $resourceGroup
    
    # Verify it exists
    try {
        $null = az search service show --name $searchServiceName --resource-group $searchResourceGroup 2>$null
        Write-Success "Search service '$searchServiceName' found"
    } catch {
        Write-Error "Search service '$searchServiceName' not found in resource group '$searchResourceGroup'"
        exit 1
    }
} else {
    $searchServiceName = Get-Input "New search service name" "search-$environmentName"
    $searchResourceGroup = $resourceGroup
    $searchSku = Get-Input "Search service SKU (free, basic, standard)" "standard"
    
    Write-Info "Creating Azure AI Search service '$searchServiceName'..."
    Write-Warning "This may take several minutes..."
    
    try {
        $null = az search service create `
            --name $searchServiceName `
            --resource-group $searchResourceGroup `
            --sku $searchSku `
            --partition-count 1 `
            --replica-count 1 `
            --location $location 2>$null
        Write-Success "Search service created"
    } catch {
        Write-Error "Failed to create search service"
        exit 1
    }
}

# Get search service endpoint
$searchEndpoint = "https://$searchServiceName.search.windows.net"
Write-Info "Search endpoint: $searchEndpoint"

Wait-Continue

##############################################################################
# Azure Computer Vision (Cognitive Services)
##############################################################################

Write-Section "Step 5: Azure Computer Vision Service"

Write-Info "Azure Computer Vision is required for multi-modal embeddings."
Write-Host ""

if (Get-YesNo "Use existing Computer Vision service?" $false) {
    $visionAccountName = Get-Input "Computer Vision account name"
    $visionResourceGroup = Get-Input "Computer Vision resource group" $resourceGroup
    
    # Verify it exists
    try {
        $null = az cognitiveservices account show `
            --name $visionAccountName `
            --resource-group $visionResourceGroup 2>$null
        Write-Success "Computer Vision account '$visionAccountName' found"
    } catch {
        Write-Error "Computer Vision account '$visionAccountName' not found"
        exit 1
    }
} else {
    $visionAccountName = Get-Input "New Computer Vision account name" "vision-$environmentName"
    $visionResourceGroup = $resourceGroup
    $visionSku = Get-Input "Computer Vision SKU (F0, S1)" "S1"
    
    Write-Info "Creating Computer Vision account '$visionAccountName'..."
    
    try {
        $null = az cognitiveservices account create `
            --name $visionAccountName `
            --resource-group $visionResourceGroup `
            --kind ComputerVision `
            --sku $visionSku `
            --location $location `
            --yes 2>$null
        Write-Success "Computer Vision account created"
    } catch {
        Write-Error "Failed to create Computer Vision account"
        exit 1
    }
}

# Get vision endpoint
$visionEndpoint = az cognitiveservices account show `
    --name $visionAccountName `
    --resource-group $visionResourceGroup `
    --query properties.endpoint -o tsv
Write-Info "Vision endpoint: $visionEndpoint"

Wait-Continue

##############################################################################
# Azure Storage Account
##############################################################################

Write-Section "Step 6: Azure Storage Account"

Write-Info "Storage account is required for storing image data."
Write-Host ""

if (Get-YesNo "Use existing storage account?" $false) {
    $storageAccountName = Get-Input "Storage account name"
    $storageResourceGroup = Get-Input "Storage resource group" $resourceGroup
    
    # Verify it exists
    try {
        $null = az storage account show `
            --name $storageAccountName `
            --resource-group $storageResourceGroup 2>$null
        Write-Success "Storage account '$storageAccountName' found"
    } catch {
        Write-Error "Storage account '$storageAccountName' not found"
        exit 1
    }
} else {
    $storageAccountName = Get-Input "New storage account name" "st$($environmentName)img"
    # Remove dashes and limit length
    $storageAccountName = $storageAccountName.Replace('-', '').Substring(0, [Math]::Min(24, $storageAccountName.Length))
    $storageResourceGroup = $resourceGroup
    
    Write-Info "Creating storage account '$storageAccountName'..."
    
    try {
        $null = az storage account create `
            --name $storageAccountName `
            --resource-group $storageResourceGroup `
            --location $location `
            --sku Standard_LRS `
            --allow-blob-public-access false 2>$null
        Write-Success "Storage account created"
    } catch {
        Write-Error "Failed to create storage account"
        exit 1
    }
}

Wait-Continue

##############################################################################
# Container Registry
##############################################################################

Write-Section "Step 7: Azure Container Registry"

Write-Info "Container Registry is needed for storing container images."
Write-Host ""

if (Get-YesNo "Use existing container registry?" $false) {
    $containerRegistryName = Get-Input "Container registry name"
    $containerRegistryRg = Get-Input "Container registry resource group" $resourceGroup
    
    # Verify it exists
    try {
        $null = az acr show `
            --name $containerRegistryName `
            --resource-group $containerRegistryRg 2>$null
        Write-Success "Container registry '$containerRegistryName' found"
    } catch {
        Write-Error "Container registry '$containerRegistryName' not found"
        exit 1
    }
} else {
    $containerRegistryName = Get-Input "New container registry name" "acr$environmentName"
    # Remove dashes
    $containerRegistryName = $containerRegistryName.Replace('-', '')
    $containerRegistryRg = $resourceGroup
    $registrySku = Get-Input "Registry SKU (Basic, Standard, Premium)" "Standard"
    
    Write-Info "Creating container registry '$containerRegistryName'..."
    
    try {
        $null = az acr create `
            --name $containerRegistryName `
            --resource-group $containerRegistryRg `
            --sku $registrySku `
            --location $location 2>$null
        Write-Success "Container registry created"
    } catch {
        Write-Error "Failed to create container registry"
        exit 1
    }
}

Wait-Continue

##############################################################################
# Managed Identity
##############################################################################

Write-Section "Step 8: Managed Identity Setup"

Write-Info "Creating user-assigned managed identity for secure authentication..."
Write-Host ""

$identityName = "id-imagesearch-$environmentName"

if (Get-YesNo "Create managed identity '$identityName'?" $true) {
    Write-Info "Creating managed identity..."
    
    try {
        $null = az identity create `
            --name $identityName `
            --resource-group $resourceGroup 2>$null
        Write-Success "Managed identity created"
    } catch {
        Write-Warning "Identity may already exist or creation failed"
    }
    
    # Get identity details
    $identityId = az identity show `
        --name $identityName `
        --resource-group $resourceGroup `
        --query id -o tsv
    
    $identityPrincipalId = az identity show `
        --name $identityName `
        --resource-group $resourceGroup `
        --query principalId -o tsv
    
    Write-Info "Identity ID: $identityId"
    Write-Info "Principal ID: $identityPrincipalId"
    
    # Wait for identity propagation
    Write-Info "Waiting 30 seconds for identity propagation..."
    Start-Sleep -Seconds 30
    
    Wait-Continue
    
    ##########################################################################
    # Role Assignments
    ##########################################################################
    
    Write-Section "Step 9: Role Assignments"
    
    Write-Info "Assigning required roles to managed identity..."
    Write-Host ""
    
    # Search Service - Search Index Data Contributor
    Write-Info "Assigning 'Search Index Data Contributor' role..."
    $searchResourceId = az search service show `
        --name $searchServiceName `
        --resource-group $searchResourceGroup `
        --query id -o tsv
    
    try {
        $null = az role assignment create `
            --assignee $identityPrincipalId `
            --role "Search Index Data Contributor" `
            --scope $searchResourceId 2>$null
        Write-Success "Search role assigned"
    } catch {
        Write-Warning "Search role assignment may already exist"
    }
    
    # Storage Account - Storage Blob Data Contributor
    Write-Info "Assigning 'Storage Blob Data Contributor' role..."
    $storageResourceId = az storage account show `
        --name $storageAccountName `
        --resource-group $storageResourceGroup `
        --query id -o tsv
    
    try {
        $null = az role assignment create `
            --assignee $identityPrincipalId `
            --role "Storage Blob Data Contributor" `
            --scope $storageResourceId 2>$null
        Write-Success "Storage role assigned"
    } catch {
        Write-Warning "Storage role assignment may already exist"
    }
    
    # Cognitive Services - Cognitive Services User
    Write-Info "Assigning 'Cognitive Services User' role..."
    $visionResourceId = az cognitiveservices account show `
        --name $visionAccountName `
        --resource-group $visionResourceGroup `
        --query id -o tsv
    
    try {
        $null = az role assignment create `
            --assignee $identityPrincipalId `
            --role "Cognitive Services User" `
            --scope $visionResourceId 2>$null
        Write-Success "Cognitive Services role assigned"
    } catch {
        Write-Warning "Cognitive Services role assignment may already exist"
    }
    
    # ACR Pull role
    Write-Info "Assigning 'AcrPull' role..."
    $acrResourceId = az acr show `
        --name $containerRegistryName `
        --resource-group $containerRegistryRg `
        --query id -o tsv
    
    try {
        $null = az role assignment create `
            --assignee $identityPrincipalId `
            --role "AcrPull" `
            --scope $acrResourceId 2>$null
        Write-Success "ACR Pull role assigned"
    } catch {
        Write-Warning "ACR Pull role assignment may already exist"
    }
    
    Write-Success "Role assignments completed"
}

Wait-Continue

##############################################################################
# Container Image Upload
##############################################################################

Write-Section "Step 10: Container Image Upload"

if ($hasDocker) {
    Write-Info "Ready to upload container image to registry."
    Write-Host ""
    
    if (Get-YesNo "Upload container image now?" $true) {
        $imageTar = Get-Input "Path to container image tar file" ".\imagesearch-backend.tar"
        
        if (-not (Test-Path $imageTar)) {
            Write-Error "Image file not found: $imageTar"
            Write-Warning "Skipping container upload. You'll need to upload manually."
        } else {
            Write-Info "Loading container image from $imageTar..."
            try {
                docker load -i $imageTar
                Write-Success "Image loaded"
                
                Write-Info "Logging into container registry..."
                az acr login --name $containerRegistryName
                Write-Success "Logged in to registry"
                
                $imageName = "imagesearch-backend"
                $imageTag = "latest"
                $fullImageName = "$containerRegistryName.azurecr.io/$imageName:$imageTag"
                
                Write-Info "Tagging image as $fullImageName..."
                docker tag "$($imageName):latest" $fullImageName
                
                Write-Info "Pushing image to registry..."
                docker push $fullImageName
                Write-Success "Image pushed to registry"
            } catch {
                Write-Error "Failed to process container image: $_"
            }
        }
    }
} else {
    Write-Warning "Docker not available. Skipping container image upload."
    Write-Info "You'll need to manually upload your container image to:"
    Write-Info "  Registry: $containerRegistryName.azurecr.io"
}

Wait-Continue

##############################################################################
# Container Apps Environment
##############################################################################

Write-Section "Step 11: Container Apps Environment"

Write-Info "Container Apps provides a managed container hosting environment."
Write-Host ""

if (Get-YesNo "Create Container Apps environment?" $true) {
    $containerAppsEnvName = "env-imagesearch-$environmentName"
    
    Write-Info "Creating Container Apps environment '$containerAppsEnvName'..."
    Write-Warning "This may take several minutes..."
    
    try {
        $null = az containerapp env create `
            --name $containerAppsEnvName `
            --resource-group $resourceGroup `
            --location $location 2>$null
        Write-Success "Container Apps environment created"
    } catch {
        Write-Error "Failed to create Container Apps environment"
        exit 1
    }
}

Wait-Continue

##############################################################################
# Deploy Container App
##############################################################################

Write-Section "Step 12: Deploy Container App"

Write-Info "Ready to deploy the application container."
Write-Host ""

if (Get-YesNo "Deploy container app now?" $true) {
    $appName = "app-imagesearch-$environmentName"
    $imageName = "imagesearch-backend"
    $imageTag = Get-Input "Image tag" "latest"
    $fullImageName = "$containerRegistryName.azurecr.io/$imageName:$imageTag"
    
    Write-Info "Deploying container app '$appName'..."
    Write-Info "Image: $fullImageName"
    
    try {
        $null = az containerapp create `
            --name $appName `
            --resource-group $resourceGroup `
            --environment $containerAppsEnvName `
            --image $fullImageName `
            --target-port 50505 `
            --ingress external `
            --registry-server "$containerRegistryName.azurecr.io" `
            --user-assigned $identityId `
            --env-vars `
                "AZURE_SEARCH_SERVICE=$searchServiceName" `
                "AZURE_SEARCH_INDEX=$searchIndexName" `
                "AZURE_COMPUTERVISION_ACCOUNT_URL=$visionEndpoint" `
                "AZURE_STORAGE_ACCOUNT_NAME=$storageAccountName" `
                "AZURE_STORAGE_CONTAINER=$storageContainerName" `
            --cpu 0.5 `
            --memory 1.0Gi `
            --min-replicas 1 `
            --max-replicas 3 2>$null
        Write-Success "Container app deployed"
        
        # Get app URL
        $appUrl = az containerapp show `
            --name $appName `
            --resource-group $resourceGroup `
            --query properties.configuration.ingress.fqdn -o tsv
        
        Write-Success "Application URL: https://$appUrl"
    } catch {
        Write-Error "Failed to deploy container app: $_"
    }
}

Wait-Continue

##############################################################################
# Upload Sample Data
##############################################################################

Write-Section "Step 13: Upload Sample Data"

Write-Info "Upload sample images to storage account."
Write-Host ""

if (Get-YesNo "Upload sample images now?" $true) {
    # Create storage container
    Write-Info "Creating storage container '$storageContainerName'..."
    try {
        $null = az storage container create `
            --name $storageContainerName `
            --account-name $storageAccountName `
            --auth-mode login 2>$null
        Write-Success "Container created"
    } catch {
        Write-Warning "Container may already exist"
    }
    
    $imagesPath = Get-Input "Path to images directory" ".\nature"
    
    if (Test-Path $imagesPath) {
        Write-Info "Uploading images from $imagesPath..."
        try {
            $null = az storage blob upload-batch `
                --destination $storageContainerName `
                --account-name $storageAccountName `
                --source $imagesPath `
                --auth-mode login 2>$null
            Write-Success "Images uploaded"
        } catch {
            Write-Error "Failed to upload images: $_"
        }
    } else {
        Write-Warning "Images directory not found: $imagesPath"
        Write-Info "You'll need to upload images manually."
    }
}

Wait-Continue

##############################################################################
# Summary
##############################################################################

Write-Section "Deployment Summary"

Write-Success "Deployment completed!"
Write-Host ""
Write-Info "Resource Summary:"
Write-Host "  Resource Group:        $resourceGroup"
Write-Host "  Location:              $location"
Write-Host "  Search Service:        $searchServiceName"
Write-Host "  Computer Vision:       $visionAccountName"
Write-Host "  Storage Account:       $storageAccountName"
Write-Host "  Container Registry:    $containerRegistryName"
Write-Host "  Container App:         $appName"
Write-Host "  Managed Identity:      $identityName"
Write-Host ""

if ($appUrl) {
    Write-Info "Application URL: https://$appUrl"
    Write-Host ""
}

Write-Info "Next Steps:"
Write-Host "  1. Initialize the search index with sample data"
Write-Host "  2. Verify the application is accessible"
Write-Host "  3. Configure network security (private endpoints, NSGs)"
Write-Host "  4. Set up monitoring and diagnostics"
Write-Host "  5. Review security hardening options in AIRGAP_DEPLOYMENT.md"
Write-Host ""

Write-Success "Setup complete! See AIRGAP_DEPLOYMENT.md for additional configuration."
