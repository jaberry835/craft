#!/bin/bash

# Azure App Service startup script for Python Flask app
echo "🚀 Starting Python Flask MCP Server..."

# Ensure we're in the right directory
cd /home/site/wwwroot

# Check if files are in the right place
if [ ! -f "chat_api_server.py" ]; then
    echo "⚠️  chat_api_server.py not found in /home/site/wwwroot"
    echo "📦 Checking for deployment package..."
    
    if [ -f "output.tar.gz" ]; then
        echo "📋 Extracting deployment package..."
        tar -xzf output.tar.gz
    elif ls /tmp/*/chat_api_server.py 2>/dev/null; then
        echo "📋 Copying from build directory..."
        TEMP_DIR=$(dirname $(ls /tmp/*/chat_api_server.py | head -1))
        cp -r $TEMP_DIR/* .
    fi
    
    # Check again
    if [ ! -f "chat_api_server.py" ]; then
        echo "❌ chat_api_server.py still not found! Deployment may have failed."
        ls -la
        exit 1
    fi
fi

echo "✅ Files found in /home/site/wwwroot"
echo "📋 Current directory contents:"
ls -la

# Set Python path
export PYTHONPATH="/home/site/wwwroot:$PYTHONPATH"

# Kill any existing gunicorn processes to ensure clean startup
echo "🧹 Cleaning up any existing gunicorn processes..."
pkill -f gunicorn || echo "No existing gunicorn processes found"

# Wait a moment for cleanup
sleep 2

# Start gunicorn (removed --preload to avoid worker deadlocks)
echo "🐍 Starting gunicorn..."
exec gunicorn --bind=0.0.0.0:8000 --workers 1 --timeout 30 --access-logfile - --error-logfile - --log-level info chat_api_server:app
