@echo off
REM Batch script to start both frontend and backend for development

echo Starting Azure Snap Seek Development Environment...
echo.

REM Check if virtual environment exists
if not exist ".venv" (
    echo Virtual environment not found. Creating...
    python -m venv .venv
    echo Installing backend dependencies...
    .venv\Scripts\pip install -r backend\requirements.txt
)

REM Check if frontend node_modules exists
if not exist "frontend\node_modules" (
    echo Node modules not found. Installing...
    cd frontend
    call npm install
    cd ..
)

echo.
echo Starting services...
echo   Backend:  http://localhost:8000
echo   Frontend: http://localhost:5173
echo   API Docs: http://localhost:8000/docs
echo.
echo Press Ctrl+C to stop all services
echo.

REM Start backend in new window
start "Backend Server" cmd /k ".venv\Scripts\activate && cd backend && python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000"

REM Start frontend in new window
start "Frontend Dev Server" cmd /k "cd frontend && npm run dev"

echo Services started in separate windows!
echo Close those windows to stop the services.
echo.
pause
