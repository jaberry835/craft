@echo off
REM Quick deployment script for Windows
REM This calls the PowerShell script with default parameters

echo ========================================================
echo Azure App Service Deployment Script (Windows)
echo Flask API + Angular Frontend
echo ========================================================
echo.

REM Check if PowerShell is available
where powershell >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo ERROR: PowerShell is not available. Please install PowerShell.
    pause
    exit /b 1
)

REM Run the PowerShell deployment script
echo Starting PowerShell deployment script...
powershell -ExecutionPolicy Bypass -File "deploy.ps1"

if %ERRORLEVEL% neq 0 (
    echo ERROR: Deployment failed. Check the output above for details.
    pause
    exit /b 1
)

echo.
echo Deployment completed successfully!
echo.
pause
