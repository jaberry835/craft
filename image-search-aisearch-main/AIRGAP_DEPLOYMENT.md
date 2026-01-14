# Air-Gapped High-Side Deployment Guide

This guide provides step-by-step instructions for deploying the Image Search application in an air-gapped, high-side environment where `azd` and automated deployments are not available.

## Table of Contents

1. [Overview](#overview)
2. [Prerequisites](#prerequisites)
3. [Pre-Deployment Preparation (Low-Side)](#pre-deployment-preparation-low-side)
4. [High-Side Deployment Process](#high-side-deployment-process)
5. [Resource Setup](#resource-setup)
6. [Container Deployment](#container-deployment)
7. [Post-Deployment Configuration](#post-deployment-configuration)
8. [Troubleshooting](#troubleshooting)

## Overview

This application requires the following Azure resources:
- **Azure AI Search Service** - For vector search capabilities
- **Azure Computer Vision (Cognitive Services)** - For multi-modal embeddings
- **Azure Storage Account** - For storing image data
- **Azure Container Registry** - For storing container images
- **Container Runtime Environment** - Azure Container Apps, AKS, or Docker

In an air-gapped environment, you'll need to:
1. Prepare all artifacts on the low side
2. Transfer them through the approved gateway
3. Manually deploy using provided scripts
4. Configure each resource with proper networking and security

## Prerequisites

### Low-Side Requirements
- Docker or Podman for building container images
- Access to Azure services for pre-staging resources
- Python 3.9+ and Node.js 14+ for building the application
- Network access to npmjs.org and pypi.org for downloading dependencies

### High-Side Requirements
- Azure subscription in the air-gapped environment
- Appropriate RBAC permissions:
  - Contributor or Owner role on resource group
  - User Access Administrator (for role assignments)
- Azure CLI installed and configured
- PowerShell 7+ (Windows) or Bash (Linux)
- Access to private container registry (or ability to create one)
- Access to existing Azure resources (if reusing)

### Required Information to Gather

Before deployment, collect the following information:

```bash
# Resource Group
RESOURCE_GROUP_NAME="rg-imagesearch-prod"
LOCATION="usgovvirginia"  # Or your air-gapped region

# Azure AI Search (if using existing)
SEARCH_SERVICE_NAME=""
SEARCH_RESOURCE_GROUP=""
SEARCH_ADMIN_KEY=""  # Optional, managed identity preferred

# Azure Computer Vision (if using existing)
VISION_ENDPOINT=""
VISION_KEY=""  # Optional, managed identity preferred
VISION_RESOURCE_GROUP=""

# Azure Storage (if using existing)
STORAGE_ACCOUNT_NAME=""
STORAGE_RESOURCE_GROUP=""
STORAGE_CONNECTION_STRING=""  # Optional, managed identity preferred

# Container Registry (if using existing)
CONTAINER_REGISTRY_NAME=""
CONTAINER_REGISTRY_RG=""

# Application Settings
SEARCH_INDEX_NAME="images-index"
STORAGE_CONTAINER_NAME="images"
```

## Pre-Deployment Preparation (Low-Side)

### Step 1: Build Application Artifacts

#### 1.1 Build Frontend

```bash
cd app/frontend
npm install
npm run build
```

This creates a production build in `app/frontend/dist/`.

#### 1.2 Prepare Backend with Frontend

```bash
# Copy frontend build to backend static directory
mkdir -p app/backend/static
cp -r app/frontend/dist/* app/backend/static/
```

#### 1.3 Build Container Image

```bash
cd app/backend

# Build the container image
docker build -t imagesearch-backend:latest .

# Save the image as a tar file for transfer
docker save imagesearch-backend:latest -o imagesearch-backend.tar
```

#### 1.4 Download Python Dependencies (Offline)

```bash
cd app/backend
pip download -r requirements.txt -d ./offline-packages
```

#### 1.5 Download Node Dependencies (Offline)

```bash
cd app/frontend
npm pack
# Or create offline mirror
npm install --prefer-offline --no-audit
tar -czf node_modules.tar.gz node_modules/
```

### Step 2: Prepare Sample Data

```bash
# Create archive of sample images
cd pictures
tar -czf ../image-samples.tar.gz nature/
```

### Step 3: Create Transfer Package

```bash
# At repository root
mkdir -p transfer-package
cp app/backend/imagesearch-backend.tar transfer-package/
cp app/backend/offline-packages transfer-package/ -r
cp image-samples.tar.gz transfer-package/
cp scripts/*.sh transfer-package/
cp scripts/*.ps1 transfer-package/
cp AIRGAP_DEPLOYMENT.md transfer-package/
cp app/backend/requirements.txt transfer-package/
```

Transfer `transfer-package/` through your approved gateway process.

## High-Side Deployment Process

Use the provided automated scripts for step-by-step deployment:

### Linux/Bash Deployment

```bash
cd transfer-package
chmod +x airgap-setup.sh
./airgap-setup.sh
```

### Windows/PowerShell Deployment

```powershell
cd transfer-package
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope Process
.\airgap-setup.ps1
```

The scripts will:
1. Prompt for configuration options
2. Check for existing resources
3. Create required Azure resources
4. Upload container images
5. Deploy the application
6. Configure role assignments

## Resource Setup

### Manual Resource Creation (Alternative)

If you prefer to create resources manually or use the Azure Portal:

#### 1. Create Resource Group

```bash
az group create \
  --name $RESOURCE_GROUP_NAME \
  --location $LOCATION
```

#### 2. Create Azure AI Search Service

```bash
az search service create \
  --name $SEARCH_SERVICE_NAME \
  --resource-group $RESOURCE_GROUP_NAME \
  --sku standard \
  --partition-count 1 \
  --replica-count 1
```

#### 3. Create Azure Computer Vision

```bash
az cognitiveservices account create \
  --name $VISION_ACCOUNT_NAME \
  --resource-group $RESOURCE_GROUP_NAME \
  --kind ComputerVision \
  --sku S1 \
  --location $LOCATION \
  --yes
```

#### 4. Create Storage Account

```bash
az storage account create \
  --name $STORAGE_ACCOUNT_NAME \
  --resource-group $RESOURCE_GROUP_NAME \
  --location $LOCATION \
  --sku Standard_LRS \
  --allow-blob-public-access false
```

#### 5. Create Container Registry

```bash
az acr create \
  --name $CONTAINER_REGISTRY_NAME \
  --resource-group $RESOURCE_GROUP_NAME \
  --sku Standard \
  --location $LOCATION
```

### Configure Managed Identities

#### Create User-Assigned Managed Identity

```bash
az identity create \
  --name imagesearch-identity \
  --resource-group $RESOURCE_GROUP_NAME

# Get the identity ID
IDENTITY_ID=$(az identity show \
  --name imagesearch-identity \
  --resource-group $RESOURCE_GROUP_NAME \
  --query id -o tsv)

IDENTITY_PRINCIPAL_ID=$(az identity show \
  --name imagesearch-identity \
  --resource-group $RESOURCE_GROUP_NAME \
  --query principalId -o tsv)
```

#### Assign Roles

```bash
# Search Service - Search Index Data Contributor
SEARCH_RESOURCE_ID=$(az search service show \
  --name $SEARCH_SERVICE_NAME \
  --resource-group $SEARCH_RESOURCE_GROUP \
  --query id -o tsv)

az role assignment create \
  --assignee $IDENTITY_PRINCIPAL_ID \
  --role "Search Index Data Contributor" \
  --scope $SEARCH_RESOURCE_ID

# Storage Account - Storage Blob Data Contributor
STORAGE_RESOURCE_ID=$(az storage account show \
  --name $STORAGE_ACCOUNT_NAME \
  --resource-group $STORAGE_RESOURCE_GROUP \
  --query id -o tsv)

az role assignment create \
  --assignee $IDENTITY_PRINCIPAL_ID \
  --role "Storage Blob Data Contributor" \
  --scope $STORAGE_RESOURCE_ID

# Cognitive Services - Cognitive Services User
VISION_RESOURCE_ID=$(az cognitiveservices account show \
  --name $VISION_ACCOUNT_NAME \
  --resource-group $VISION_RESOURCE_GROUP \
  --query id -o tsv)

az role assignment create \
  --assignee $IDENTITY_PRINCIPAL_ID \
  --role "Cognitive Services User" \
  --scope $VISION_RESOURCE_ID
```

## Container Deployment

### Option 1: Azure Container Apps

#### Load and Push Container Image

```bash
# Load the container image
docker load -i imagesearch-backend.tar

# Login to ACR
az acr login --name $CONTAINER_REGISTRY_NAME

# Tag and push
docker tag imagesearch-backend:latest \
  $CONTAINER_REGISTRY_NAME.azurecr.io/imagesearch-backend:latest

docker push $CONTAINER_REGISTRY_NAME.azurecr.io/imagesearch-backend:latest
```

#### Create Container Apps Environment

```bash
az containerapp env create \
  --name imagesearch-env \
  --resource-group $RESOURCE_GROUP_NAME \
  --location $LOCATION
```

#### Deploy Container App

```bash
az containerapp create \
  --name imagesearch-app \
  --resource-group $RESOURCE_GROUP_NAME \
  --environment imagesearch-env \
  --image $CONTAINER_REGISTRY_NAME.azurecr.io/imagesearch-backend:latest \
  --target-port 50505 \
  --ingress external \
  --registry-server $CONTAINER_REGISTRY_NAME.azurecr.io \
  --user-assigned $IDENTITY_ID \
  --env-vars \
    AZURE_SEARCH_SERVICE=$SEARCH_SERVICE_NAME \
    AZURE_SEARCH_INDEX=$SEARCH_INDEX_NAME \
    AZURE_COMPUTERVISION_ACCOUNT_URL=https://$VISION_ACCOUNT_NAME.cognitiveservices.azure.com \
    AZURE_STORAGE_ACCOUNT_NAME=$STORAGE_ACCOUNT_NAME \
    AZURE_STORAGE_CONTAINER=$STORAGE_CONTAINER_NAME
```

### Option 2: Azure Kubernetes Service (AKS)

See `kubernetes-deployment.yaml` for Kubernetes manifests.

### Option 3: Standalone Docker/Podman

```bash
docker run -d \
  --name imagesearch \
  -p 50505:50505 \
  -e AZURE_SEARCH_SERVICE=$SEARCH_SERVICE_NAME \
  -e AZURE_SEARCH_INDEX=$SEARCH_INDEX_NAME \
  -e AZURE_COMPUTERVISION_ACCOUNT_URL=https://$VISION_ACCOUNT_NAME.cognitiveservices.azure.com \
  -e AZURE_STORAGE_ACCOUNT_NAME=$STORAGE_ACCOUNT_NAME \
  -e AZURE_STORAGE_CONTAINER=$STORAGE_CONTAINER_NAME \
  imagesearch-backend:latest
```

## Post-Deployment Configuration

### Step 1: Upload Sample Images

```bash
# Extract sample images
tar -xzf image-samples.tar.gz

# Create container
az storage container create \
  --name $STORAGE_CONTAINER_NAME \
  --account-name $STORAGE_ACCOUNT_NAME \
  --auth-mode login

# Upload images
az storage blob upload-batch \
  --destination $STORAGE_CONTAINER_NAME \
  --account-name $STORAGE_ACCOUNT_NAME \
  --source ./nature \
  --auth-mode login
```

### Step 2: Initialize Search Index

```bash
# Run the setup script from within the container
az containerapp exec \
  --name imagesearch-app \
  --resource-group $RESOURCE_GROUP_NAME \
  --command "python setup_search_service.py"
```

Or manually create the index using the Azure Portal or API.

### Step 3: Verify Deployment

```bash
# Get the application URL
APP_URL=$(az containerapp show \
  --name imagesearch-app \
  --resource-group $RESOURCE_GROUP_NAME \
  --query properties.configuration.ingress.fqdn -o tsv)

echo "Application URL: https://$APP_URL"

# Test the endpoint
curl https://$APP_URL/
```

### Step 4: Configure Network Security

#### Private Endpoints (Recommended for High-Side)

```bash
# Create VNet
az network vnet create \
  --name imagesearch-vnet \
  --resource-group $RESOURCE_GROUP_NAME \
  --address-prefix 10.0.0.0/16 \
  --subnet-name app-subnet \
  --subnet-prefix 10.0.1.0/24

# Create private endpoint for Storage
az network private-endpoint create \
  --name storage-pe \
  --resource-group $RESOURCE_GROUP_NAME \
  --vnet-name imagesearch-vnet \
  --subnet app-subnet \
  --private-connection-resource-id $STORAGE_RESOURCE_ID \
  --group-id blob \
  --connection-name storage-connection

# Similar for Search Service, Computer Vision, etc.
```

#### Network Security Groups

```bash
# Create NSG
az network nsg create \
  --name imagesearch-nsg \
  --resource-group $RESOURCE_GROUP_NAME

# Add rules as per security requirements
az network nsg rule create \
  --name allow-https \
  --nsg-name imagesearch-nsg \
  --resource-group $RESOURCE_GROUP_NAME \
  --priority 100 \
  --direction Inbound \
  --access Allow \
  --protocol Tcp \
  --destination-port-ranges 443
```

## Troubleshooting

### Container Fails to Start

```bash
# Check container logs
az containerapp logs show \
  --name imagesearch-app \
  --resource-group $RESOURCE_GROUP_NAME \
  --follow

# Common issues:
# 1. Missing environment variables
# 2. Incorrect managed identity configuration
# 3. Network connectivity to Azure services
```

### Authentication Errors

```bash
# Verify managed identity assignments
az role assignment list \
  --assignee $IDENTITY_PRINCIPAL_ID \
  --all

# Check if the identity has propagated (can take 5-10 minutes)
```

### Search Service Connection Issues

```bash
# Test connectivity
curl -H "api-key: $SEARCH_ADMIN_KEY" \
  "https://$SEARCH_SERVICE_NAME.search.windows.net/indexes?api-version=2024-07-01"
```

### Storage Access Issues

```bash
# Verify storage container exists
az storage container show \
  --name $STORAGE_CONTAINER_NAME \
  --account-name $STORAGE_ACCOUNT_NAME \
  --auth-mode login

# Check firewall rules
az storage account show \
  --name $STORAGE_ACCOUNT_NAME \
  --resource-group $STORAGE_RESOURCE_GROUP \
  --query networkRuleSet
```

## Security Hardening for High-Side

### 1. Disable Public Access

```bash
# Storage Account
az storage account update \
  --name $STORAGE_ACCOUNT_NAME \
  --resource-group $STORAGE_RESOURCE_GROUP \
  --allow-blob-public-access false

# Container Registry
az acr update \
  --name $CONTAINER_REGISTRY_NAME \
  --public-network-enabled false
```

### 2. Enable Diagnostic Logging

```bash
# Create Log Analytics Workspace
az monitor log-analytics workspace create \
  --resource-group $RESOURCE_GROUP_NAME \
  --workspace-name imagesearch-logs

WORKSPACE_ID=$(az monitor log-analytics workspace show \
  --resource-group $RESOURCE_GROUP_NAME \
  --workspace-name imagesearch-logs \
  --query id -o tsv)

# Enable diagnostics for Search Service
az monitor diagnostic-settings create \
  --name search-diagnostics \
  --resource $SEARCH_RESOURCE_ID \
  --workspace $WORKSPACE_ID \
  --logs '[{"category":"OperationLogs","enabled":true}]' \
  --metrics '[{"category":"AllMetrics","enabled":true}]'
```

### 3. Use Customer-Managed Keys (if required)

```bash
# Create Key Vault
az keyvault create \
  --name imagesearch-kv \
  --resource-group $RESOURCE_GROUP_NAME \
  --location $LOCATION

# Create key
az keyvault key create \
  --vault-name imagesearch-kv \
  --name storage-key \
  --protection software

# Configure storage account to use CMK
# (Follow specific procedures for your organization)
```

## Maintenance and Updates

### Updating the Application

1. Build new container image on low-side
2. Transfer through gateway
3. Load and push to ACR
4. Update container app:

```bash
az containerapp update \
  --name imagesearch-app \
  --resource-group $RESOURCE_GROUP_NAME \
  --image $CONTAINER_REGISTRY_NAME.azurecr.io/imagesearch-backend:v2
```

### Backup and Disaster Recovery

```bash
# Backup search index
# (Use Azure Search backup/restore procedures)

# Backup storage data
az storage blob sync \
  --account-name $STORAGE_ACCOUNT_NAME \
  --container $STORAGE_CONTAINER_NAME \
  --source ./backup \
  --destination backup-$(date +%Y%m%d)
```

## Additional Resources

- Azure Government Documentation
- Azure AI Search Documentation
- Azure Computer Vision Documentation
- Container Apps Documentation
- Azure Security Best Practices

---

**Note**: This guide assumes you are working in an Azure Government or similar air-gapped cloud environment. Adjust region names and endpoints according to your specific environment.
