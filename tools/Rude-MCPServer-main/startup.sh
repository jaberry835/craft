#!/bin/bash

# Azure App Service startup script for the MCP Server
# This script ensures proper initialization of the Python MCP server

echo "Starting Rude MCP Server on Azure App Service..."

# Set default port if not specified (Azure App Service uses PORT env var)
export PORT=${PORT:-8000}

echo "Server will run on port: $PORT"

# Ensure we're using the virtual environment if it exists
if [ -d "/home/site/wwwroot/antenv" ]; then
    source /home/site/wwwroot/antenv/bin/activate
    echo "Activated virtual environment"
fi

# Install dependencies if requirements.txt exists and packages aren't installed
if [ -f "requirements.txt" ]; then
    echo "Installing Python dependencies..."
    pip install -r requirements.txt
fi

# Verify critical environment variables
if [ -z "$KUSTO_CLUSTER_URL" ]; then
    echo "WARNING: KUSTO_CLUSTER_URL not set. Azure Data Explorer tools will not work."
else
    echo "Azure Data Explorer cluster configured: $KUSTO_CLUSTER_URL"
fi

# Start the FastMCP server
echo "Starting FastMCP server..."
python main.py
