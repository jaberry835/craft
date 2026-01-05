#!/bin/bash

echo "=== Azure App Service Python Startup Script ==="
echo "Current directory: $(pwd)"
echo "Home directory: $HOME"
echo "Python version: $(python --version)"
echo "Python executable: $(which python)"

# Navigate to the app directory
cd /home/site/wwwroot
echo "Changed to: $(pwd)"

echo "=== Directory contents ==="
ls -la

echo "=== Python path ==="
python -c "import sys; print('\n'.join(sys.path))"

echo "=== Installing requirements ==="
if [ -f "requirements.txt" ]; then
    echo "Found requirements.txt, installing packages..."
    pip install --user -r requirements.txt
    echo "Packages installed"
else
    echo "No requirements.txt found"
fi

echo "=== Checking if chat_api_server can be imported ==="
python -c "
try:
    import chat_api_server
    print('✅ chat_api_server module imported successfully')
    print(f'Module file: {chat_api_server.__file__}')
except Exception as e:
    print(f'❌ Failed to import chat_api_server: {e}')
    import os
    print(f'Current directory: {os.getcwd()}')
    print(f'Files in current directory: {os.listdir(\".\")}')
"

echo "=== Starting gunicorn ==="
exec python -m gunicorn --bind=0.0.0.0:8000 --timeout 600 --access-logfile - --error-logfile - chat_api_server:app
