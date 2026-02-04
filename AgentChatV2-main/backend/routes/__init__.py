"""Routes package initialization."""
from routes.chat_routes import router as chat_router
from routes.admin_routes import router as admin_router
from routes.document_routes import router as document_router
from routes.health_routes import router as health_router
from routes.a2a_routes import router as a2a_router

__all__ = ["chat_router", "admin_router", "document_router", "health_router", "a2a_router"]
