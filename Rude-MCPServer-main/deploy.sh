#!/usr/bin/env bash
# Simple deployment script for existing Azure App Service
# This script deploys the Rude MCP Server to an existing Azure App Service

set -e  # Exit on any error

# Configuration - Update these values for your Azure App Service
APP_SERVICE_NAME=""  # Your existing App Service name
RESOURCE_GROUP=""    # Resource group containing your App Service
SUBSCRIPTION_ID=""   # Your Azure subscription ID (optional)

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Function to check if required tools are installed
check_prerequisites() {
    print_status "Checking prerequisites..."
    
    # Check if Azure CLI is installed
    if ! command -v az &> /dev/null; then
        print_error "Azure CLI is not installed. Please install it first."
        exit 1
    fi
    
    # Check if zip is available
    if ! command -v zip &> /dev/null; then
        print_error "zip command is not available. Please install it first."
        exit 1
    fi
    
    print_success "All prerequisites are available"
}

# Function to validate configuration
validate_config() {
    if [ -z "$APP_SERVICE_NAME" ]; then
        print_error "APP_SERVICE_NAME is not set. Please update the script configuration."
        exit 1
    fi
    
    if [ -z "$RESOURCE_GROUP" ]; then
        print_error "RESOURCE_GROUP is not set. Please update the script configuration."
        exit 1
    fi
    
    print_success "Configuration validated"
}

# Function to check Azure CLI login
check_azure_login() {
    print_status "Checking Azure CLI login status..."
    
    if ! az account show &> /dev/null; then
        print_error "Not logged in to Azure CLI. Please run 'az login' first."
        exit 1
    fi
    
    # Set subscription if provided
    if [ -n "$SUBSCRIPTION_ID" ]; then
        print_status "Setting Azure subscription to: $SUBSCRIPTION_ID"
        az account set --subscription "$SUBSCRIPTION_ID"
    fi
    
    # Display current account
    CURRENT_ACCOUNT=$(az account show --query "name" -o tsv)
    print_success "Logged in to Azure account: $CURRENT_ACCOUNT"
}

# Function to verify App Service exists
verify_app_service() {
    print_status "Verifying App Service exists..."
    
    if ! az webapp show --name "$APP_SERVICE_NAME" --resource-group "$RESOURCE_GROUP" &> /dev/null; then
        print_error "App Service '$APP_SERVICE_NAME' not found in resource group '$RESOURCE_GROUP'"
        exit 1
    fi
    
    # Get App Service details
    APP_SERVICE_URL=$(az webapp show --name "$APP_SERVICE_NAME" --resource-group "$RESOURCE_GROUP" --query "defaultHostName" -o tsv)
    print_success "App Service found: https://$APP_SERVICE_URL"
}

# Function to prepare deployment package
prepare_deployment() {
    print_status "Preparing deployment package..."
    
    # Create deployment directory
    DEPLOY_DIR="deploy_$(date +%Y%m%d_%H%M%S)"
    mkdir -p "$DEPLOY_DIR"
    
    # Copy application files
    print_status "Copying application files..."
    cp main.py "$DEPLOY_DIR/"
    cp startup.py "$DEPLOY_DIR/"
    cp requirements.txt "$DEPLOY_DIR/"
    cp .env "$DEPLOY_DIR/" 2>/dev/null || print_warning ".env file not found, skipping"
    
    # Copy the tools directory and all its contents
    if [ -d "tools" ]; then
        cp -r tools "$DEPLOY_DIR/"
        print_status "Copied tools directory"
    else
        print_error "Tools directory not found - deployment will fail!"
        exit 1
    fi
    
    # Copy root __init__.py if it exists (helps with module imports)
    if [ -f "__init__.py" ]; then
        cp __init__.py "$DEPLOY_DIR/"
        print_status "Copied root __init__.py"
    fi
    
    # Create zip package
    print_status "Creating deployment package..."
    cd "$DEPLOY_DIR"
    zip -r "../${DEPLOY_DIR}.zip" .
    cd ..
    
    print_success "Deployment package created: ${DEPLOY_DIR}.zip"
}

# Function to configure App Service settings
configure_app_service() {
    print_status "Configuring App Service settings..."
    
    # Set Python runtime
    print_status "Setting Python runtime to 3.11..."
    az webapp config set \
        --name "$APP_SERVICE_NAME" \
        --resource-group "$RESOURCE_GROUP" \
        --linux-fx-version "PYTHON|3.11"
    
    # Set startup command
    print_status "Setting startup command..."
    az webapp config set \
        --name "$APP_SERVICE_NAME" \
        --resource-group "$RESOURCE_GROUP" \
        --startup-file "startup.py"
    
    # Configure app settings from .env file if it exists
    if [ -f ".env" ]; then
        print_status "Configuring app settings from .env file..."
        
        # Read .env file and set app settings
        while IFS= read -r line; do
            # Skip comments and empty lines
            if [[ "$line" =~ ^[[:space:]]*# ]] || [[ -z "$line" ]]; then
                continue
            fi
            
            # Extract key=value pairs
            if [[ "$line" =~ ^([^=]+)=(.*)$ ]]; then
                key="${BASH_REMATCH[1]}"
                value="${BASH_REMATCH[2]}"
                
                # Remove quotes if present
                value=$(echo "$value" | sed 's/^"//;s/"$//')
                
                print_status "Setting: $key"
                az webapp config appsettings set \
                    --name "$APP_SERVICE_NAME" \
                    --resource-group "$RESOURCE_GROUP" \
                    --settings "$key=$value" > /dev/null
            fi
        done < .env
    else
        print_warning ".env file not found. You may need to configure app settings manually."
    fi
    
    # Set additional required settings
    print_status "Setting additional app settings..."
    az webapp config appsettings set \
        --name "$APP_SERVICE_NAME" \
        --resource-group "$RESOURCE_GROUP" \
        --settings \
        "SCM_DO_BUILD_DURING_DEPLOYMENT=true" \
        "PYTHONUNBUFFERED=1" \
        "PYTHONDONTWRITEBYTECODE=1" > /dev/null
    
    print_success "App Service configuration completed"
}

# Function to deploy application
deploy_application() {
    print_status "Deploying application to Azure App Service..."
    
    # Deploy using az webapp deployment
    az webapp deployment source config-zip \
        --name "$APP_SERVICE_NAME" \
        --resource-group "$RESOURCE_GROUP" \
        --src "${DEPLOY_DIR}.zip"
    
    print_success "Application deployed successfully"
}

# Function to verify deployment
verify_deployment() {
    print_status "Verifying deployment..."
    
    # Wait a moment for the app to start
    sleep 10
    
    # Check health endpoint
    HEALTH_URL="https://$APP_SERVICE_URL/health"
    print_status "Checking health endpoint: $HEALTH_URL"
    
    if curl -f -s "$HEALTH_URL" > /dev/null; then
        print_success "Health check passed! Application is running."
        
        # Test MCP endpoint
        MCP_URL="https://$APP_SERVICE_URL/mcp"
        print_status "MCP endpoint available at: $MCP_URL"
        print_status "You can connect MCP clients to this URL"
    else
        print_warning "Health check failed. Check the App Service logs for details."
        print_status "You can view logs with: az webapp log tail --name $APP_SERVICE_NAME --resource-group $RESOURCE_GROUP"
    fi
}

# Function to cleanup
cleanup() {
    print_status "Cleaning up temporary files..."
    rm -rf "$DEPLOY_DIR"
    rm -f "${DEPLOY_DIR}.zip"
    print_success "Cleanup completed"
}

# Main deployment function
main() {
    echo "=================================="
    echo "  Rude MCP Server Deployment"
    echo "=================================="
    echo ""
    
    # Validate configuration first
    validate_config
    
    # Check prerequisites
    check_prerequisites
    
    # Check Azure login
    check_azure_login
    
    # Verify App Service exists
    verify_app_service
    
    # Prepare deployment
    prepare_deployment
    
    # Configure App Service
    configure_app_service
    
    # Deploy application
    deploy_application
    
    # Verify deployment
    verify_deployment
    
    # Cleanup
    cleanup
    
    echo ""
    echo "=================================="
    print_success "Deployment completed successfully!"
    echo "=================================="
    echo ""
    echo "App Service URL: https://$APP_SERVICE_URL"
    echo "Health Check: https://$APP_SERVICE_URL/health"
    echo "MCP Endpoint: https://$APP_SERVICE_URL/mcp"
    echo ""
    echo "To monitor logs:"
    echo "  az webapp log tail --name $APP_SERVICE_NAME --resource-group $RESOURCE_GROUP"
    echo ""
}

# Show usage if no configuration is provided
if [ -z "$APP_SERVICE_NAME" ] || [ -z "$RESOURCE_GROUP" ]; then
    echo "Usage: Update the configuration section at the top of this script with your values:"
    echo ""
    echo "  APP_SERVICE_NAME=\"your-app-service-name\""
    echo "  RESOURCE_GROUP=\"your-resource-group\""
    echo "  SUBSCRIPTION_ID=\"your-subscription-id\"  # Optional"
    echo ""
    echo "Then run: ./deploy.sh"
    echo ""
    exit 1
fi

# Run main function
main "$@"
