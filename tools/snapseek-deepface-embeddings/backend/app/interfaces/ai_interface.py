"""AI service interfaces for abstraction."""

from abc import ABC, abstractmethod
from typing import Any


class IEmbeddingService(ABC):
    """Interface for embedding generation services."""

    @abstractmethod
    def generate_embedding(self, text: str) -> list[float]:
        """Generate embedding for the given text."""
        pass


class IFaceService(ABC):
    """Interface for face recognition services."""

    @abstractmethod
    async def list_persons(self) -> list[dict[str, Any]]:
        """List all persons."""
        pass

    @abstractmethod
    async def get_person(self, person_id: str) -> dict[str, Any] | None:
        """Get a specific person by ID."""
        pass

    @abstractmethod
    async def update_person_name(self, person_id: str, name: str) -> bool:
        """Update a person's name."""
        pass

    @abstractmethod
    async def detect_face(self, image_data: bytes) -> str | None:
        """Detect a face in an image and return temporary faceId."""
        pass

    @abstractmethod
    async def find_similar_faces(
        self,
        face_id: str,
        max_results: int = 100,
        threshold: float = 0.5
    ) -> list[dict]:
        """Find similar faces."""
        pass

    @abstractmethod
    async def get_face_list_metadata(self) -> list[dict]:
        """Get all faces with their metadata."""
        pass
