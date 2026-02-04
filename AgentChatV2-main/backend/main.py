"""
AgentChatV2 - FastAPI Application Entry Point
Production-ready multi-agent chat platform with Microsoft Agent Framework.
"""
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from config import get_settings
from observability import setup_telemetry, get_logger
from auth.middleware import AuthMiddleware
from routes import chat_router, admin_router, document_router, health_router, a2a_router

settings = get_settings()
logger = get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifecycle management."""
    logger.info("Starting AgentChatV2...")
    setup_telemetry()
    
    # Initialize services
    from services.cosmos_service import cosmos_service
    from services.agent_manager import agent_manager
    from services.search_service import search_service
    from services.embedding_service import embedding_service
    
    await cosmos_service.initialize()
    await agent_manager.initialize()
    await search_service.initialize()
    await embedding_service.initialize()
    
    logger.info("AgentChatV2 started successfully")
    yield
    
    logger.info("Shutting down AgentChatV2...")
    await agent_manager.close()


app = FastAPI(
    title="AgentChatV2",
    description="Multi-Agent Chat Platform using Microsoft Agent Framework",
    version="2.0.0",
    lifespan=lifespan
)

# CORS configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Configure for production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Auth middleware
app.add_middleware(AuthMiddleware)

# Register API routes
app.include_router(health_router)
app.include_router(chat_router)
app.include_router(admin_router)
app.include_router(document_router)
app.include_router(a2a_router)  # A2A protocol endpoints for agent discovery and messaging


@app.get("/")
async def root():
    """Root endpoint with API info."""
    return {
        "name": "AgentChatV2",
        "version": "2.0.0",
        "description": "Multi-Agent Chat Platform",
        "docs": "/docs"
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=5000,
        reload=settings.environment == "development"
    )
