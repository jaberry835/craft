# PowerShell script to run the application
Write-Host "Starting Python API with MCP Server..." -ForegroundColor Green
Write-Host ""

# Check if virtual environment exists
if (-not (Test-Path "venv")) {
    Write-Host "Virtual environment not found. Running setup..." -ForegroundColor Yellow
    python setup.py
    Write-Host ""
}

# Activate virtual environment and run
& ".\venv\Scripts\Activate.ps1"
python main.py
