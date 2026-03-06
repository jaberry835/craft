"""Service abstraction interfaces."""

from .search_interface import ISearchService
from .ai_interface import IEmbeddingService, IFaceService

__all__ = ["ISearchService", "IEmbeddingService", "IFaceService"]
