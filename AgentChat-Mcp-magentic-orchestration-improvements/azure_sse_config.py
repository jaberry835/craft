"""
Azure App Service Configuration for SSE Support

This file contains configuration settings and modifications needed to support
Server-Sent Events (SSE) on Azure App Service.
"""

# Azure App Service Settings for SSE
AZURE_APP_SERVICE_SETTINGS = {
    # Enable WebSocket support (helps with persistent connections)
    "WEBSITE_WEBSERVER_ENABLED": "true",
    
    # Disable ARR (Application Request Routing) affinity to prevent sticky sessions
    "WEBSITE_ARR_AFFINITY": "false",
    
    # Set idle timeout to prevent premature connection closure
    "WEBSITE_IDLE_TIMEOUT": "300",
    
    # Enable always on to prevent app from going to sleep
    "WEBSITE_ALWAYS_ON": "true",
    
    # Disable compression for SSE streams
    "WEBSITE_COMPRESSION_ENABLED": "false",
    
    # Set Python version
    "PYTHON_VERSION": "3.13",
    
    # Configure gunicorn for SSE
    "GUNICORN_CMD_ARGS": "--worker-class gevent --worker-connections 1000 --timeout 300 --keep-alive 30 --max-requests 1000 --max-requests-jitter 50",
    
    # Force HTTPS
    "WEBSITE_HTTPSONLY": "true",
    
    # Set SCM type to None to prevent conflicts
    "SCM_DO_BUILD_DURING_DEPLOYMENT": "false"
}

# Web.config for Azure App Service
WEB_CONFIG_CONTENT = """<?xml version="1.0" encoding="utf-8"?>
<configuration>
    <system.webServer>
        <httpProtocol>
            <customHeaders>
                <add name="Cache-Control" value="no-cache" />
                <add name="Connection" value="keep-alive" />
                <add name="Access-Control-Allow-Origin" value="*" />
                <add name="Access-Control-Allow-Headers" value="Cache-Control" />
                <add name="Access-Control-Allow-Methods" value="GET, POST, OPTIONS" />
            </customHeaders>
        </httpProtocol>
        <handlers>
            <add name="PythonHandler" path="*" verb="*" modules="FastCgiModule" scriptProcessor="D:\Python\Python.exe" resourceType="Unspecified" requireAccess="Script" />
        </handlers>
        <rewrite>
            <rules>
                <rule name="Force HTTPS" stopProcessing="true">
                    <match url="(.*)" />
                    <conditions>
                        <add input="{HTTPS}" pattern="off" ignoreCase="true" />
                    </conditions>
                    <action type="Redirect" url="https://{HTTP_HOST}/{R:1}" redirectType="Permanent" />
                </rule>
            </rules>
        </rewrite>
    </system.webServer>
</configuration>"""

# Startup script for Azure App Service
STARTUP_SCRIPT = """#!/bin/bash
# Azure App Service startup script

# Install dependencies
pip install -r requirements.txt

# Start the application with proper SSE configuration
exec gunicorn -w 1 --worker-class gevent --worker-connections 1000 --timeout 300 --keep-alive 30 --bind 0.0.0.0:8000 wsgi:app
"""

print("Azure App Service SSE Configuration Guide")
print("=" * 50)
print()
print("1. App Service Settings to configure:")
for key, value in AZURE_APP_SERVICE_SETTINGS.items():
    print(f"   {key} = {value}")
print()
print("2. Create web.config file in the root directory")
print("3. Update Procfile with gevent worker")
print("4. Ensure HTTPS is properly configured")
print()
print("For deployment, use the Azure CLI:")
print("az webapp config appsettings set --name <app-name> --resource-group <rg-name> --settings KEY=VALUE")
