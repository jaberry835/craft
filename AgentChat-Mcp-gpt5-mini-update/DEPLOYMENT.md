# AgentChat Deployment Guide

This guide explains how to deploy the AgentChat multi-agent system to Azure using the provided configuration and deployment scripts.

## 🏗️ Azure Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Azure CDN     │    │  App Service    │    │   Cosmos DB     │
│                 │    │                 │    │                 │
│ • Static Files  │    │ • Python API    │    │ • Sessions      │
│ • Angular App   │◄──►│ • System ID     │◄──►│ • Messages      │
│                 │    │ • Auto Scale    │    │ • Vector Store  │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                        │                        │
         │                        ▼                        │
         │              ┌─────────────────┐                │
         │              │  Azure Services │                │
         │              │                 │                │
         └──────────────│ • Blob Storage  │◄───────────────┘
                        │ • AI Search     │
                        │ • Data Explorer │
                        │ • App Insights  │
                        └─────────────────┘
```

## 📋 Prerequisites

### Azure Resources Required

You must create the following Azure resources before deployment:

#### 1. **Cosmos DB Account**
- Create a Cosmos DB account with SQL API
- Create database: `agentchat`
- Create containers:
  - `sessions` (partition key: `/user_id`)
  - `messages` (partition key: `/session_id`)
- Note the endpoint and connection string

#### 2. **Linux App Service**
- Create a Linux App Service (Python 3.9+ runtime)
- **Enable System-Assigned Managed Identity**
- Note the App Service name and resource group

#### 3. **Azure Data Explorer (ADX)**
- Create an ADX cluster
- Create a database
- **Grant the App Service System Identity "Database Viewer" permissions**
- Note the cluster URL

#### 4. **Storage Account**
- Create a storage account (Standard performance is sufficient)
- Create a container: `agentchat-files`
- Note the connection string

#### 5. **Azure AI Search**
- Create an Azure AI Search service
- Note the endpoint and admin key

#### 6. **Application Insights** (Optional but Recommended)
- Create an Application Insights resource
- Note the connection string

## 🚀 Deployment Process

### Step 1: Configure Environment Variables

Use the provided script to set up your environment:

```powershell
# Navigate to the project directory
cd AgentChat

# Run the configuration script
.\configure-env.ps1
```

The script will prompt you for:
- Azure subscription ID
- Resource group name
- App Service name
- Cosmos DB connection string
- Storage account connection string
- Azure AI Search endpoint and key
- ADX cluster URL
- Application Insights connection string

**Example configuration session:**
```powershell
PS> .\configure-env.ps1

Azure AgentChat Deployment Configuration
=====================================

Enter your Azure Subscription ID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
Enter Resource Group name: rg-agentchat
Enter App Service name: app-agentchat
Enter Cosmos DB connection string: AccountEndpoint=https://...
Enter Storage Account connection string: DefaultEndpointsProtocol=https;...
Enter Azure AI Search endpoint: https://your-search.search.windows.net
Enter Azure AI Search admin key: [hidden]
Enter ADX cluster URL: https://your-cluster.eastus.kusto.windows.net
Enter Application Insights connection string: InstrumentationKey=...

Configuration saved to azure-env.env
```

### Step 2: Review Generated Configuration

The script creates `azure-env.env` with your settings:

```env
# Azure Configuration
AZURE_SUBSCRIPTION_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
AZURE_RESOURCE_GROUP=rg-agentchat
AZURE_APP_SERVICE_NAME=app-agentchat

# Database
AZURE_COSMOS_DB_CONNECTION_STRING=AccountEndpoint=https://...
AZURE_COSMOS_DB_DATABASE=agentchat
AZURE_COSMOS_DB_SESSIONS_CONTAINER=sessions
AZURE_COSMOS_DB_MESSAGES_CONTAINER=messages

# Storage
AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;...
AZURE_STORAGE_CONTAINER_NAME=agentchat-files

# AI Search
AZURE_SEARCH_ENDPOINT=https://your-search.search.windows.net
AZURE_SEARCH_KEY=your-search-key
AZURE_SEARCH_INDEX_NAME=agentchat-index

# Data Explorer
ADX_CLUSTER_URL=https://your-cluster.eastus.kusto.windows.net

# Monitoring
APPLICATIONINSIGHTS_CONNECTION_STRING=InstrumentationKey=...

# App Configuration
FLASK_ENV=production
LOG_LEVEL=INFO
```

### Step 3: Deploy to Azure

#### Option A: PowerShell Deployment (Recommended)

```powershell
# Deploy using the PowerShell script
.\deploy.ps1
```

#### Option B: Batch Script Deployment

```cmd
# Deploy using the batch script
deploy.bat
```

#### Option C: Manual Deployment

```bash
# Build Angular app
npx ng build --configuration production

# Copy Angular build to Python static folder
cp -r dist/agent-chat/* PythonAPI/static/

# Navigate to Python API
cd PythonAPI

# Deploy to Azure App Service
az webapp up --sku B1 --name your-app-service-name --resource-group your-resource-group
```

## 🔧 Post-Deployment Configuration

### 1. Verify System Identity Permissions

Ensure your App Service System Identity has the correct permissions:

#### Cosmos DB Permissions
```bash
# Grant Cosmos DB access to App Service Identity
az cosmosdb sql role assignment create \
  --account-name your-cosmos-account \
  --resource-group your-resource-group \
  --scope "/" \
  --principal-id your-app-service-principal-id \
  --role-definition-id "00000000-0000-0000-0000-000000000002"  # Cosmos DB Built-in Data Contributor
```

#### ADX Permissions
```bash
# Grant ADX database viewer access
az kusto database-principal-assignment create \
  --cluster-name your-adx-cluster \
  --database-name your-database \
  --resource-group your-resource-group \
  --principal-id your-app-service-principal-id \
  --principal-type App \
  --role Viewer
```

#### Storage Account Permissions
```bash
# Grant Storage Blob Data Contributor access
az role assignment create \
  --assignee your-app-service-principal-id \
  --role "Storage Blob Data Contributor" \
  --scope "/subscriptions/your-subscription/resourceGroups/your-rg/providers/Microsoft.Storage/storageAccounts/your-storage"
```

### 2. Configure Application Settings

Set environment variables in your App Service:

```bash
# Set all environment variables from azure-env.env
az webapp config appsettings set \
  --name your-app-service-name \
  --resource-group your-resource-group \
  --settings @azure-env.env
```

### 3. Enable Application Insights

```bash
# Enable Application Insights for the App Service
az monitor app-insights component connect-webapp \
  --app your-app-insights-name \
  --resource-group your-resource-group \
  --web-app your-app-service-name
```

## 🧪 Testing Deployment

### 1. Health Check

```bash
# Test the deployed application
curl https://your-app-service-name.azurewebsites.net/api/v1/health
```

Expected response:
```json
{
  "status": "healthy",
  "service": "PythonAPI with Simple MCP Server",
  "mcp_tools_count": 9
}
```

### 2. Test API Endpoints

```bash
# List available tools
curl https://your-app-service-name.azurewebsites.net/api/v1/tools

# List available agents
curl https://your-app-service-name.azurewebsites.net/api/v1/agents

# Test MCP status
curl https://your-app-service-name.azurewebsites.net/api/v1/mcp/status
```

### 3. Test Frontend

Visit `https://your-app-service-name.azurewebsites.net` in your browser to access the Angular frontend.

### 4. Monitor Logs

```bash
# View application logs
az webapp log tail --name your-app-service-name --resource-group your-resource-group

# View Application Insights logs
# Go to Azure Portal > Application Insights > Logs
# Query: traces | where timestamp > ago(1h) | order by timestamp desc
```

## 🔍 Monitoring and Troubleshooting

### Application Insights Queries

#### All Application Logs
```kusto
traces
| where timestamp > ago(1h)
| order by timestamp desc
```

#### HTTP Requests
```kusto
requests
| where timestamp > ago(1h)
| order by timestamp desc
```

#### Errors
```kusto
traces
| where severityLevel >= 3
| where timestamp > ago(1h)
| order by timestamp desc
```

#### Performance
```kusto
requests
| where duration > 1000
| where timestamp > ago(1h)
| project timestamp, name, duration, resultCode
| order by duration desc
```

### Common Issues and Solutions

#### 1. **Deployment Fails**
- Check Azure CLI is logged in: `az account show`
- Verify resource group exists: `az group show --name your-resource-group`
- Check App Service name availability: `az webapp check-name --name your-app-service-name`

#### 2. **Health Check Fails**
- Check App Service logs: `az webapp log tail`
- Verify Python dependencies are installed
- Check environment variables are set correctly

#### 3. **Database Connection Issues**
- Verify Cosmos DB connection string is correct
- Check System Identity has proper permissions
- Test connection from local environment first

#### 4. **Static Files Not Loading**
- Ensure Angular build completed successfully
- Check files are in `PythonAPI/static/` directory
- Verify Flask static file serving is configured

#### 5. **MCP Tools Not Working**
- Check MCP server initialization logs
- Verify tool registration in `mcp_server.py`
- Test tools locally before deployment

## 🔄 Continuous Deployment

### GitHub Actions (Optional)

Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy to Azure

on:
  push:
    branches: [ main ]

jobs:
  deploy:
    runs-on: ubuntu-latest
    
    steps:
    - uses: actions/checkout@v2
    
    - name: Setup Node.js
      uses: actions/setup-node@v2
      with:
        node-version: '18'
    
    - name: Setup Python
      uses: actions/setup-python@v2
      with:
        python-version: '3.9'
    
    - name: Build Angular
      run: |
        npm install
        npx ng build --configuration production
        cp -r dist/agent-chat/* PythonAPI/static/
    
    - name: Deploy to Azure
      uses: azure/webapps-deploy@v2
      with:
        app-name: ${{ secrets.AZURE_APP_SERVICE_NAME }}
        slot-name: production
        package: ./PythonAPI
```

## 📊 Scaling and Performance

### App Service Scaling
```bash
# Scale up to higher tier
az appservice plan update --name your-app-service-plan --resource-group your-resource-group --sku P1V2

# Enable auto-scaling
az monitor autoscale create \
  --resource-group your-resource-group \
  --resource your-app-service-name \
  --resource-type Microsoft.Web/sites \
  --name agentchat-autoscale \
  --min-count 1 \
  --max-count 10 \
  --count 2
```

### Cosmos DB Scaling
- Configure appropriate RU/s for your containers
- Enable autoscale for variable workloads
- Consider partitioning strategy for large datasets

### Monitoring Performance
- Use Application Insights performance counters
- Monitor Cosmos DB metrics
- Set up alerts for high response times or error rates

## 🛡️ Security Best Practices

1. **Use System-Assigned Managed Identity** (already configured)
2. **Store secrets in Azure Key Vault** (optional enhancement)
3. **Enable HTTPS only** for App Service
4. **Configure CORS** appropriately
5. **Implement authentication** for production use
6. **Regular security updates** for dependencies

## 📄 Additional Resources

- [Azure App Service Documentation](https://docs.microsoft.com/en-us/azure/app-service/)
- [Cosmos DB Python SDK](https://docs.microsoft.com/en-us/azure/cosmos-db/sql/sdk-python)
- [Azure Application Insights](https://docs.microsoft.com/en-us/azure/azure-monitor/app/app-insights-overview)
- [Flask Deployment Guide](https://flask.palletsprojects.com/en/2.0.x/deploying/)

## 🆘 Support

If you encounter issues during deployment:

1. Check the deployment logs in Azure Portal
2. Review Application Insights for runtime errors
3. Test components individually (health check, database, etc.)
4. Verify all Azure resource permissions are configured correctly
5. Use the Azure CLI diagnostic commands provided above