#!/bin/bash
# Bash script to start both frontend and backend for development

set -e

echo -e "\033[36mStarting Azure Snap Seek Development Environment...\033[0m"
echo ""

# Check if virtual environment exists
if [ ! -d ".venv" ]; then
    echo -e "\033[33mVirtual environment not found. Creating...\033[0m"
    python3 -m venv .venv
    echo -e "\033[33mInstalling backend dependencies...\033[0m"
    .venv/bin/pip install -r backend/requirements.txt
fi

# Check if frontend node_modules exists
if [ ! -d "frontend/node_modules" ]; then
    echo -e "\033[33mNode modules not found. Installing...\033[0m"
    (cd frontend && npm install)
fi

echo ""
echo -e "\033[32mStarting services...\033[0m"
echo -e "  \033[36mBackend:  http://localhost:8000\033[0m"
echo -e "  \033[36mFrontend: http://localhost:5173\033[0m"
echo -e "  \033[36mAPI Docs: http://localhost:8000/docs\033[0m"
echo ""
echo -e "\033[33mPress Ctrl+C to stop all services\033[0m"
echo ""

# Cleanup function
cleanup() {
    echo ""
    echo -e "\033[33mStopping services...\033[0m"
    kill $BACKEND_PID $FRONTEND_PID 2>/dev/null || true
    wait $BACKEND_PID $FRONTEND_PID 2>/dev/null || true
    echo -e "\033[32mServices stopped.\033[0m"
    exit 0
}

# Set trap to catch Ctrl+C and cleanup
trap cleanup SIGINT SIGTERM

# Start backend
echo -e "\033[90m[Backend] Starting...\033[0m"
(source .venv/bin/activate && cd backend && python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000) &
BACKEND_PID=$!

# Start frontend
echo -e "\033[90m[Frontend] Starting...\033[0m"
(cd frontend && npm run dev) &
FRONTEND_PID=$!

echo ""
echo -e "\033[32mServices started!\033[0m"
echo -e "\033[90mBackend PID: $BACKEND_PID\033[0m"
echo -e "\033[90mFrontend PID: $FRONTEND_PID\033[0m"
echo ""

# Wait for processes
wait $BACKEND_PID $FRONTEND_PID
