@echo off
echo Starting Python API with MCP Server...
echo.

REM Check if virtual environment exists
if not exist "venv\" (
    echo Virtual environment not found. Running setup...
    python setup.py
    echo.
)

REM Activate virtual environment and run
call venv\Scripts\activate.bat
python main.py

pause
