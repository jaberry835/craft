# Python MCP Server + Angular Deployment Guide

This guide explains how to deploy the Python MCP Server with the Angular UI to Azure App Service.

## Architecture

- **Backend**: Python Flask application (`chat_api_server.py`) with MCP agents
- **Frontend**: Angular application built and served as static files
- **Deployment**: Azure App Service with Python 3.12 runtime
- **Static Files**: Angular dist files served from `/static` folder

## Prerequisites

1. **Azure CLI** installed and authenticated
2. **Node.js and npm** for Angular build
3. **Angular CLI** installed globally (`npm install -g @angular/cli`)
4. **Azure resources** already created (see main deployment guide)

## Configuration

1. **Copy the template configuration:**
   ```powershell
   Copy-Item config-python.json my-config-python.json
   ```

2. **Update `my-config-python.json`** with your Azure resource values:
   - Subscription ID, Resource Group, App Service name
   - Azure OpenAI endpoint and API key
   - Azure AI Search endpoint and API key
   - Cosmos DB connection details
   - Azure Storage connection string
   - Other Azure service endpoints

## Deployment Steps

### Option 1: Full Deployment (Recommended)
```powershell
.\deploy-python.ps1
```

### Option 2: Skip Angular Build (if already built)
```powershell
.\deploy-python.ps1 -SkipBuild
```

### Option 3: Build Only (no deployment)
```powershell
.\deploy-python.ps1 -SkipDeploy
```

## What the Deployment Does

1. **Builds Angular Application**
   - Runs `ng build --configuration production`
   - Creates optimized production build in `../dist`

2. **Packages Python Application**
   - Copies Python MCP Server files
   - Copies Angular build to `static/` folder
   - Includes `web.config` for IIS URL rewriting

3. **Configures Azure App Service**
   - Sets Python 3.12 runtime
   - Configures startup command: `gunicorn --bind=0.0.0.0 --timeout 600 chat_api_server:app`
   - Sets all application settings from config

4. **Deploys via ZIP**
   - Creates deployment package
   - Uploads to Azure App Service
   - Automatically restarts the service

## Verification

After deployment, run the verification script:
```powershell
.\verify-python.ps1
```

This tests:
- Health endpoint (`/health`)
- Configuration endpoint (`/api/config`)
- Chat sessions endpoint (`/api/chat/sessions`)
- MCP server info endpoint (`/api/mcp/server-info`)
- Angular application (`/`)

## Key Differences from C# Deployment

1. **Entry Point**: Uses `chat_api_server.py` instead of `app.py`
2. **Runtime**: Python 3.12 instead of .NET
3. **Static Files**: Served from Flask `/static` folder
4. **URL Routing**: Flask handles API routes, Angular handles client routes
5. **CORS**: Configured in Python code using `config.json`

## Configuration Management

- **Local Development**: Uses `config.json` in Python-MCP-Server folder
- **Production**: Uses Azure App Service application settings
- **CORS**: Configured via `CORS_ORIGINS` in config for dynamic domains

## Troubleshooting

### Common Issues

1. **"Angular app not found"**
   - Ensure Angular build completed successfully
   - Check that `../dist` folder exists
   - Verify files were copied to `static/` folder

2. **"Azure AI Search not configured"**
   - Check that config uses `Key` not `ApiKey` for Azure Search
   - Verify search endpoint and credentials

3. **CORS errors**
   - Verify `CORS_ORIGINS` includes your domain
   - Check that application settings were deployed

4. **Python startup failures**
   - Check Azure App Service logs in portal
   - Verify Python requirements are installed
   - Check gunicorn startup command

### Debugging

1. **Check Azure App Service Logs:**
   ```powershell
   az webapp log tail --name YOUR_APP_SERVICE_NAME --resource-group YOUR_RESOURCE_GROUP
   ```

2. **View Application Settings:**
   ```powershell
   az webapp config appsettings list --name YOUR_APP_SERVICE_NAME --resource-group YOUR_RESOURCE_GROUP
   ```

3. **Test Locally:**
   ```powershell
   cd Python-MCP-Server
   python chat_api_server.py
   ```

## File Structure After Deployment

```
/home/site/wwwroot/
├── chat_api_server.py          # Main Flask application
├── config.json                 # Configuration file
├── requirements.txt            # Python dependencies
├── web.config                  # IIS URL rewriting rules
├── src/                        # Python source code
│   ├── agents/                 # MCP agents
│   ├── services/               # Azure services
│   └── models/                 # Data models
└── static/                     # Angular application
    ├── index.html              # Main Angular entry point
    ├── main.*.js               # Angular bundles
    ├── styles.*.css            # Compiled styles
    └── assets/                 # Static assets
```

## Security Notes

- API keys and secrets are stored in Azure App Service application settings
- No sensitive data is included in the deployment package
- CORS is configured for specific origins only
- All HTTP traffic is redirected to HTTPS by Azure

## Performance Considerations

- Gunicorn timeout set to 600 seconds for long-running operations
- Static files served directly by IIS (faster than Python)
- Angular application uses production optimizations
- Python application uses optimized Docker base image
