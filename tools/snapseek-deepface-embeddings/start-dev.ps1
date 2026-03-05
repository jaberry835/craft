# PowerShell script to start both frontend and backend for development

Write-Host "Starting Azure Snap Seek Development Environment..." -ForegroundColor Cyan
Write-Host ""

# Check if virtual environment exists
if (-not (Test-Path ".venv")) {
    Write-Host "Virtual environment not found. Creating..." -ForegroundColor Yellow
    python -m venv .venv
    Write-Host "Installing backend dependencies..." -ForegroundColor Yellow
    & .venv\Scripts\pip install -r backend\requirements.txt
}

# Check if frontend node_modules exists
if (-not (Test-Path "frontend\node_modules")) {
    Write-Host "Node modules not found. Installing..." -ForegroundColor Yellow
    Push-Location frontend
    npm install
    Pop-Location
}

Write-Host ""
Write-Host "Starting services..." -ForegroundColor Green
Write-Host "  Backend:  http://localhost:8000" -ForegroundColor Cyan
Write-Host "  Frontend: http://localhost:5173" -ForegroundColor Cyan
Write-Host "  API Docs: http://localhost:8000/docs" -ForegroundColor Cyan
Write-Host ""
Write-Host "Press Ctrl+C to stop all services" -ForegroundColor Yellow
Write-Host ""

# Start backend in background
$backend = Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$PWD'; .\.venv\Scripts\Activate.ps1; cd backend; python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000" -PassThru

# Start frontend in background
$frontend = Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$PWD\frontend'; npm run dev" -PassThru

Write-Host "Services started!" -ForegroundColor Green
Write-Host "Backend PID: $($backend.Id)" -ForegroundColor Gray
Write-Host "Frontend PID: $($frontend.Id)" -ForegroundColor Gray
Write-Host ""
Write-Host "Close this window or press Ctrl+C to stop all services" -ForegroundColor Yellow

# Wait for Ctrl+C
try {
    while ($true) {
        Start-Sleep -Seconds 1
    }
}
finally {
    Write-Host ""
    Write-Host "Stopping services..." -ForegroundColor Yellow
    Stop-Process -Id $backend.Id -Force -ErrorAction SilentlyContinue
    Stop-Process -Id $frontend.Id -Force -ErrorAction SilentlyContinue
    Write-Host "Services stopped." -ForegroundColor Green
}
