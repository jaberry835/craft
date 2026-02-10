"""FastAPI application entry point."""

import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import structlog

from .config import get_settings
from .routers import search_router, chat_router, persons_router
from .routers.images import router as images_router
from .models import HealthResponse
from .services import SearchService

# Configure standard logging
logging.basicConfig(
    format="%(message)s",
    level=logging.INFO,
)

# Configure structured logging
structlog.configure(
    processors=[
        structlog.stdlib.filter_by_level,
        structlog.stdlib.add_logger_name,
        structlog.stdlib.add_log_level,
        structlog.processors.TimeStamper(fmt="%Y-%m-%d %H:%M:%S"),
        structlog.dev.ConsoleRenderer(colors=True)  # Readable console output
    ],
    wrapper_class=structlog.stdlib.BoundLogger,
    context_class=dict,
    logger_factory=structlog.stdlib.LoggerFactory(),
    cache_logger_on_first_use=True,
)

logger = structlog.get_logger()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan manager."""
    logger.info("Starting Azure Snap Seek API")
    yield
    logger.info("Shutting down Azure Snap Seek API")


# Create FastAPI app
app = FastAPI(
    title="Azure Snap Seek API",
    description="Intelligent Image Search API powered by Azure AI",
    version="1.0.0",
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url="/redoc"
)

# Configure CORS
settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(search_router)
app.include_router(chat_router)
app.include_router(images_router)
app.include_router(persons_router)


@app.get("/", tags=["root"])
async def root():
    """Root endpoint."""
    return {
        "name": "Azure Snap Seek API",
        "version": "1.0.0",
        "docs": "/docs"
    }


@app.get("/health", response_model=HealthResponse, tags=["health"])
async def health_check() -> HealthResponse:
    """Health check endpoint."""
    try:
        search_service = SearchService(settings)
        doc_count = await search_service.get_document_count()
        
        return HealthResponse(
            status="healthy",
            version="1.0.0",
            search_index_count=doc_count
        )
    except Exception as e:
        logger.error("Health check failed", error=str(e))
        return HealthResponse(
            status="unhealthy",
            version="1.0.0",
            search_index_count=None
        )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "app.main:app",
        host=settings.host,
        port=settings.port,
        reload=True
    )
