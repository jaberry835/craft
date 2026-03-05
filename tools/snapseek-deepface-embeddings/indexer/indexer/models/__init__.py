"""Data models for image analysis and indexing."""

from datetime import datetime
from typing import Any
from pydantic import BaseModel, Field


class BoundingBox(BaseModel):
    """Bounding box coordinates."""
    x: int
    y: int
    width: int
    height: int


class DetectedObject(BaseModel):
    """Detected object in an image."""
    name: str
    confidence: float
    bounding_box: BoundingBox | None = None


class DetectedFace(BaseModel):
    """Detected face information."""
    face_id: str | None = None  # Temporary face ID (expires in 24h)
    persisted_face_id: str | None = None  # Permanent face ID in PersonGroup
    person_id: str | None = None  # Identified person ID
    person_name: str | None = None  # Person name (if assigned)
    confidence: float | None = None  # Identification confidence score
    age: int | None = None
    gender: str | None = None
    bounding_box: BoundingBox | None = None
    emotion: str | None = None


class ExtractedText(BaseModel):
    """Extracted text from OCR."""
    content: str
    confidence: float
    bounding_box: BoundingBox | None = None


class ImageAnalysisResult(BaseModel):
    """Complete analysis result from Azure Computer Vision."""
    caption: str | None = None
    caption_confidence: float | None = None
    dense_captions: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    objects: list[DetectedObject] = Field(default_factory=list)
    brands: list[str] = Field(default_factory=list)
    categories: list[str] = Field(default_factory=list)
    colors: dict[str, Any] = Field(default_factory=dict)
    image_type: dict[str, Any] = Field(default_factory=dict)
    adult_content: dict[str, Any] = Field(default_factory=dict)
    metadata: dict[str, Any] = Field(default_factory=dict)


class DocumentAnalysisResult(BaseModel):
    """OCR analysis result from Azure Document Intelligence."""
    extracted_text: str = ""
    text_blocks: list[ExtractedText] = Field(default_factory=list)
    language: str | None = None
    confidence: float | None = None


class FaceAnalysisResult(BaseModel):
    """Face detection result from Azure Face API."""
    faces: list[DetectedFace] = Field(default_factory=list)
    face_count: int = 0


class ImageEmbeddings(BaseModel):
    """Vector embeddings for an image."""
    description_vector: list[float] | None = None  # Text embedding from description
    image_vector: list[float] | None = None  # Direct image embedding


class FaceDocument(BaseModel):
    """A single face detected in an image, stored in the faces search index."""
    id: str = Field(..., description="Unique face document ID (hash of image_id + face_index)")
    image_id: str = Field(..., description="Reference to the parent ImageDocument ID")
    image_url: str | None = None
    filename: str | None = None
    face_index: int = Field(default=0, description="Index of this face within the image")
    bounding_box: dict[str, int] | None = None
    person_id: str | None = None
    person_name: str | None = None
    confidence: float | None = None
    face_embedding: list[float] | None = None

    def to_search_document(self) -> dict[str, Any]:
        """Convert to Azure Search document format."""
        doc = {
            "id": self.id,
            "image_id": self.image_id,
            "image_url": self.image_url,
            "filename": self.filename,
            "face_index": self.face_index,
            "person_id": self.person_id,
            "person_name": self.person_name,
            "confidence": self.confidence,
            "face_embedding": self.face_embedding,
        }
        if self.bounding_box:
            import json
            doc["bounding_box"] = json.dumps(self.bounding_box)
        # Remove None values
        return {k: v for k, v in doc.items() if v is not None}


class ImageDocument(BaseModel):
    """Complete indexed image document for Azure AI Search."""
    id: str = Field(..., description="Unique document ID")
    filename: str
    file_path: str
    file_url: str | None = None
    file_size: int | None = None
    content_type: str | None = None
    
    # Analysis results
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
    face_details: list[dict[str, Any]] = Field(default_factory=list)
    person_ids: list[str] = Field(default_factory=list)  # Unique person IDs for filtering
    persisted_face_ids: list[str] = Field(default_factory=list)  # Unique persisted face IDs for filtering
    person_names: list[str] = Field(default_factory=list)  # Named persons for search boosting
    
    # Colors and metadata
    dominant_colors: list[str] = Field(default_factory=list)
    accent_color: str | None = None
    is_black_white: bool = False
    
    # Rich description for embedding
    rich_description: str | None = None
    
    # Vector embeddings
    description_vector: list[float] | None = None
    image_vector: list[float] | None = None
    
    # Timestamps
    indexed_at: datetime = Field(default_factory=datetime.utcnow)
    modified_at: datetime | None = None
    
    # Additional metadata
    width: int | None = None
    height: int | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)

    def to_search_document(self) -> dict[str, Any]:
        """Convert to Azure Search document format."""
        import json
        
        # Explicitly build document with only index-compatible fields
        doc = {
            "id": self.id,
            "filename": self.filename,
            "file_path": self.file_path,
            "file_size": self.file_size,
            "content_type": self.content_type,
            
            # Analysis
            "caption": self.caption,
            "caption_confidence": self.caption_confidence,
            "dense_captions": self.dense_captions or [],
            "tags": self.tags or [],
            "objects": self.objects or [],
            "brands": self.brands or [],
            "categories": self.categories or [],
            
            # OCR
            "extracted_text": self.extracted_text if self.extracted_text else None,
            "has_text": self.has_text,
            
            # Faces
            "face_count": self.face_count,
            "has_faces": self.has_faces,
            "face_details": [json.dumps(fd) for fd in self.face_details] if self.face_details else [],
            "person_ids": self.person_ids or [],
            "persisted_face_ids": self.persisted_face_ids or [],
            "person_names": self.person_names or [],
            
            # Colors
            "dominant_colors": self.dominant_colors or [],
            "accent_color": self.accent_color,
            "is_black_white": self.is_black_white,
            
            # Rich description & vectors
            "rich_description": self.rich_description,
            "description_vector": self.description_vector,
            "image_vector": self.image_vector,
            
            # Timestamps - Azure Search requires ISO 8601 with timezone (Z for UTC)
            "indexed_at": self.indexed_at.isoformat() + "Z" if self.indexed_at else None,
            
            # Dimensions
            "width": self.width,
            "height": self.height,
        }
        
        # Add optional fields
        if self.file_url:
            doc["file_url"] = self.file_url
        if self.modified_at:
            doc["modified_at"] = self.modified_at.isoformat() + "Z"
        
        # Remove None values (but keep empty lists for Collection fields)
        return {k: v for k, v in doc.items() if v is not None}
        
        # Note: 'metadata' field is intentionally excluded - it's not in the search index

