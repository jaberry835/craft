#!/usr/bin/env python3
"""
Startup script for the Fictional Information API
"""
import os
import sys
import logging
from pathlib import Path

# Add the project root to the Python path
project_root = Path(__file__).parent
sys.path.insert(0, str(project_root))

def setup_environment():
    """Setup environment variables and configuration"""
    env_file = project_root / ".env"
    
    if not env_file.exists():
        print("⚠️  .env file not found. Please create one based on .env.example")
        print("📋 Copy .env.example to .env and update with your Azure OpenAI credentials")
        return False
    
    return True

def check_dependencies():
    """Check if all required dependencies are installed"""
    try:
        import fastapi
        import uvicorn
        import azure.identity
        import openai
        import pydantic
        print("✅ All dependencies are installed")
        return True
    except ImportError as e:
        print(f"❌ Missing dependency: {e}")
        print("🔧 Please install dependencies with: pip install -r requirements.txt")
        return False

def main():
    """Main startup function"""
    print("🚀 Starting Fictional Information API...")
    print("=" * 50)
    
    # Check environment
    if not setup_environment():
        sys.exit(1)
    
    # Check dependencies
    if not check_dependencies():
        sys.exit(1)
    
    # Import and setup the FastAPI app
    try:
        from main import app
        from swagger_config import setup_swagger_ui
        from config import settings
        
        # Setup Swagger UI
        setup_swagger_ui(app)
        
        print(f"📝 API Documentation: http://{settings.host}:{settings.port}/docs")
        print(f"🌐 API Base URL: http://{settings.host}:{settings.port}")
        print(f"❤️  Health Check: http://{settings.host}:{settings.port}/health")
        print("=" * 50)
        
        # Start the server
        import uvicorn
        uvicorn.run(
            "main:app",
            host=settings.host,
            port=settings.port,
            reload=settings.debug,
            log_level=settings.log_level.lower()
        )
        
    except Exception as e:
        print(f"❌ Failed to start server: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
