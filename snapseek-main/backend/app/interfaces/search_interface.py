"""Search service interface for abstraction."""

from abc import ABC, abstractmethod
from typing import Protocol

from ..models import (
    SearchRequest, SearchResponse,
    ImageDetail, ImageResult,
    ImageListRequest, ImageListResponse,
    FacetsResponse
)


class ISearchService(ABC):
    """Interface for search service implementations."""

    @abstractmethod
    async def search(self, request: SearchRequest) -> SearchResponse:
        """Execute search query."""
        pass

    @abstractmethod
    async def get_image(self, image_id: str) -> ImageDetail | None:
        """Get detailed information about a specific image."""
        pass

    @abstractmethod
    async def list_images(self, request: ImageListRequest) -> ImageListResponse:
        """List images with pagination."""
        pass

    @abstractmethod
    async def get_facets(self) -> FacetsResponse:
        """Get available facets for filtering."""
        pass

    @abstractmethod
    async def get_document_count(self) -> int:
        """Get total number of indexed documents."""
        pass

    @abstractmethod
    async def get_images_by_ids(self, doc_ids: list[str]) -> list[ImageResult]:
        """Get multiple images by their document IDs."""
        pass

    @abstractmethod
    async def update_person_name_in_documents(self, person_id: str, person_name: str) -> int:
        """Update person_name in face_details for all documents containing a person."""
        pass

    @abstractmethod
    async def find_images_by_face_id(self, face_id: str) -> list[dict]:
        """Find images containing a specific persisted_face_id."""
        pass
