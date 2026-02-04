#!/bin/bash
#
# Deploy AgentChatV2 Backend as a container to Azure App Service
# Supports Azure Commercial, Government, and Sovereign Clouds
#
# Usage:
#   ./deploy-backend.sh -g <resource-group> -a <app-service-name> -r <container-registry> [-c <cloud>] [-t <tag>] [-s]
#
# Options:
#   -g, --resource-group      Azure Resource Group containing the App Service (required)
#   -a, --app-service         Azure App Service name (required)
#   -r, --registry            Azure Container Registry name without suffix (required)
#   -c, --cloud               Target cloud: AzureCloud, AzureUSGovernment, AzureChinaCloud (default: AzureUSGovernment)
#   -t, --tag                 Docker image tag (default: latest)
#   -s, --skip-build          Skip Docker build, use existing image
#   -h, --help                Show this help message

set -e

# Default values
CLOUD="AzureUSGovernment"
IMAGE_TAG="latest"
SKIP_BUILD=false

# Cloud configuration
declare -A ACR_SUFFIX
ACR_SUFFIX["AzureCloud"]="azurecr.io"
ACR_SUFFIX["AzureUSGovernment"]="azurecr.us"
ACR_SUFFIX["AzureChinaCloud"]="azurecr.cn"
ACR_SUFFIX["AzureGermanCloud"]="azurecr.de"

declare -A CLOUD_NAME
CLOUD_NAME["AzureCloud"]="Azure Commercial"
CLOUD_NAME["AzureUSGovernment"]="Azure Government"
CLOUD_NAME["AzureChinaCloud"]="Azure China"
CLOUD_NAME["AzureGermanCloud"]="Azure Germany"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

print_usage() {
    echo "Usage: $0 -g <resource-group> -a <app-service-name> -r <container-registry> [-c <cloud>] [-t <tag>] [-s]"
    echo ""
    echo "Options:"
    echo "  -g, --resource-group      Azure Resource Group (required)"
    echo "  -a, --app-service         Azure App Service name (required)"
    echo "  -r, --registry            Azure Container Registry name (required)"
    echo "  -c, --cloud               Target cloud (default: AzureUSGovernment)"
    echo "                            Options: AzureCloud, AzureUSGovernment, AzureChinaCloud, AzureGermanCloud"
    echo "  -t, --tag                 Docker image tag (default: latest)"
    echo "  -s, --skip-build          Skip Docker build"
    echo "  -h, --help                Show this help"
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -g|--resource-group)
            RESOURCE_GROUP="$2"
            shift 2
            ;;
        -a|--app-service)
            APP_SERVICE_NAME="$2"
            shift 2
            ;;
        -r|--registry)
            CONTAINER_REGISTRY="$2"
            shift 2
            ;;
        -c|--cloud)
            CLOUD="$2"
            shift 2
            ;;
        -t|--tag)
            IMAGE_TAG="$2"
            shift 2
            ;;
        -s|--skip-build)
            SKIP_BUILD=true
            shift
            ;;
        -h|--help)
            print_usage
            exit 0
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}"
            print_usage
            exit 1
            ;;
    esac
done

# Validate required parameters
if [[ -z "$RESOURCE_GROUP" || -z "$APP_SERVICE_NAME" || -z "$CONTAINER_REGISTRY" ]]; then
    echo -e "${RED}Error: Missing required parameters${NC}"
    print_usage
    exit 1
fi

# Validate cloud option
if [[ -z "${ACR_SUFFIX[$CLOUD]}" ]]; then
    echo -e "${RED}Error: Invalid cloud option: $CLOUD${NC}"
    echo "Valid options: AzureCloud, AzureUSGovernment, AzureChinaCloud, AzureGermanCloud"
    exit 1
fi

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(dirname "$SCRIPT_DIR")/backend"

# Image configuration
ACR_LOGIN_SERVER="${CONTAINER_REGISTRY}.${ACR_SUFFIX[$CLOUD]}"
IMAGE_NAME="agentchatv2-backend"
FULL_IMAGE_NAME="${ACR_LOGIN_SERVER}/${IMAGE_NAME}:${IMAGE_TAG}"

echo -e "${CYAN}========================================"
echo "AgentChatV2 Backend Deployment"
echo "Target Cloud: ${CLOUD_NAME[$CLOUD]}"
echo -e "========================================${NC}"

# Set Azure cloud environment
echo -e "\n${YELLOW}[1/6] Setting Azure cloud environment to $CLOUD...${NC}"
az cloud set --name "$CLOUD"

# Verify login
echo -e "\n${YELLOW}[2/6] Verifying Azure login...${NC}"
if ! az account show &>/dev/null; then
    echo -e "${YELLOW}Not logged in. Initiating login...${NC}"
    az login
fi
ACCOUNT_NAME=$(az account show --query "name" -o tsv)
USER_NAME=$(az account show --query "user.name" -o tsv)
echo -e "${GREEN}Logged in as: $USER_NAME${NC}"
echo -e "${GREEN}Subscription: $ACCOUNT_NAME${NC}"

# Login to ACR
echo -e "\n${YELLOW}[3/6] Logging into Azure Container Registry...${NC}"
az acr login --name "$CONTAINER_REGISTRY"

# Build Docker image
if [[ "$SKIP_BUILD" == false ]]; then
    echo -e "\n${YELLOW}[4/6] Building Docker image...${NC}"
    pushd "$BACKEND_DIR" > /dev/null
    docker build -t "$FULL_IMAGE_NAME" .
    popd > /dev/null

    # Push to ACR
    echo -e "\n${YELLOW}[5/6] Pushing image to ACR...${NC}"
    docker push "$FULL_IMAGE_NAME"
else
    echo -e "\n${YELLOW}[4/6] Skipping Docker build (using existing image)...${NC}"
    echo -e "${YELLOW}[5/6] Skipping image push...${NC}"
fi

# Configure App Service
echo -e "\n${YELLOW}[6/6] Configuring App Service to use container...${NC}"

# Get ACR credentials
ACR_USERNAME=$(az acr credential show --name "$CONTAINER_REGISTRY" --query "username" -o tsv)
ACR_PASSWORD=$(az acr credential show --name "$CONTAINER_REGISTRY" --query "passwords[0].value" -o tsv)

# Configure container
az webapp config container set \
    --resource-group "$RESOURCE_GROUP" \
    --name "$APP_SERVICE_NAME" \
    --container-image-name "$FULL_IMAGE_NAME" \
    --container-registry-url "https://${ACR_LOGIN_SERVER}" \
    --container-registry-user "$ACR_USERNAME" \
    --container-registry-password "$ACR_PASSWORD"

# Configure app settings
echo -e "\n${YELLOW}Configuring App Service settings...${NC}"
az webapp config appsettings set \
    --resource-group "$RESOURCE_GROUP" \
    --name "$APP_SERVICE_NAME" \
    --settings \
        WEBSITES_PORT=5000 \
        DOCKER_ENABLE_CI=true

# Restart the app
echo -e "\n${YELLOW}Restarting App Service...${NC}"
az webapp restart --resource-group "$RESOURCE_GROUP" --name "$APP_SERVICE_NAME"

# Get the app URL
APP_URL=$(az webapp show --resource-group "$RESOURCE_GROUP" --name "$APP_SERVICE_NAME" --query "defaultHostName" -o tsv)

echo -e "\n${GREEN}========================================"
echo "Deployment Complete!"
echo -e "========================================${NC}"
echo -e "${CYAN}App URL: https://$APP_URL${NC}"
echo -e "${CYAN}Image: $FULL_IMAGE_NAME${NC}"
echo -e "\n${YELLOW}Note: It may take a few minutes for the container to start.${NC}"
