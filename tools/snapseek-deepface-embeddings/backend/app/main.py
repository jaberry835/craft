"""FastAPI application entry point."""

import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import structlog

from .config import get_settings
from .routers import search_router, chat_router, persons_router
from .routers.images import router as images_router
from .models import HealthResponse, ServiceHealth
from .services import SearchService

# Configure standard logging
logging.basicConfig(
    format="%(message)s",
    level=logging.INFO,
)

# Suppress verbose Azure SDK HTTP logging
logging.getLogger("azure.core.pipeline.policies.http_logging_policy").setLevel(logging.WARNING)
logging.getLogger("azure.identity").setLevel(logging.WARNING)

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
    """
    Comprehensive health check endpoint for all Azure services.

    Checks:
    - Azure AI Search (doc count)
    - Azure OpenAI (embedding generation)
    - Azure Face API (if configured)
    """
    services = []
    doc_count = None

    # Check Azure AI Search
    try:
        search_service = SearchService(settings)
        doc_count = await search_service.get_document_count()
        services.append(ServiceHealth(
            service="Azure AI Search",
            status="healthy",
            message=f"{doc_count} documents indexed"
        ))
    except Exception as e:
        services.append(ServiceHealth(
            service="Azure AI Search",
            status="unhealthy",
            message=str(e)[:100]
        ))

    # Check Azure OpenAI (embedding generation)
    try:
        search_service = SearchService(settings)
        # Generate a test embedding to verify OpenAI connectivity
        test_embedding = search_service._generate_embedding("health check")
        if test_embedding and len(test_embedding) > 0:
            services.append(ServiceHealth(
                service="Azure OpenAI",
                status="healthy",
                message=f"Embedding dimension: {len(test_embedding)}"
            ))
        else:
            services.append(ServiceHealth(
                service="Azure OpenAI",
                status="unhealthy",
                message="Empty embedding returned"
            ))
    except Exception as e:
        services.append(ServiceHealth(
            service="Azure OpenAI",
            status="unhealthy",
            message=str(e)[:100]
        ))

    # Check Azure Face API (if configured)
    if settings.azure_face_endpoint:
        try:
            from .services.person_service import get_person_service
            person_service = get_person_service(settings)
            if person_service.enabled:
                # Try to list persons to verify connectivity
                persons = await person_service.list_persons()
                services.append(ServiceHealth(
                    service="Azure Face API",
                    status="healthy",
                    message=f"{len(persons)} persons in group"
                ))
            else:
                services.append(ServiceHealth(
                    service="Azure Face API",
                    status="disabled",
                    message="Not configured"
                ))
        except Exception as e:
            services.append(ServiceHealth(
                service="Azure Face API",
                status="unhealthy",
                message=str(e)[:100]
            ))
    else:
        services.append(ServiceHealth(
            service="Azure Face API",
            status="disabled",
            message="Not configured"
        ))

    # Check Local Face Matching (deepface + faces index)
    if settings.enable_local_face_matching:
        try:
            from .services.face_match_service import get_face_match_service
            face_match_svc = get_face_match_service(settings)
            if face_match_svc.enabled:
                face_count = face_match_svc.get_face_count()
                services.append(ServiceHealth(
                    service="Local Face Matching",
                    status="healthy",
                    message=f"{face_count} face embeddings indexed"
                ))
            else:
                services.append(ServiceHealth(
                    service="Local Face Matching",
                    status="disabled",
                    message="Not enabled"
                ))
        except Exception as e:
            services.append(ServiceHealth(
                service="Local Face Matching",
                status="unhealthy",
                message=str(e)[:100]
            ))
    else:
        services.append(ServiceHealth(
            service="Local Face Matching",
            status="disabled",
            message="Not enabled"
        ))

    # Determine overall status
    unhealthy_count = sum(1 for s in services if s.status == "unhealthy")
    disabled_count = sum(1 for s in services if s.status == "disabled")

    if unhealthy_count > 0:
        overall_status = "unhealthy" if unhealthy_count == len(services) - disabled_count else "degraded"
    else:
        overall_status = "healthy"

    return HealthResponse(
        status=overall_status,
        version="1.0.0",
        services=services,
        search_index_count=doc_count
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "app.main:app",
        host=settings.host,
        port=settings.port,
        reload=True
    )
