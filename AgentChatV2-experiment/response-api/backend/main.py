"""
AgentChatV2 - FastAPI Application Entry Point
Production-ready multi-agent chat platform with Microsoft Agent Framework.
"""
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded

from config import get_settings
from observability import setup_telemetry, get_logger
from auth.middleware import AuthMiddleware
from rate_limit import limiter
from routes import chat_router, admin_router, settings_router, document_router, health_router, a2a_router, a2a_server, preferences_router, assist_router

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
    from services.document_intelligence_service import document_intelligence_service
    
    await cosmos_service.initialize()
    await agent_manager.initialize()
    await search_service.initialize()
    await embedding_service.initialize()
    await document_intelligence_service.initialize()
    
    # Mount A2A SDK routes for each local agent (JSON-RPC + agent cards)
    await a2a_server.mount_agents(app)
    
    logger.info("AgentChatV2 started successfully")
    yield
    
    logger.info("Shutting down AgentChatV2...")
    await agent_manager.close()
    await cosmos_service.close()


app = FastAPI(
    title="AgentChatV2",
    description="Multi-Agent Chat Platform using Microsoft Agent Framework",
    version="2.0.0",
    lifespan=lifespan
)

# Rate limiting
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# CORS configuration
# allow_origins=["*"] with allow_credentials=True is invalid per the CORS spec
# and browsers will reject credentialed requests. Use explicit origins.
_cors_origins = [o.strip() for o in settings.cors_origins.split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
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
app.include_router(settings_router)  # Public UI settings endpoint
app.include_router(document_router)
app.include_router(a2a_router)  # A2A protocol endpoints for agent discovery and messaging
app.include_router(preferences_router)  # User preferences (theme, etc.)
app.include_router(assist_router)  # Browser-extension assist endpoints (additive)


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
