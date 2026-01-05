# AgentChat - Getting Started Guide

Welcome to AgentChat! This guide will help you get the multi-agent system running locally and deployed to Azure.

## 🚀 Quick Start (Local Development)

### Step 1: Prerequisites

Ensure you have the following installed:
- **Node.js** (v18 or higher) - [Download](https://nodejs.org/)
- **Python** (3.13 or higher) - [Download](https://python.org/)
- **Angular CLI** - Install with: `npm install -g @angular/cli`

### Step 2: Start the Backend API

```bash
cd PythonAPI
python main.py
```

You should see output like:
```
2025-07-06 10:30:15,123 - flask_app - INFO - Flask application started
2025-07-06 10:30:15,124 - flask_app - INFO - Azure App Service Flask application created successfully
 * Running on http://127.0.0.1:5007
```

### Step 3: Start the Frontend

In a new terminal:
```bash
# From the project root directory
npx ng --proxy-config proxy.conf.json serve --open
```

Your browser will automatically open to `http://localhost:4200` with the AgentChat interface.

## 🛠️ Development Workflow

### Adding New Agents and Tools

For detailed, step-by-step instructions on extending the system, see our comprehensive guide:

**[📋 Adding Agents and Tools Guide](ADDING_AGENTS_AND_TOOLS.md)**

This guide covers:
- ✅ **Adding New Tools** - Step-by-step process with examples
- ✅ **Adding New Agents** - Complete agent creation workflow  
- ✅ **Code Examples** - Real working examples you can copy
- ✅ **Best Practices** - Proven patterns for maintainable code
- ✅ **Troubleshooting** - Common issues and solutions
- ✅ **Testing** - How to verify your extensions work

### Quick Overview

The system follows this architecture:

1. **Tools** → Add `[category]_tools.py` in `PythonAPI/src/tools/`
2. **Register** → Update `PythonAPI/src/mcp_server.py` 
3. **Wrappers** → Add function wrappers in `PythonAPI/src/agents/mcp_functions.py`
4. **Agents** → Update `PythonAPI/src/agents/multi_agent_system.py`
5. **Test** → Verify everything works together

**Important**: Agents are centralized in `multi_agent_system.py`, not separate files. See the [complete guide](ADDING_AGENTS_AND_TOOLS.md) for accurate instructions!

### Testing Your Changes

```bash
# Test the API
curl http://localhost:5007/api/v1/health

# Test your new agent
curl http://localhost:5007/api/v1/agents

# Test MCP tools
cd PythonAPI
python -c "from src.tools.weather_tools import WeatherTool; print('Tool loaded successfully')"
```

## 📊 Monitoring and Logging

### Local Development Logging

All logs appear in the console with structured information:

```
2025-07-06 10:30:15,123 - flask_requests - INFO - Request started
2025-07-06 10:30:15,124 - api - INFO - Health check requested
2025-07-06 10:30:15,125 - flask_requests - INFO - Request completed
```

### Production Logging (Azure Application Insights)

When deployed to Azure, all logs automatically go to Application Insights:

1. **Request/Response Logs**: Every HTTP request and response
2. **Application Logs**: All your Python logging statements
3. **Error Logs**: Exceptions with full stack traces
4. **Performance Metrics**: Response times and slow request detection

## 🚀 Deployment to Azure

### Step 1: Create Azure Resources

You need these Azure resources before deployment:

#### 1. Cosmos DB
- **Account**: SQL API
- **Database**: `agentchat`
- **Containers**: 
  - `sessions` (partition key: `/userId`)
  - `messages` (partition key: `/userId`)

#### 2. App Service
- **OS**: Linux
- **Runtime**: Python 3.13
- **System Identity**: Enabled

#### 3. Azure Data Explorer (ADX)
- **Cluster**: Any size based on your needs
- **Database**: Create one for your data
- **Permissions**: Grant App Service System Identity "Database Viewer" role

#### 4. Storage Account
- **Type**: Standard

#### 5. Azure AI Search
- **Tier**: Basic or higher
- **Index**: Will be created automatically

#### 6. Application Insights (Recommended)
- **Type**: Application Insights
- **Application Type**: Web

### Step 2: Configure Environment

```powershell
# Run the configuration script
.\configure-env.ps1
```

This will prompt for all your Azure resource details and create `azure-env.env`.

### Step 3: Deploy

```powershell
# Deploy to Azure
.\deploy.ps1
```

The script will:
1. Build the Angular frontend
2. Copy static files to Python API
3. Deploy to Azure App Service
4. Configure environment variables
5. Test the deployment

### Step 4: Verify Deployment

Visit your deployed app:
- **Frontend**: `https://your-app-name.azurewebsites.net`
- **API Health**: `https://your-app-name.azurewebsites.net/api/v1/health`
- **Agent List**: `https://your-app-name.azurewebsites.net/api/v1/agents`

## 🔧 Configuration Files

### Proxy Configuration (`proxy.conf.json`)

Routes Angular development server API calls to Flask:

```json
{
  "/api/*": {
    "target": "http://localhost:5007",
    "secure": false,
    "changeOrigin": true,
    "logLevel": "debug"
  },
  "/mcp/*": {
    "target": "http://localhost:5007",
    "secure": false,
    "changeOrigin": true,
    "logLevel": "debug"
  }
}
```

### Environment Variables

#### Local Development (`.env`)
```env
FLASK_ENV=development
LOG_LEVEL=DEBUG
```

#### Production (`azure-env.env`)
```env
FLASK_ENV=production
LOG_LEVEL=INFO
APPLICATIONINSIGHTS_CONNECTION_STRING=your_connection_string
AZURE_COSMOS_DB_CONNECTION_STRING=your_cosmos_connection
# ... other Azure settings
```

## 🧪 Testing and Debugging

### Health Checks

#### Local
```bash
curl http://localhost:5007/api/v1/health
```

#### Production
```bash
curl https://your-app-name.azurewebsites.net/api/v1/health
```

Expected response:
```json
{
  "status": "healthy",
  "service": "PythonAPI with Simple MCP Server",
  "mcp_tools_count": 9
}
```

### View Application Logs

#### Local
Logs appear in console and can be redirected:
```bash
python main.py > app.log 2>&1
```

#### Azure
```bash
# Stream logs from Azure
az webapp log tail --name your-app-name --resource-group your-resource-group

# Or view in Azure Portal:
# App Service > Monitoring > Log stream
```

#### Application Insights
1. Go to Azure Portal
2. Navigate to your Application Insights resource
3. Go to **Logs** section
4. Query examples:

```kusto
// All application logs from last hour
traces
| where timestamp > ago(1h)
| order by timestamp desc

// HTTP requests
requests
| where timestamp > ago(1h)
| order by timestamp desc

// Errors only
traces
| where severityLevel >= 3
| order by timestamp desc

// Slow requests (>1 second)
requests
| where duration > 1000
| order by duration desc
```

### Common Issues and Solutions

#### Issue: Angular build fails
```bash
# Clear npm cache and reinstall
npm cache clean --force
rm -rf node_modules package-lock.json
npm install
```

#### Issue: Python dependencies fail
```bash
# Update pip and reinstall
python -m pip install --upgrade pip
pip install -r requirements.txt
```

#### Issue: CORS errors in browser
- Check `proxy.conf.json` configuration
- Verify Flask CORS settings in `PythonAPI/src/api/app.py`

#### Issue: Azure deployment fails
- Check Azure CLI login: `az account show`
- Verify resource group exists
- Check App Service name availability

## 📁 Project Structure Reference

```
AgentChat/
├── src/                          # Angular Frontend
│   ├── app/
│   │   ├── components/           # UI Components
│   │   ├── services/             # Angular Services
│   │   └── models/               # TypeScript Interfaces
│   └── environments/             # Environment Configs
├── PythonAPI/                    # Python Backend
│   ├── src/
│   │   ├── agents/               # Agent Implementations
│   │   ├── api/                  # Flask Routes
│   │   ├── tools/                # MCP Tools
│   │   ├── services/             # Business Logic
│   │   ├── utils/                # Utilities & Logging
│   │   └── config/               # Configuration
│   ├── static/                   # Angular Build Output
│   ├── main.py                   # Development Server
│   ├── app.py                    # Production Server
│   └── requirements.txt          # Python Dependencies
├── deployment/                   # Azure Templates
├── configure-env.ps1            # Environment Setup
├── deploy.ps1                   # Deployment Script
├── proxy.conf.json              # Angular Proxy Config
├── README.md                    # Main Documentation
├── DEPLOYMENT.md                # Deployment Guide
└── GETTING_STARTED.md           # This File
```

## 🎯 Next Steps

1. **Explore the API**: Visit `http://localhost:5007/api/v1/tools` to see available MCP tools
2. **Create Your First Agent**: Follow the examples in the [Adding Agents and Tools Guide](ADDING_AGENTS_AND_TOOLS.md)
3. **Add Custom Tools**: Extend the MCP server with your own tools
4. **Deploy to Azure**: Use the provided scripts for production deployment
5. **Monitor Performance**: Set up Application Insights for production monitoring

## 📚 Additional Resources

- **Main Documentation**: [README.md](README.md)
- **Deployment Guide**: [DEPLOYMENT.md](DEPLOYMENT.md)
- **Adding Agents and Tools**: [ADDING_AGENTS_AND_TOOLS.md](ADDING_AGENTS_AND_TOOLS.md)
- **Application Insights Setup**: [APPLICATION_INSIGHTS_README.md](PythonAPI/APPLICATION_INSIGHTS_README.md)
- **Flask Documentation**: [Flask](https://flask.palletsprojects.com/)
- **Angular Documentation**: [Angular](https://angular.io/)
- **MCP Protocol**: [Model Context Protocol](https://modelcontextprotocol.io/)

## 🆘 Getting Help

If you run into issues:

1. **Check the logs** - Both console output and Application Insights
2. **Test components individually** - API health check, frontend build, etc.
3. **Review the documentation** - README.md and DEPLOYMENT.md
4. **Use the debugging endpoints** - Health checks and tool listings
5. **Check Azure resource configuration** - Ensure all permissions are set correctly

Happy coding! 🚀
