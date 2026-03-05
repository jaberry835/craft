"""
Health Check Routes
System health monitoring endpoints.
"""
from datetime import datetime, timezone
import time

from fastapi import APIRouter

from models import HealthResponse, ServiceHealth
from services.cosmos_service import cosmos_service
from services.search_service import search_service
from services.agent_manager import agent_manager
from config import get_settings
from observability import get_logger

router = APIRouter(prefix="/api/health", tags=["health"])
logger = get_logger(__name__)
settings = get_settings()


async def check_cosmos() -> ServiceHealth:
    """Check Cosmos DB connectivity."""
    start = time.time()
    try:
        # Simple query to verify connection
        await cosmos_service.list_agents()
        latency = (time.time() - start) * 1000
        return ServiceHealth(
            name="cosmos_db",
            status="healthy",
            latency_ms=round(latency, 2)
        )
    except Exception as e:
        return ServiceHealth(
            name="cosmos_db",
            status="unhealthy",
            message=str(e)
        )


async def check_search() -> ServiceHealth:
    """Check Azure AI Search connectivity."""
    start = time.time()
    try:
        # Verify index exists
        if search_service.index_client:
            search_service.index_client.get_index(search_service.INDEX_NAME)
            latency = (time.time() - start) * 1000
            return ServiceHealth(
                name="azure_search",
                status="healthy",
                latency_ms=round(latency, 2)
            )
        return ServiceHealth(
            name="azure_search",
            status="degraded",
            message="Not initialized"
        )
    except Exception as e:
        return ServiceHealth(
            name="azure_search",
            status="unhealthy",
            message=str(e)
        )


async def check_agents() -> ServiceHealth:
    """Check agent manager status."""
    try:
        configs = agent_manager._configs_cache
        return ServiceHealth(
            name="agent_manager",
            status="healthy",
            message=f"{len(configs)} agents loaded"
        )
    except Exception as e:
        return ServiceHealth(
            name="agent_manager",
            status="unhealthy",
            message=str(e)
        )


@router.get("", response_model=HealthResponse)
@router.get("/", response_model=HealthResponse)
async def health_check():
    """
    Comprehensive health check for all services.
    Returns overall status and individual service statuses.
    """
    services = [
        await check_cosmos(),
        await check_search(),
        await check_agents()
    ]
    
    # Determine overall status
    statuses = [s.status for s in services]
    if all(s == "healthy" for s in statuses):
        overall = "healthy"
    elif any(s == "unhealthy" for s in statuses):
        overall = "unhealthy"
    else:
        overall = "degraded"
    
    return HealthResponse(
        status=overall,
        version="1.0.0",
        services=services,
        timestamp=datetime.now(timezone.utc)
    )


@router.get("/ready")
async def readiness_check():
    """
    Simple readiness check for Kubernetes/container orchestrators.
    Returns 200 if the service can accept traffic.
    """
    try:
        # Quick check that critical services are initialized
        if cosmos_service.client is None:
            return {"ready": False, "message": "Cosmos DB not initialized"}
        
        return {"ready": True}
    except Exception as e:
        return {"ready": False, "message": str(e)}


@router.get("/live")
async def liveness_check():
    """
    Simple liveness check.
    Returns 200 if the process is alive.
    """
    return {"alive": True, "timestamp": datetime.now(timezone.utc).isoformat()}
