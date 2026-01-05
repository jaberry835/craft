# MCP OAuth 2.1 Setup Guide

This guide explains how to configure Azure AD for MCP OAuth 2.1 authentication, allowing third-party MCP clients like Claude Desktop and GitHub Copilot to authenticate users and access your ADX data with proper user permissions.

## Overview

With MCP OAuth 2.1, the authentication flow works as follows:

1. **Client requests access** → Your MCP server returns 401 with OAuth challenge
2. **Client performs OAuth** → User signs in via browser, gets token for YOUR MCP API
3. **Client sends token** → Your server validates the MCP API token
4. **Server performs OBO** → Exchanges MCP API token for ADX token
5. **ADX query executes** → With user's actual ADX permissions

## Azure AD App Registration Setup

### 1. Create or Update Your App Registration

In the Azure Portal, go to **Azure Active Directory** → **App registrations**:

1. **Create new registration** (or update existing):
   - Name: `Your-MCP-Server`
   - Supported account types: Choose based on your needs
   - Redirect URI: Not needed for MCP OAuth

### 2. Expose an API

This is the **critical step** that enables MCP OAuth:

1. Go to **Expose an API**
2. Set **Application ID URI**: 
   - Default: `api://your-client-id`
   - Custom: `https://your-domain.com/mcp-api`
3. **Add a scope**:
   - Scope name: `mcp.access`
   - Display name: `Access MCP Server`
   - Description: `Allows access to MCP server tools`
   - State: Enabled

### 3. Configure API Permissions

Your app needs permissions to call ADX on behalf of users:

1. Go to **API permissions**
2. **Add a permission** → **APIs my organization uses**
3. Search for **Azure Data Explorer** or `https://kusto.kusto.windows.net`
4. Select **Delegated permissions**
5. Check **user_impersonation**
6. **Grant admin consent** (if required by your organization)

### 4. Create Client Secret

1. Go to **Certificates & secrets**
2. **New client secret**
3. Copy the secret value (you won't see it again)

### 5. Note Key Values

You'll need these for your environment variables:
- **Tenant ID**: From Overview page
- **Client ID**: From Overview page  
- **Client Secret**: From step 4
- **Application ID URI**: From step 2 (e.g., `api://your-client-id`)

## Environment Configuration

Update your `.env` file or Azure App Service configuration:

```bash
# MCP OAuth 2.1 Configuration
MCP_OAUTH_ENABLED=true
MCP_API_AUDIENCE=api://your-client-id-here  # From step 2 above

# Azure AD Configuration
AZURE_TENANT_ID=your-tenant-id-here
AZURE_CLIENT_ID=your-client-id-here
AZURE_CLIENT_SECRET=your-client-secret-here

# Authority (adjust for your cloud)
AZURE_AUTHORITY_HOST=https://login.microsoftonline.com      # Commercial
# AZURE_AUTHORITY_HOST=https://login.microsoftonline.us     # Government
```

## Testing the Setup

### 1. Test with MCP Inspector

```bash
npx @anthropic-ai/mcp-inspector http://your-server-url/mcp/
```

- Should show 401 with OAuth challenge
- Should display authorization URI and client ID

### 2. Test with Claude Desktop

Add to Claude Desktop's MCP configuration:

```json
{
  "mcpServers": {
    "your-mcp-server": {
      "command": "npx",
      "args": ["-y", "@anthropic-ai/mcp-client-http", "http://your-server-url/mcp/"]
    }
  }
}
```

Claude should prompt for OAuth authentication on first use.

### 3. Verify Token Flow

Check your server logs for:
- ✅ `🔐 MCP OAuth: Token validation successful`
- ✅ `🔄 Token is not for ADX, proceeding with OBO flow`
- ✅ `✅ OBO token obtained successfully`

## Troubleshooting

### Common Issues

1. **Token audience mismatch**:
   - Verify `MCP_API_AUDIENCE` matches your Application ID URI exactly
   - Check logs for expected vs actual audience

2. **OBO flow fails**:
   - Ensure client secret is correct and not expired
   - Verify ADX permissions are granted and consented
   - Check authority host matches your cloud (commercial vs government)

3. **Client can't authenticate**:
   - Verify Application ID URI is set in Azure AD
   - Check that the scope is enabled
   - Ensure redirect URIs are configured if needed

### Debug Logging

Your server logs detailed information about:
- Token validation and audience checking
- OBO flow execution
- ADX permission inheritance

Look for logs starting with `🔐`, `🔄`, and `✅` to trace the authentication flow.

## Architecture Benefits

This setup provides:

- ✅ **Standards compliance**: Uses OAuth 2.1 and MCP specifications
- ✅ **User permissions**: ADX queries run with actual user's permissions
- ✅ **Client compatibility**: Works with any OAuth-capable MCP client
- ✅ **Audit trail**: All queries are logged under the real user identity
- ✅ **Security**: Proper token audience validation and scoping
