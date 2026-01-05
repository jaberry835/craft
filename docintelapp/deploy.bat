@echo off
echo 🚀 Starting deployment process...

REM Check if Node.js is available
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo ❌ Node.js is not installed or not in PATH
    exit /b 1
)

REM Build the application
echo 📦 Building application...
call npm run build

if %errorlevel% neq 0 (
    echo ❌ Build failed!
    exit /b 1
)

REM Create deployment package
echo 📁 Creating deployment package...
if exist dist.zip del dist.zip
powershell -Command "Compress-Archive -Path 'dist\*' -DestinationPath 'dist.zip' -Force"

if %errorlevel% neq 0 (
    echo ❌ Failed to create deployment package!
    exit /b 1
)

echo ✅ Deployment package created: dist.zip
echo.
echo Next steps:
echo 1. Go to Azure Portal → App Service → Deployment Center
echo 2. Choose 'Zip Deploy'
echo 3. Upload the dist.zip file
echo.
echo Or use Azure CLI:
echo az webapp deployment source config-zip --resource-group j-ai-rg --name docintelsimp --src dist.zip
echo use:  pm2 serve /home/site/wwwroot/ --no-daemon --spa

pause
