"""Routes package initialization."""
from routes.chat_routes import router as chat_router
from routes.admin_routes import router as admin_router
from routes.admin_routes import settings_router
from routes.document_routes import router as document_router
from routes.health_routes import router as health_router
from routes.a2a_routes import router as a2a_router
from routes.a2a_routes import a2a_server
from routes.preferences_routes import router as preferences_router
from routes.assist_routes import router as assist_router

__all__ = ["chat_router", "admin_router", "settings_router", "document_router", "health_router", "a2a_router", "a2a_server", "preferences_router", "assist_router"]
