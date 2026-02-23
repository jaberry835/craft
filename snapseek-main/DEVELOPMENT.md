# Development Quick Start

This guide explains how to run the Azure Snap Seek application for development.

## Prerequisites

- Python 3.10+
- Node.js 18+
- Azure credentials configured (see main README.md)

## Quick Start Scripts

### Windows

**Option 1: PowerShell (Recommended)**
```powershell
.\start-dev.ps1
```

**Option 2: Command Prompt**
```cmd
start-dev.bat
```

### Linux/Mac

```bash
chmod +x start-dev.sh
./start-dev.sh
```

## VS Code Debugging

If you're using VS Code, you can use the built-in debugger:

1. Open the Run and Debug panel (Ctrl+Shift+D / Cmd+Shift+D)
2. Select "Full Stack: Backend + Frontend" from the dropdown
3. Click the green play button or press F5

This will start both services with debugger attached, allowing breakpoints and step-through debugging.

## Manual Start

### Backend Only

```bash
cd backend
python -m venv ../.venv  # Creates .venv at root level
source ../.venv/bin/activate  # or ..\.venv\Scripts\activate on Windows
pip install -r requirements.txt
python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Backend will be available at:
- API: http://localhost:8000
- Interactive docs: http://localhost:8000/docs
- Health check: http://localhost:8000/health

### Frontend Only

```bash
cd frontend
npm install
npm run dev
```

Frontend will be available at: http://localhost:5173

## Environment Variables

Create a `.env` file in the `backend` directory with your Azure credentials:

```env
AZURE_SEARCH_ENDPOINT=https://your-search.search.windows.net
AZURE_SEARCH_INDEX_NAME=your-index
AZURE_OPENAI_ENDPOINT=https://your-openai.openai.azure.com
AZURE_OPENAI_DEPLOYMENT=your-deployment
AZURE_OPENAI_EMBEDDING_DEPLOYMENT=your-embedding-deployment
# ... etc
```

See the main README.md for full configuration details.

## Stopping Services

- **PowerShell/Bash scripts**: Press `Ctrl+C` in the terminal
- **Batch script**: Close the spawned windows
- **VS Code**: Click the stop button in the debug toolbar

## Troubleshooting

### Port already in use

If you get port conflict errors:

```bash
# Kill process on port 8000 (backend)
# Windows
netstat -ano | findstr :8000
taskkill /PID <pid> /F

# Linux/Mac
lsof -i :8000
kill -9 <pid>

# Kill process on port 5173 (frontend)
# Windows
netstat -ano | findstr :5173
taskkill /PID <pid> /F

# Linux/Mac
lsof -i :5173
kill -9 <pid>
```

### Virtual environment issues

Delete and recreate:

```bash
rm -rf .venv  # or rmdir /s .venv on Windows
python -m venv .venv
.venv/bin/pip install -r backend/requirements.txt  # or .venv\Scripts\pip on Windows
```

### Node modules issues

```bash
cd frontend
rm -rf node_modules package-lock.json
npm install
```

## API Testing

Once services are running:

1. **Swagger UI**: http://localhost:8000/docs
2. **ReDoc**: http://localhost:8000/redoc
3. **Health Check**: http://localhost:8000/health

Example API call:
```bash
curl -X POST http://localhost:8000/api/v1/search \
  -H "Content-Type: application/json" \
  -d '{"query": "sunset beach", "top": 10}'
```

## Hot Reload

Both services support hot reload:

- **Backend**: Changes to Python files automatically reload the server
- **Frontend**: Changes to React/TypeScript files automatically refresh the browser

## Building for Production

See the main README.md for production build and deployment instructions.
