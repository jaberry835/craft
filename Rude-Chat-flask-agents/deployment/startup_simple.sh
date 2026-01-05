#!/bin/bash

echo "=== Starting Python App ==="
cd /home/site/wwwroot

echo "Working directory: $(pwd)"
echo "Files present:"
ls -la

echo "Python version: $(python --version)"

# Try to import the module directly
echo "Testing module import..."
python -c "
import sys
sys.path.insert(0, '/home/site/wwwroot')
print('Python path:', sys.path)
try:
    import chat_api_server
    print('✅ Successfully imported chat_api_server')
    print('Module file:', chat_api_server.__file__ if hasattr(chat_api_server, '__file__') else 'No __file__ attribute')
    print('Module attributes:', [attr for attr in dir(chat_api_server) if not attr.startswith('_')])
except ImportError as e:
    print('❌ Import error:', e)
    print('Available files in current directory:')
    import os
    for f in os.listdir('.'):
        print(f'  {f}')
except Exception as e:
    print('❌ Other error:', e)
"

# Start with a basic gunicorn command
echo "Starting gunicorn..."
export PYTHONPATH="/home/site/wwwroot:$PYTHONPATH"
exec gunicorn --bind=0.0.0.0:8000 --timeout 600 --access-logfile - --error-logfile - --workers 1 chat_api_server:app
