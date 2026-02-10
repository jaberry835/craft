"""Request and response models for the API."""

from datetime import datetime
from typing import Any
from pydantic import BaseModel, Field


# Search Models
class SearchRequest(BaseModel):
    """Search request parameters."""
    query: str = Field(..., min_length=1, max_length=500, description="Search query text")
    top: int = Field(default=20, ge=1, le=100, description="Number of results to return")
    skip: int = Field(default=0, ge=0, description="Number of results to skip")
    
    # Filters
    tags: list[str] | None = Field(default=None, description="Filter by tags")
    objects: list[str] | None = Field(default=None, description="Filter by detected objects")
    has_text: bool | None = Field(default=None, description="Filter images with text")
    has_faces: bool | None = Field(default=None, description="Filter images with faces")
    min_faces: int | None = Field(default=None, description="Minimum face count")
    colors: list[str] | None = Field(default=None, description="Filter by dominant colors")
    person_ids: list[str] | None = Field(default=None, description="Filter by person IDs (face identification)")
    
    # Search modes
    use_vector_search: bool = Field(default=True, description="Enable vector search")
    use_semantic_search: bool = Field(default=True, description="Enable semantic search")
    
    # Score filtering
    min_score: float | None = Field(default=None, ge=0, le=1, description="Minimum normalized score (0-1)")


class ImageResult(BaseModel):
    """Single image search result."""
    id: str
    filename: str
    file_url: str | None = None
    caption: str | None = None
    tags: list[str] = Field(default_factory=list)
    objects: list[str] = Field(default_factory=list)
    extracted_text: str | None = None
    has_text: bool = False
    face_count: int = 0
    has_faces: bool = False
    dominant_colors: list[str] = Field(default_factory=list)
    score: float | None = None
    
    # Additional metadata
    width: int | None = None
    height: int | None = None
    file_size: int | None = None


class SearchResponse(BaseModel):
    """Search results response."""
    results: list[ImageResult]
    total_count: int
    filtered_count: int | None = None  # Count after score filtering
    query: str
    took_ms: float | None = None


class FacetValue(BaseModel):
    """Single facet value with count."""
    value: str
    count: int


class FacetsResponse(BaseModel):
    """Available facets for filtering."""
    tags: list[FacetValue] = Field(default_factory=list)
    objects: list[FacetValue] = Field(default_factory=list)
    colors: list[FacetValue] = Field(default_factory=list)
    has_text: list[FacetValue] = Field(default_factory=list)
    has_faces: list[FacetValue] = Field(default_factory=list)


# Image Detail Models
class BoundingBox(BaseModel):
    """Bounding box coordinates."""
    x: int
    y: int
    width: int
    height: int


class FaceDetail(BaseModel):
    """Face detection details."""
    face_id: str | None = None
    persisted_face_id: str | None = None
    person_id: str | None = None
    person_name: str | None = None
    confidence: float | None = None
    age: int | None = None
    emotion: str | None = None
    bounding_box: BoundingBox | None = None


class ImageDetail(BaseModel):
    """Detailed image information."""
    id: str
    filename: str
    file_path: str
    file_url: str | None = None
    file_size: int | None = None
    content_type: str | None = None
    
    # Analysis
    caption: str | None = None
    caption_confidence: float | None = None
    dense_captions: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    objects: list[str] = Field(default_factory=list)
    brands: list[str] = Field(default_factory=list)
    categories: list[str] = Field(default_factory=list)
    
    # OCR
    extracted_text: str | None = None
    has_text: bool = False
    
    # Faces
    face_count: int = 0
    has_faces: bool = False
    face_details: list[FaceDetail] = Field(default_factory=list)
    person_ids: list[str] = Field(default_factory=list)
    
    # Colors
    dominant_colors: list[str] = Field(default_factory=list)
    accent_color: str | None = None
    is_black_white: bool = False
    
    # Rich description
    rich_description: str | None = None
    
    # Dimensions
    width: int | None = None
    height: int | None = None
    
    # Timestamps
    indexed_at: datetime | None = None


# Chat Models
class ChatMessage(BaseModel):
    """Single chat message."""
    role: str = Field(..., pattern="^(user|assistant|system)$")
    content: str


class ChatRequest(BaseModel):
    """Chat request with history."""
    message: str = Field(..., min_length=1, max_length=2000, description="User message")
    history: list[ChatMessage] = Field(default_factory=list, max_length=20)
    include_images: bool = Field(default=True, description="Include relevant images in response")


class ChatImageReference(BaseModel):
    """Image reference in chat response."""
    id: str
    filename: str
    file_url: str | None = None
    caption: str | None = None
    relevance_reason: str | None = None


class ChatResponse(BaseModel):
    """Chat response with optional images."""
    message: str
    images: list[ChatImageReference] = Field(default_factory=list)
    search_query: str | None = None


# List Models
class ImageListRequest(BaseModel):
    """Request for listing images."""
    top: int = Field(default=50, ge=1, le=200)
    skip: int = Field(default=0, ge=0)
    order_by: str = Field(default="indexed_at", pattern="^(indexed_at|filename|file_size)$")
    order_desc: bool = Field(default=True)


class ImageListResponse(BaseModel):
    """Response for image listing."""
    images: list[ImageResult]
    total_count: int
    skip: int
    top: int


# Health Models
class HealthResponse(BaseModel):
    """Health check response."""
    status: str
    version: str
    search_index_count: int | None = None
