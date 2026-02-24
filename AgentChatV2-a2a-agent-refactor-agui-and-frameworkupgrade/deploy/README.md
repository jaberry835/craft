# AgentChatV2 Deployment Guide

This guide covers deploying AgentChatV2 to Azure App Service as containers, with support for Azure Government and other sovereign clouds.

## Prerequisites

- Azure CLI installed and configured
- Docker installed locally
- An existing Azure Container Registry (ACR)
- Existing Azure App Services for backend and frontend
- Azure AD application registration for authentication

## Supported Azure Clouds

| Cloud | Name | ACR Suffix |
|-------|------|------------|
| AzureCloud | Azure Commercial | azurecr.io |
| AzureUSGovernment | Azure Government | azurecr.us |
| AzureChinaCloud | Azure China | azurecr.cn |
| AzureGermanCloud | Azure Germany | azurecr.de |

## Quick Start

### Deploy Both Backend and Frontend

```powershell
# PowerShell
.\deploy\deploy-all.ps1 `
    -ResourceGroup "rg-agentchat" `
    -BackendAppService "app-agentchat-api" `
    -FrontendAppService "app-agentchat-web" `
    -ContainerRegistry "myacr" `
    -Cloud "AzureUSGovernment"
```

### Deploy Backend Only

```powershell
# PowerShell
.\deploy\deploy-backend.ps1 `
    -ResourceGroup "rg-agentchat" `
    -AppServiceName "app-agentchat-api" `
    -ContainerRegistry "myacr" `
    -Cloud "AzureUSGovernment"
```

```bash
# Bash
./deploy/deploy-backend.sh \
    -g "rg-agentchat" \
    -a "app-agentchat-api" \
    -r "myacr" \
    -c "AzureUSGovernment"
```

### Deploy Frontend Only

```powershell
.\deploy\deploy-frontend.ps1 `
    -ResourceGroup "rg-agentchat" `
    -AppServiceName "app-agentchat-web" `
    -ContainerRegistry "myacr" `
    -Cloud "AzureUSGovernment"
```

## Configuration

### Configure Application Settings from .env File

The easiest way to configure the backend is to use your local `.env` file:

```powershell
# Copy and configure your .env file first
cp backend\.env.example backend\.env
# Edit backend\.env with your values

# Then apply to Azure (with production-specific overrides)
.\deploy\set-appsettings-from-env.ps1 `
    -ResourceGroup "rg-agentchat" `
    -AppServiceName "app-agentchat-api" `
    -Cloud "AzureUSGovernment" `
    -McpServerEndpoint "https://your-mcp-server.azurewebsites.us/mcp/" `
    -BackendUrl "https://app-agentchat-api.azurewebsites.us"
```

The script will:
- Parse your `.env` file
- Force `ENVIRONMENT=production`
- Override `MCP_SERVER_ENDPOINT` and `BACKEND_URL` with the provided values
- Skip empty values and placeholders
- Mask sensitive values in the preview
- Prompt for confirmation before applying

### Configure Application Settings Manually

Alternatively, configure individual settings:

```powershell
.\deploy\configure-appsettings.ps1 `
    -ResourceGroup "rg-agentchat" `
    -AppServiceName "app-agentchat-api" `
    -Cloud "AzureUSGovernment" `
    -TenantId "your-tenant-id" `
    -ClientId "your-client-id" `
    -CosmosAccountName "cosmos-agentchat" `
    -SearchServiceName "search-agentchat" `
    -OpenAiEndpoint "https://openai-agentchat.openai.azure.us"
```

### Environment Variables

The backend container requires these environment variables:

| Variable | Description | Example |
|----------|-------------|---------|
| ENVIRONMENT | Set to `production` for deployed apps | `production` |
| AZURE_TENANT_ID | Azure AD Tenant ID | `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` |
| AZURE_CLIENT_ID | Azure AD Client ID | `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` |
| AZURE_AUTHORITY_HOST | Azure AD login endpoint | `https://login.microsoftonline.us` |
| AZURE_COSMOS_DB_ENDPOINT | Cosmos DB endpoint | `https://cosmos-xxx.documents.azure.us` |
| AZURE_SEARCH_ENDPOINT | Azure AI Search endpoint | `https://search-xxx.search.windows.us` |
| AZURE_OPENAI_ENDPOINT | Azure OpenAI endpoint | `https://openai-xxx.openai.azure.us` |
| MCP_SERVER_ENDPOINT | MCP server URL | `https://mcp-server.azurewebsites.us/mcp/` |
| BACKEND_URL | **Required for A2A** - This backend's public URL | `https://app-agentchat-api.azurewebsites.us` |

> **Important**: `BACKEND_URL` must be set to the deployed backend's public URL. This is used for agent-to-agent (A2A) communication where the orchestrator calls specialist agents via internal HTTP requests.

## Deployment Scripts Reference

### deploy-backend.ps1 / deploy-backend.sh

Deploys the backend Python API as a container.

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| ResourceGroup | Yes | - | Azure Resource Group |
| AppServiceName | Yes | - | Backend App Service name |
| ContainerRegistry | Yes | - | ACR name (without suffix) |
| Cloud | No | AzureUSGovernment | Target Azure cloud |
| ImageTag | No | latest | Docker image tag |
| SkipBuild | No | false | Skip Docker build step |

### deploy-frontend.ps1

Deploys the Angular frontend as a container.

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| ResourceGroup | Yes | - | Azure Resource Group |
| AppServiceName | Yes | - | Frontend App Service name |
| ContainerRegistry | Yes | - | ACR name (without suffix) |
| BackendUrl | No | - | Backend API URL (for A2A endpoints) |
| Cloud | No | AzureUSGovernment | Target Azure cloud |
| ImageTag | No | latest | Docker image tag |
| SkipBuild | No | false | Skip Docker build step |

### deploy-all.ps1

Orchestrates deployment of both components. Automatically detects the backend URL when deploying both.

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| ResourceGroup | Yes | - | Azure Resource Group |
| BackendAppService | Conditional | - | Backend App Service name |
| FrontendAppService | Conditional | - | Frontend App Service name |
| ContainerRegistry | Yes | - | ACR name (without suffix) |
| Cloud | No | AzureUSGovernment | Target Azure cloud |
| ImageTag | No | latest | Docker image tag |
| BackendOnly | No | false | Deploy only backend |
| FrontendOnly | No | false | Deploy only frontend |

## Manual Docker Commands

If you prefer to build and push manually:

```bash
# Backend
cd backend
docker build -t myacr.azurecr.us/agentchatv2-backend:latest .
docker push myacr.azurecr.us/agentchatv2-backend:latest

# Frontend
cd frontend
docker build -t myacr.azurecr.us/agentchatv2-frontend:latest .
docker push myacr.azurecr.us/agentchatv2-frontend:latest
```

## Azure Government Considerations

When deploying to Azure Government:

1. **Authentication Endpoints**: Use `https://login.microsoftonline.us` for Azure AD
2. **Service Endpoints**: All Azure services use `.us` suffixes:
   - Container Registry: `azurecr.us`
   - Cosmos DB: `documents.azure.us`
   - AI Search: `search.windows.us`
   - OpenAI: `openai.azure.us`
3. **Region Selection**: Available regions include `usgovvirginia`, `usgovarizona`, `usgovtexas`

## Troubleshooting

### Container Fails to Start

1. Check App Service logs: `az webapp log tail -g <rg> -n <app>`
2. Verify container port matches `WEBSITES_PORT` setting (backend: 5000, frontend: 80)
3. Check ACR credentials are valid
4. Verify the image was pushed successfully: `az acr repository show-tags -n <acr> --repository agentchatv2-backend`

### Authentication Issues

1. Verify `AZURE_AUTHORITY_HOST` matches your cloud:
   - Commercial: `https://login.microsoftonline.com`
   - Government: `https://login.microsoftonline.us`
2. Ensure Azure AD app is registered in the correct tenant
3. Check redirect URIs in app registration include your App Service URLs
4. For admin access, verify the `admin` role is created and assigned (see main README)

### Service Connection Issues

1. Verify all endpoint URLs use correct cloud suffixes
2. Check managed identity is enabled on the App Service
3. Verify RBAC roles are assigned to the managed identity (see main README)
4. Ensure network connectivity (VNet, firewall rules)

### A2A Communication Fails in Production

1. **Most common issue**: `BACKEND_URL` not set or incorrect
   - Must be the full public URL: `https://app-agentchat-api.azurewebsites.us`
   - The orchestrator uses this URL to call specialist agents
2. Check App Service can reach itself (no firewall blocking loopback)
3. Enable `SHOW_A2A_LOGS=true` to debug

### Cosmos DB "Unauthorized" in Production

1. Managed identity needs **data plane** RBAC (not control plane IAM):
   ```powershell
   az cosmosdb sql role assignment create `
     --account-name <cosmos-account> `
     --resource-group <rg> `
     --principal-id <managed-identity-principal-id> `
     --role-definition-id "00000000-0000-0000-0000-000000000002" `
     --scope "/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.DocumentDB/databaseAccounts/<cosmos>"
   ```
2. Wait 5-10 minutes for role propagation
3. Restart the App Service after role assignment
