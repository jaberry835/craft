@echo off
echo Starting Python MCP Server...

REM Check if virtual environment exists
if not exist "venv" (
    echo Creating virtual environment...
    python -m venv venv
)

REM Activate virtual environment
echo Activating virtual environment...
if exist "venv\Scripts\activate.bat" (
    call venv\Scripts\activate.bat
) else (
    echo Error: Could not find virtual environment activation script
    exit /b 1
)

REM Install dependencies
echo Installing dependencies...
pip install -r requirements.txt

REM Check if config.json exists
if not exist "config.json" (
    echo Warning: config.json not found. Copying from config.example.json
    copy config.example.json config.json
    echo Please edit config.json with your Azure service credentials before running the server.
    exit /b 1
)

REM Start the server
echo Starting Flask-SocketIO server...
python app.py
