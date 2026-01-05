#!/bin/bash

# Python MCP Server Startup Script

echo "Starting Python MCP Server..."

# Check if virtual environment exists
if [ ! -d "venv" ]; then
    echo "Creating virtual environment..."
    python -m venv venv
fi

# Activate virtual environment
echo "Activating virtual environment..."
if [ -f "venv/bin/activate" ]; then
    source venv/bin/activate
elif [ -f "venv/Scripts/activate" ]; then
    source venv/Scripts/activate
else
    echo "Error: Could not find virtual environment activation script"
    exit 1
fi

# Install dependencies
echo "Installing dependencies..."
pip install -r requirements.txt

# Check if config.json exists
if [ ! -f "config.json" ]; then
    echo "Warning: config.json not found. Copying from config.example.json"
    cp config.example.json config.json
    echo "Please edit config.json with your Azure service credentials before running the server."
    exit 1
fi

# Start the server
echo "Starting Flask-SocketIO server..."
python app.py
