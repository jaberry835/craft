#!/bin/bash

##############################################################################
# Air-Gapped High-Side Deployment Script
# This script walks through each deployment step with confirmation prompts
# and allows pointing to existing resources.
##############################################################################

set -e

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_info() {
    echo -e "${BLUE}ℹ ${1}${NC}"
}

print_success() {
    echo -e "${GREEN}✓ ${1}${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠ ${1}${NC}"
}

print_error() {
    echo -e "${RED}✗ ${1}${NC}"
}

print_section() {
    echo ""
    echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}  ${1}${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
    echo ""
}

# Function to prompt for yes/no with default
prompt_yes_no() {
    local prompt="$1"
    local default="${2:-n}"
    local response
    
    if [ "$default" = "y" ]; then
        read -p "$prompt [Y/n]: " response
        response=${response:-y}
    else
        read -p "$prompt [y/N]: " response
        response=${response:-n}
    fi
    
    case "$response" in
        [yY][eE][sS]|[yY]) return 0 ;;
        *) return 1 ;;
    esac
}

# Function to prompt for input with default
prompt_input() {
    local prompt="$1"
    local default="$2"
    local response
    
    if [ -n "$default" ]; then
        read -p "$prompt [$default]: " response
        echo "${response:-$default}"
    else
        read -p "$prompt: " response
        echo "$response"
    fi
}

# Function to wait for user to continue
wait_continue() {
    echo ""
    read -p "Press ENTER to continue..." dummy
}

# Function to check if Azure CLI is installed
check_azure_cli() {
    if ! command -v az &> /dev/null; then
        print_error "Azure CLI is not installed. Please install it first."
        print_info "Visit: https://docs.microsoft.com/cli/azure/install-azure-cli"
        exit 1
    fi
    print_success "Azure CLI is installed"
}

# Function to check if logged into Azure
check_azure_login() {
    if ! az account show &> /dev/null; then
        print_error "Not logged into Azure. Please run 'az login' first."
        exit 1
    fi
    print_success "Logged into Azure"
    
    CURRENT_SUBSCRIPTION=$(az account show --query name -o tsv)
    print_info "Current subscription: $CURRENT_SUBSCRIPTION"
    
    if ! prompt_yes_no "Continue with this subscription?" "y"; then
        print_info "Please run 'az account set --subscription <subscription-id>' to change subscription"
        exit 0
    fi
}

# Function to check if Docker is available
check_docker() {
    if ! command -v docker &> /dev/null; then
        print_warning "Docker is not installed. Container image operations will be skipped."
        HAS_DOCKER=false
    else
        print_success "Docker is installed"
        HAS_DOCKER=true
    fi
}

##############################################################################
# Main Script
##############################################################################

clear
print_section "Air-Gapped High-Side Deployment Setup"

print_info "This script will guide you through deploying the Image Search application"
print_info "in an air-gapped environment. Each step will be explained and you will"
print_info "be prompted before any action is taken."
echo ""
print_warning "Prerequisites:"
print_info "  • Azure CLI installed and configured"
print_info "  • Appropriate RBAC permissions"
print_info "  • Container image tar file (if deploying containers)"
print_info "  • Sample data prepared"
echo ""

if ! prompt_yes_no "Ready to begin?" "y"; then
    print_info "Exiting. Run this script when ready."
    exit 0
fi

# Pre-flight checks
print_section "Step 1: Pre-flight Checks"

print_info "Checking prerequisites..."
check_azure_cli
check_azure_login
check_docker

print_success "Pre-flight checks passed"
wait_continue

##############################################################################
# Configuration
##############################################################################

print_section "Step 2: Configuration"

print_info "Please provide the deployment configuration."
echo ""

# Basic configuration
RESOURCE_GROUP=$(prompt_input "Resource Group name" "rg-imagesearch-airgap")
LOCATION=$(prompt_input "Azure region" "usgovvirginia")
ENVIRONMENT_NAME=$(prompt_input "Environment name" "airgap")

echo ""
print_info "Application configuration:"
SEARCH_INDEX_NAME=$(prompt_input "Search index name" "images-index")
STORAGE_CONTAINER_NAME=$(prompt_input "Storage container name" "images")

echo ""
print_success "Configuration captured"
wait_continue

##############################################################################
# Resource Group
##############################################################################

print_section "Step 3: Resource Group Setup"

print_info "Resource Group: $RESOURCE_GROUP"
print_info "Location: $LOCATION"
echo ""

if prompt_yes_no "Use existing resource group?" "n"; then
    if az group show --name "$RESOURCE_GROUP" &> /dev/null; then
        print_success "Resource group '$RESOURCE_GROUP' exists and will be used"
    else
        print_error "Resource group '$RESOURCE_GROUP' not found"
        exit 1
    fi
else
    print_info "Creating resource group '$RESOURCE_GROUP'..."
    if az group create --name "$RESOURCE_GROUP" --location "$LOCATION" > /dev/null; then
        print_success "Resource group created"
    else
        print_error "Failed to create resource group"
        exit 1
    fi
fi

wait_continue

##############################################################################
# Azure AI Search Service
##############################################################################

print_section "Step 4: Azure AI Search Service"

print_info "Azure AI Search is required for vector search capabilities."
echo ""

if prompt_yes_no "Use existing Azure AI Search service?" "n"; then
    SEARCH_SERVICE_NAME=$(prompt_input "Search service name")
    SEARCH_RESOURCE_GROUP=$(prompt_input "Search service resource group" "$RESOURCE_GROUP")
    
    # Verify it exists
    if az search service show --name "$SEARCH_SERVICE_NAME" --resource-group "$SEARCH_RESOURCE_GROUP" &> /dev/null; then
        print_success "Search service '$SEARCH_SERVICE_NAME' found"
    else
        print_error "Search service '$SEARCH_SERVICE_NAME' not found in resource group '$SEARCH_RESOURCE_GROUP'"
        exit 1
    fi
else
    SEARCH_SERVICE_NAME=$(prompt_input "New search service name" "search-${ENVIRONMENT_NAME}")
    SEARCH_RESOURCE_GROUP="$RESOURCE_GROUP"
    SEARCH_SKU=$(prompt_input "Search service SKU (free, basic, standard)" "standard")
    
    print_info "Creating Azure AI Search service '$SEARCH_SERVICE_NAME'..."
    print_warning "This may take several minutes..."
    
    if az search service create \
        --name "$SEARCH_SERVICE_NAME" \
        --resource-group "$SEARCH_RESOURCE_GROUP" \
        --sku "$SEARCH_SKU" \
        --partition-count 1 \
        --replica-count 1 \
        --location "$LOCATION" > /dev/null; then
        print_success "Search service created"
    else
        print_error "Failed to create search service"
        exit 1
    fi
fi

# Get search service endpoint
SEARCH_ENDPOINT="https://${SEARCH_SERVICE_NAME}.search.windows.net"
print_info "Search endpoint: $SEARCH_ENDPOINT"

wait_continue

##############################################################################
# Azure Computer Vision (Cognitive Services)
##############################################################################

print_section "Step 5: Azure Computer Vision Service"

print_info "Azure Computer Vision is required for multi-modal embeddings."
echo ""

if prompt_yes_no "Use existing Computer Vision service?" "n"; then
    VISION_ACCOUNT_NAME=$(prompt_input "Computer Vision account name")
    VISION_RESOURCE_GROUP=$(prompt_input "Computer Vision resource group" "$RESOURCE_GROUP")
    
    # Verify it exists
    if az cognitiveservices account show \
        --name "$VISION_ACCOUNT_NAME" \
        --resource-group "$VISION_RESOURCE_GROUP" &> /dev/null; then
        print_success "Computer Vision account '$VISION_ACCOUNT_NAME' found"
    else
        print_error "Computer Vision account '$VISION_ACCOUNT_NAME' not found"
        exit 1
    fi
else
    VISION_ACCOUNT_NAME=$(prompt_input "New Computer Vision account name" "vision-${ENVIRONMENT_NAME}")
    VISION_RESOURCE_GROUP="$RESOURCE_GROUP"
    VISION_SKU=$(prompt_input "Computer Vision SKU (F0, S1)" "S1")
    
    print_info "Creating Computer Vision account '$VISION_ACCOUNT_NAME'..."
    
    if az cognitiveservices account create \
        --name "$VISION_ACCOUNT_NAME" \
        --resource-group "$VISION_RESOURCE_GROUP" \
        --kind ComputerVision \
        --sku "$VISION_SKU" \
        --location "$LOCATION" \
        --yes > /dev/null; then
        print_success "Computer Vision account created"
    else
        print_error "Failed to create Computer Vision account"
        exit 1
    fi
fi

# Get vision endpoint
VISION_ENDPOINT=$(az cognitiveservices account show \
    --name "$VISION_ACCOUNT_NAME" \
    --resource-group "$VISION_RESOURCE_GROUP" \
    --query properties.endpoint -o tsv)
print_info "Vision endpoint: $VISION_ENDPOINT"

wait_continue

##############################################################################
# Azure Storage Account
##############################################################################

print_section "Step 6: Azure Storage Account"

print_info "Storage account is required for storing image data."
echo ""

if prompt_yes_no "Use existing storage account?" "n"; then
    STORAGE_ACCOUNT_NAME=$(prompt_input "Storage account name")
    STORAGE_RESOURCE_GROUP=$(prompt_input "Storage resource group" "$RESOURCE_GROUP")
    
    # Verify it exists
    if az storage account show \
        --name "$STORAGE_ACCOUNT_NAME" \
        --resource-group "$STORAGE_RESOURCE_GROUP" &> /dev/null; then
        print_success "Storage account '$STORAGE_ACCOUNT_NAME' found"
    else
        print_error "Storage account '$STORAGE_ACCOUNT_NAME' not found"
        exit 1
    fi
else
    STORAGE_ACCOUNT_NAME=$(prompt_input "New storage account name" "st${ENVIRONMENT_NAME}img")
    # Remove dashes and limit length
    STORAGE_ACCOUNT_NAME=$(echo "$STORAGE_ACCOUNT_NAME" | tr -d '-' | cut -c1-24)
    STORAGE_RESOURCE_GROUP="$RESOURCE_GROUP"
    
    print_info "Creating storage account '$STORAGE_ACCOUNT_NAME'..."
    
    if az storage account create \
        --name "$STORAGE_ACCOUNT_NAME" \
        --resource-group "$STORAGE_RESOURCE_GROUP" \
        --location "$LOCATION" \
        --sku Standard_LRS \
        --allow-blob-public-access false > /dev/null; then
        print_success "Storage account created"
    else
        print_error "Failed to create storage account"
        exit 1
    fi
fi

wait_continue

##############################################################################
# Container Registry
##############################################################################

print_section "Step 7: Azure Container Registry"

print_info "Container Registry is needed for storing container images."
echo ""

if prompt_yes_no "Use existing container registry?" "n"; then
    CONTAINER_REGISTRY_NAME=$(prompt_input "Container registry name")
    CONTAINER_REGISTRY_RG=$(prompt_input "Container registry resource group" "$RESOURCE_GROUP")
    
    # Verify it exists
    if az acr show \
        --name "$CONTAINER_REGISTRY_NAME" \
        --resource-group "$CONTAINER_REGISTRY_RG" &> /dev/null; then
        print_success "Container registry '$CONTAINER_REGISTRY_NAME' found"
    else
        print_error "Container registry '$CONTAINER_REGISTRY_NAME' not found"
        exit 1
    fi
else
    CONTAINER_REGISTRY_NAME=$(prompt_input "New container registry name" "acr${ENVIRONMENT_NAME}")
    # Remove dashes
    CONTAINER_REGISTRY_NAME=$(echo "$CONTAINER_REGISTRY_NAME" | tr -d '-')
    CONTAINER_REGISTRY_RG="$RESOURCE_GROUP"
    REGISTRY_SKU=$(prompt_input "Registry SKU (Basic, Standard, Premium)" "Standard")
    
    print_info "Creating container registry '$CONTAINER_REGISTRY_NAME'..."
    
    if az acr create \
        --name "$CONTAINER_REGISTRY_NAME" \
        --resource-group "$CONTAINER_REGISTRY_RG" \
        --sku "$REGISTRY_SKU" \
        --location "$LOCATION" > /dev/null; then
        print_success "Container registry created"
    else
        print_error "Failed to create container registry"
        exit 1
    fi
fi

wait_continue

##############################################################################
# Managed Identity
##############################################################################

print_section "Step 8: Managed Identity Setup"

print_info "Creating user-assigned managed identity for secure authentication..."
echo ""

IDENTITY_NAME="id-imagesearch-${ENVIRONMENT_NAME}"

if prompt_yes_no "Create managed identity '$IDENTITY_NAME'?" "y"; then
    print_info "Creating managed identity..."
    
    if az identity create \
        --name "$IDENTITY_NAME" \
        --resource-group "$RESOURCE_GROUP" > /dev/null; then
        print_success "Managed identity created"
    else
        print_warning "Identity may already exist or creation failed"
    fi
    
    # Get identity details
    IDENTITY_ID=$(az identity show \
        --name "$IDENTITY_NAME" \
        --resource-group "$RESOURCE_GROUP" \
        --query id -o tsv)
    
    IDENTITY_PRINCIPAL_ID=$(az identity show \
        --name "$IDENTITY_NAME" \
        --resource-group "$RESOURCE_GROUP" \
        --query principalId -o tsv)
    
    print_info "Identity ID: $IDENTITY_ID"
    print_info "Principal ID: $IDENTITY_PRINCIPAL_ID"
    
    # Wait for identity propagation
    print_info "Waiting 30 seconds for identity propagation..."
    sleep 30
    
    wait_continue
    
    ##########################################################################
    # Role Assignments
    ##########################################################################
    
    print_section "Step 9: Role Assignments"
    
    print_info "Assigning required roles to managed identity..."
    echo ""
    
    # Search Service - Search Index Data Contributor
    print_info "Assigning 'Search Index Data Contributor' role..."
    SEARCH_RESOURCE_ID=$(az search service show \
        --name "$SEARCH_SERVICE_NAME" \
        --resource-group "$SEARCH_RESOURCE_GROUP" \
        --query id -o tsv)
    
    if az role assignment create \
        --assignee "$IDENTITY_PRINCIPAL_ID" \
        --role "Search Index Data Contributor" \
        --scope "$SEARCH_RESOURCE_ID" > /dev/null 2>&1; then
        print_success "Search role assigned"
    else
        print_warning "Search role assignment may already exist"
    fi
    
    # Storage Account - Storage Blob Data Contributor
    print_info "Assigning 'Storage Blob Data Contributor' role..."
    STORAGE_RESOURCE_ID=$(az storage account show \
        --name "$STORAGE_ACCOUNT_NAME" \
        --resource-group "$STORAGE_RESOURCE_GROUP" \
        --query id -o tsv)
    
    if az role assignment create \
        --assignee "$IDENTITY_PRINCIPAL_ID" \
        --role "Storage Blob Data Contributor" \
        --scope "$STORAGE_RESOURCE_ID" > /dev/null 2>&1; then
        print_success "Storage role assigned"
    else
        print_warning "Storage role assignment may already exist"
    fi
    
    # Cognitive Services - Cognitive Services User
    print_info "Assigning 'Cognitive Services User' role..."
    VISION_RESOURCE_ID=$(az cognitiveservices account show \
        --name "$VISION_ACCOUNT_NAME" \
        --resource-group "$VISION_RESOURCE_GROUP" \
        --query id -o tsv)
    
    if az role assignment create \
        --assignee "$IDENTITY_PRINCIPAL_ID" \
        --role "Cognitive Services User" \
        --scope "$VISION_RESOURCE_ID" > /dev/null 2>&1; then
        print_success "Cognitive Services role assigned"
    else
        print_warning "Cognitive Services role assignment may already exist"
    fi
    
    # ACR Pull role
    print_info "Assigning 'AcrPull' role..."
    ACR_RESOURCE_ID=$(az acr show \
        --name "$CONTAINER_REGISTRY_NAME" \
        --resource-group "$CONTAINER_REGISTRY_RG" \
        --query id -o tsv)
    
    if az role assignment create \
        --assignee "$IDENTITY_PRINCIPAL_ID" \
        --role "AcrPull" \
        --scope "$ACR_RESOURCE_ID" > /dev/null 2>&1; then
        print_success "ACR Pull role assigned"
    else
        print_warning "ACR Pull role assignment may already exist"
    fi
    
    print_success "Role assignments completed"
fi

wait_continue

##############################################################################
# Container Image Upload
##############################################################################

print_section "Step 10: Container Image Upload"

if [ "$HAS_DOCKER" = true ]; then
    print_info "Ready to upload container image to registry."
    echo ""
    
    if prompt_yes_no "Upload container image now?" "y"; then
        IMAGE_TAR=$(prompt_input "Path to container image tar file" "./imagesearch-backend.tar")
        
        if [ ! -f "$IMAGE_TAR" ]; then
            print_error "Image file not found: $IMAGE_TAR"
            print_warning "Skipping container upload. You'll need to upload manually."
        else
            print_info "Loading container image from $IMAGE_TAR..."
            if docker load -i "$IMAGE_TAR"; then
                print_success "Image loaded"
                
                print_info "Logging into container registry..."
                if az acr login --name "$CONTAINER_REGISTRY_NAME"; then
                    print_success "Logged in to registry"
                    
                    IMAGE_NAME="imagesearch-backend"
                    IMAGE_TAG="latest"
                    FULL_IMAGE_NAME="${CONTAINER_REGISTRY_NAME}.azurecr.io/${IMAGE_NAME}:${IMAGE_TAG}"
                    
                    print_info "Tagging image as $FULL_IMAGE_NAME..."
                    docker tag "${IMAGE_NAME}:latest" "$FULL_IMAGE_NAME"
                    
                    print_info "Pushing image to registry..."
                    if docker push "$FULL_IMAGE_NAME"; then
                        print_success "Image pushed to registry"
                    else
                        print_error "Failed to push image"
                    fi
                else
                    print_error "Failed to login to registry"
                fi
            else
                print_error "Failed to load image"
            fi
        fi
    fi
else
    print_warning "Docker not available. Skipping container image upload."
    print_info "You'll need to manually upload your container image to:"
    print_info "  Registry: ${CONTAINER_REGISTRY_NAME}.azurecr.io"
fi

wait_continue

##############################################################################
# Container Apps Environment
##############################################################################

print_section "Step 11: Container Apps Environment"

print_info "Container Apps provides a managed container hosting environment."
echo ""

if prompt_yes_no "Create Container Apps environment?" "y"; then
    CONTAINERAPPS_ENV_NAME="env-imagesearch-${ENVIRONMENT_NAME}"
    
    print_info "Creating Container Apps environment '$CONTAINERAPPS_ENV_NAME'..."
    print_warning "This may take several minutes..."
    
    if az containerapp env create \
        --name "$CONTAINERAPPS_ENV_NAME" \
        --resource-group "$RESOURCE_GROUP" \
        --location "$LOCATION" > /dev/null; then
        print_success "Container Apps environment created"
    else
        print_error "Failed to create Container Apps environment"
        exit 1
    fi
fi

wait_continue

##############################################################################
# Deploy Container App
##############################################################################

print_section "Step 12: Deploy Container App"

print_info "Ready to deploy the application container."
echo ""

if prompt_yes_no "Deploy container app now?" "y"; then
    APP_NAME="app-imagesearch-${ENVIRONMENT_NAME}"
    IMAGE_NAME="imagesearch-backend"
    IMAGE_TAG=$(prompt_input "Image tag" "latest")
    FULL_IMAGE_NAME="${CONTAINER_REGISTRY_NAME}.azurecr.io/${IMAGE_NAME}:${IMAGE_TAG}"
    
    print_info "Deploying container app '$APP_NAME'..."
    print_info "Image: $FULL_IMAGE_NAME"
    
    if az containerapp create \
        --name "$APP_NAME" \
        --resource-group "$RESOURCE_GROUP" \
        --environment "$CONTAINERAPPS_ENV_NAME" \
        --image "$FULL_IMAGE_NAME" \
        --target-port 50505 \
        --ingress external \
        --registry-server "${CONTAINER_REGISTRY_NAME}.azurecr.io" \
        --user-assigned "$IDENTITY_ID" \
        --env-vars \
            "AZURE_SEARCH_SERVICE=${SEARCH_SERVICE_NAME}" \
            "AZURE_SEARCH_INDEX=${SEARCH_INDEX_NAME}" \
            "AZURE_COMPUTERVISION_ACCOUNT_URL=${VISION_ENDPOINT}" \
            "AZURE_STORAGE_ACCOUNT_NAME=${STORAGE_ACCOUNT_NAME}" \
            "AZURE_STORAGE_CONTAINER=${STORAGE_CONTAINER_NAME}" \
        --cpu 0.5 \
        --memory 1.0Gi \
        --min-replicas 1 \
        --max-replicas 3 > /dev/null; then
        print_success "Container app deployed"
        
        # Get app URL
        APP_URL=$(az containerapp show \
            --name "$APP_NAME" \
            --resource-group "$RESOURCE_GROUP" \
            --query properties.configuration.ingress.fqdn -o tsv)
        
        print_success "Application URL: https://${APP_URL}"
    else
        print_error "Failed to deploy container app"
    fi
fi

wait_continue

##############################################################################
# Upload Sample Data
##############################################################################

print_section "Step 13: Upload Sample Data"

print_info "Upload sample images to storage account."
echo ""

if prompt_yes_no "Upload sample images now?" "y"; then
    # Create storage container
    print_info "Creating storage container '$STORAGE_CONTAINER_NAME'..."
    if az storage container create \
        --name "$STORAGE_CONTAINER_NAME" \
        --account-name "$STORAGE_ACCOUNT_NAME" \
        --auth-mode login > /dev/null 2>&1; then
        print_success "Container created"
    else
        print_warning "Container may already exist"
    fi
    
    IMAGES_PATH=$(prompt_input "Path to images directory" "./nature")
    
    if [ -d "$IMAGES_PATH" ]; then
        print_info "Uploading images from $IMAGES_PATH..."
        if az storage blob upload-batch \
            --destination "$STORAGE_CONTAINER_NAME" \
            --account-name "$STORAGE_ACCOUNT_NAME" \
            --source "$IMAGES_PATH" \
            --auth-mode login > /dev/null; then
            print_success "Images uploaded"
        else
            print_error "Failed to upload images"
        fi
    else
        print_warning "Images directory not found: $IMAGES_PATH"
        print_info "You'll need to upload images manually."
    fi
fi

wait_continue

##############################################################################
# Summary
##############################################################################

print_section "Deployment Summary"

print_success "Deployment completed!"
echo ""
print_info "Resource Summary:"
echo "  Resource Group:        $RESOURCE_GROUP"
echo "  Location:              $LOCATION"
echo "  Search Service:        $SEARCH_SERVICE_NAME"
echo "  Computer Vision:       $VISION_ACCOUNT_NAME"
echo "  Storage Account:       $STORAGE_ACCOUNT_NAME"
echo "  Container Registry:    $CONTAINER_REGISTRY_NAME"
echo "  Container App:         $APP_NAME"
echo "  Managed Identity:      $IDENTITY_NAME"
echo ""

if [ -n "$APP_URL" ]; then
    print_info "Application URL: https://${APP_URL}"
    echo ""
fi

print_info "Next Steps:"
echo "  1. Initialize the search index with sample data"
echo "  2. Verify the application is accessible"
echo "  3. Configure network security (private endpoints, NSGs)"
echo "  4. Set up monitoring and diagnostics"
echo "  5. Review security hardening options in AIRGAP_DEPLOYMENT.md"
echo ""

print_success "Setup complete! See AIRGAP_DEPLOYMENT.md for additional configuration."
