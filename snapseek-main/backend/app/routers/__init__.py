"""API routers package."""

from .search import router as search_router
from .chat import router as chat_router
from .persons import router as persons_router

__all__ = ["search_router", "chat_router", "persons_router"]
