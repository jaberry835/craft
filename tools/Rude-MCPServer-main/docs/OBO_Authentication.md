# On-Behalf-Of (OBO) Authentication for ADX Tools

This document explains the On-Behalf-Of authentication implementation for Azure Data Explorer (ADX) tools in the Rude MCP Server.

## Overview

The MCP server now supports **user impersonation** for ADX queries using the On-Behalf-Of (OBO) flow. This allows:

- Users to access ADX data using their own identity and permissions
- Row-level security and user-specific data access in ADX
- Audit trails showing the actual user who performed queries
- Compliance with organizational security policies

## Authentication Modes

The server supports two authentication modes:

### 1. Service Identity (Default/Fallback)
- Uses Azure Managed Identity or DefaultAzureCredential
- All queries run under the service identity
- Used when no user token is provided

### 2. User Impersonation (OBO Flow)
- Uses the calling user's bearer token
- Exchanges user token for ADX access token via OBO flow
- Queries run under the user's identity and permissions

## Configuration

### Required Environment Variables

Set these environment variables in your Azure App Service or `.env` file:

```bash
# ADX Configuration
KUSTO_CLUSTER_URL=https://your-cluster.kusto.windows.net

# Azure AD Application Configuration (for OBO flow)
AZURE_TENANT_ID=your-tenant-id
AZURE_CLIENT_ID=your-app-client-id
AZURE_CLIENT_SECRET=your-app-client-secret

# Optional
KUSTO_DEFAULT_DATABASE=your-default-database
```

### Azure AD Application Setup

1. **Register an Azure AD Application**:
   - Go to Azure Portal > Azure Active Directory > App registrations
   - Create a new registration for your MCP server
   - Note the Application (client) ID and Directory (tenant) ID

2. **Create a Client Secret**:
   - In your app registration, go to Certificates & secrets
   - Create a new client secret and copy the value

3. **Configure API Permissions**:
   - Add the following delegated permissions:
     - `Azure Data Explorer` > `user_impersonation`
     - `Microsoft Graph` > `User.Read` (optional, for user info)

4. **Grant Admin Consent**:
   - Grant admin consent for the permissions (if required by your organization)

### ADX Cluster Permissions

Ensure your Azure AD application has appropriate permissions on the ADX cluster:

```kql
// Add the application as a user in your ADX database
.add database YourDatabase users ('aadapp=your-app-client-id;your-tenant-id') 'MCP Server App'
```

## How It Works

### 1. Token Flow
```
Client App (with user token) 
    ↓ 
MCP Server (extracts token from Authorization header)
    ↓
OBO Flow (exchanges user token for ADX token)
    ↓
ADX Query (using user's identity)
```

### 2. Request Format

Clients should include the user's bearer token in the Authorization header:

```http
POST /your-mcp-endpoint
Authorization: Bearer eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiIs...
Content-Type: application/json
```

### 3. Fallback Behavior

If no user token is provided or OBO flow fails, the server automatically falls back to service identity authentication.

## Testing the Setup

Run the test script to verify your configuration:

```bash
python test_obo_setup.py
```

This will check:
- Environment variable configuration
- Required dependencies
- Context variable imports

## New ADX Tools

### `kusto_get_auth_info`
Get information about the current authentication mode:

```json
{
  "has_user_token": true,
  "authentication_mode": "user_impersonation",
  "cluster_url": "https://your-cluster.kusto.windows.net",
  "token_preview": "eyJ0eXAiOiJKV1QiLCJh...",
  "obo_config": {
    "AZURE_TENANT_ID": true,
    "AZURE_CLIENT_ID": true,
    "AZURE_CLIENT_SECRET": true
  },
  "obo_ready": true
}
```

## Security Considerations

1. **Client Secret Security**: Store the client secret securely in Azure Key Vault or App Service configuration
2. **Token Validation**: The server trusts the calling application to provide valid tokens
3. **Permission Scoping**: Users can only access ADX data they have permissions for
4. **Token Caching**: User tokens are cached briefly to improve performance
5. **Audit Logging**: All ADX operations are logged with user context

## Troubleshooting

### Common Issues

1. **"Missing required environment variables"**
   - Ensure all required environment variables are set
   - Check the test script output for missing variables

2. **"Failed to acquire token via On-Behalf-Of flow"**
   - Verify Azure AD application configuration
   - Check that admin consent has been granted
   - Ensure the user token is valid and not expired

3. **"Kusto service error: Forbidden"**
   - Check ADX cluster permissions for the user
   - Verify the application has been added to the ADX cluster

4. **Fallback to service identity**
   - This is normal behavior when no user token is provided
   - Check logs to see why OBO flow failed

### Debugging

Enable detailed logging by setting the log level to DEBUG:

```python
import logging
logging.getLogger('tools.adx_tools').setLevel(logging.DEBUG)
```

Check the logs for detailed information about authentication flows and token acquisition.

## Migration from Service Identity

Existing installations will continue to work without changes. The OBO flow is only used when:
1. A user token is provided in the Authorization header
2. All required environment variables are configured
3. The token exchange is successful

Otherwise, the server falls back to the existing service identity authentication.
