# 🚀 Azure Deployment Instructions

## Quick Start

1. **Copy and configure**: Copy `config.json` to `my-config.json` and update with your Azure resource details
2. **Deploy**: Run `.\deploy.ps1 -ConfigFile my-config.json`
3. **Verify**: Run `.\verify.ps1 -AppServiceName your-app-name`

## ✅ To Answer Your Questions:

### 1. **System Prompt in Environment Variables**
- ✅ **System prompt is now configurable** via Azure App Service Application Settings
- ✅ **No hardcoding** - stored in `SystemPrompt` environment variable
- ✅ **Easy updates** - use `.\update-config.ps1 -UpdateSystemPrompt` to update without redeployment

### 2. **Angular Environment Variables in Azure**
- ✅ **Build-time replacement** - Angular environment.prod.ts is generated during deployment
- ✅ **Secure configuration** - sensitive values stay in Azure App Service settings
- ✅ **No API keys in frontend** - Angular talks to the backend API which handles all Azure service calls

### 3. **Single App Service Deployment**
- ✅ **Same App Service** - Both .NET API and Angular app deploy to one App Service
- ✅ **Cost effective** - Single resource, easier management
- ✅ **Static file serving** - .NET serves Angular build from wwwroot
- ✅ **API routing** - /api/* routes go to .NET controllers, everything else serves Angular

## 📁 Architecture

```
Azure App Service (Single Instance)
├── .NET Core API (/api/*)
│   ├── Chat Controller
│   ├── Document Controller  
│   ├── MCP Controller
│   └── Configuration Controller (NEW!)
└── Angular Static Files (/* - everything else)
    ├── index.html
    ├── assets/
    └── js/css bundles
```

## 🔧 Configuration Management

### Backend (.NET)
- Uses standard .NET configuration
- Reads from Azure App Service Application Settings
- Environment variables override appsettings.json values

### Frontend (Angular)
- `environment.prod.template.ts` → `environment.prod.ts` (build-time replacement)
- Values injected from Azure App Service settings during deployment
- No sensitive values in browser code

## 📋 Deployment Scripts

### `deploy.ps1` - Full Deployment
```powershell
# Deploy everything (infrastructure + code)
.\deploy.ps1 -ConfigFile my-config.json

# Build only (skip deployment)
.\deploy.ps1 -ConfigFile my-config.json -SkipDeploy

# Deploy only (skip build)
.\deploy.ps1 -ConfigFile my-config.json -SkipBuild
```

### `update-config.ps1` - Configuration Updates
```powershell
# Update all app settings
.\update-config.ps1 -ConfigFile my-config.json

# Update just system prompt (fast!)
.\update-config.ps1 -ConfigFile my-config.json -UpdateSystemPrompt
```

### `verify.ps1` - Test Deployment
```powershell
# Test all endpoints and health checks
.\verify.ps1 -AppServiceName your-app-name
```

## 🌍 Environment Variable Benefits

### ✅ System Prompt Updates
- Change system prompt in `config.json`
- Run `.\update-config.ps1 -UpdateSystemPrompt`
- No redeployment needed!

### ✅ Easy Configuration Management
- All Azure service endpoints/keys in one place
- Version control friendly (secrets in Azure, not code)
- Environment-specific configurations

### ✅ Scalable Tool Integration
- Add new tools to backend → LLM automatically discovers them
- No frontend changes needed for new tool capabilities
- System prompt guides LLM behavior generically

## 🛠️ Development vs Production

### Development
```typescript
// src/environments/environment.ts
api: {
  baseUrl: 'http://localhost:5007/api'  // Local MCP server
}
```

### Production  
```typescript
// Generated from environment.prod.template.ts
api: {
  baseUrl: 'https://your-app.azurewebsites.us/api'  // Same App Service
}
```

## 🔒 Security Notes

- ✅ No API keys in Angular code
- ✅ All Azure service calls through backend
- ✅ CORS properly configured
- ✅ HTTPS enforced in production
- ✅ Azure AD authentication maintained

## 🎯 Next Steps After Deployment

1. **Test the application** at https://your-app-name.azurewebsites.us
2. **Upload documents** to test RAG functionality  
3. **Try tool chaining** with queries like "show me data from employees table"
4. **Update system prompt** as needed using update-config.ps1

## 💡 Pro Tips

- **System Prompt Updates**: Modify `config.json` and run update script - no redeployment!
- **New Tools**: Add tools to backend, they're automatically available to LLM
- **Monitoring**: Use Azure Application Insights for detailed logging
- **Scaling**: Upgrade App Service Plan SKU for better performance
