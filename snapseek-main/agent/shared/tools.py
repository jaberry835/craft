"""Image search tools for the SnapSeek agent."""

import json
from typing import Any
import structlog
from azure.search.documents import SearchClient
from azure.search.documents.models import VectorizedQuery
from openai import AzureOpenAI

from .config import Settings, get_settings, get_search_credential, get_openai_token_provider

logger = structlog.get_logger()


class ImageSearchTools:
    """Tools for searching and retrieving images from Azure AI Search."""
    
    def __init__(self, settings: Settings | None = None):
        """Initialize the search tools."""
        self.settings = settings or get_settings()
        
        self.search_client = SearchClient(
            endpoint=self.settings.azure_search_endpoint,
            index_name=self.settings.azure_search_index_name,
            credential=get_search_credential(self.settings)
        )
        
        # Try identity-based auth first, fall back to API key
        token_provider = get_openai_token_provider()
        if token_provider:
            logger.info("Using DefaultAzureCredential for Azure OpenAI")
            self.openai_client = AzureOpenAI(
                azure_endpoint=self.settings.azure_openai_endpoint,
                azure_ad_token_provider=token_provider,
                api_version=self.settings.azure_openai_api_version
            )
        elif self.settings.azure_openai_key:
            logger.info("Using API key for Azure OpenAI")
            self.openai_client = AzureOpenAI(
                azure_endpoint=self.settings.azure_openai_endpoint,
                api_key=self.settings.azure_openai_key,
                api_version=self.settings.azure_openai_api_version
            )
        else:
            raise ValueError("No valid credential available for Azure OpenAI")
        
        self.logger = logger.bind(component="image_search_tools")
    
    def _generate_embedding(self, text: str) -> list[float]:
        """Generate embedding for search query."""
        response = self.openai_client.embeddings.create(
            model=self.settings.azure_openai_embedding_deployment,
            input=text[:8000],
            dimensions=self.settings.text_embedding_dimensions
        )
        return response.data[0].embedding
    
    def search_images(
        self,
        query: str,
        top: int = 10,
        tags: list[str] | None = None,
        objects: list[str] | None = None,
        has_text: bool | None = None,
        has_faces: bool | None = None,
        use_vector_search: bool = True
    ) -> dict[str, Any]:
        """
        Search for images using hybrid search.
        
        Args:
            query: Natural language search query
            top: Maximum number of results to return
            tags: Filter by specific tags
            objects: Filter by detected objects
            has_text: Filter images containing text
            has_faces: Filter images containing faces
            use_vector_search: Enable vector search for semantic matching
            
        Returns:
            Dictionary with search results
        """
        self.logger.info("Searching images", query=query, top=top)
        
        # Build filter
        filters = []
        if tags:
            tag_filters = [f"tags/any(t: t eq '{tag}')" for tag in tags]
            filters.append(f"({' or '.join(tag_filters)})")
        if objects:
            obj_filters = [f"objects/any(o: o eq '{obj}')" for obj in objects]
            filters.append(f"({' or '.join(obj_filters)})")
        if has_text is not None:
            filters.append(f"has_text eq {str(has_text).lower()}")
        if has_faces is not None:
            filters.append(f"has_faces eq {str(has_faces).lower()}")
        
        filter_expr = " and ".join(filters) if filters else None
        
        # Prepare search
        search_kwargs: dict[str, Any] = {
            "search_text": query,
            "top": top,
            "select": [
                "id", "filename", "file_url", "caption", "tags", "objects",
                "extracted_text", "has_text", "face_count", "has_faces",
                "dominant_colors", "width", "height"
            ]
        }
        
        if filter_expr:
            search_kwargs["filter"] = filter_expr
        
        if use_vector_search:
            query_embedding = self._generate_embedding(query)
            search_kwargs["vector_queries"] = [
                VectorizedQuery(
                    vector=query_embedding,
                    k_nearest_neighbors=50,
                    fields="description_vector"
                )
            ]
        
        # Execute search
        results = self.search_client.search(**search_kwargs)
        
        # Format results
        images = []
        for result in results:
            images.append({
                "id": result["id"],
                "filename": result["filename"],
                "file_url": result.get("file_url"),
                "caption": result.get("caption"),
                "tags": result.get("tags", []),
                "objects": result.get("objects", []),
                "extracted_text": result.get("extracted_text"),
                "has_text": result.get("has_text", False),
                "face_count": result.get("face_count", 0),
                "has_faces": result.get("has_faces", False),
                "dominant_colors": result.get("dominant_colors", []),
                "dimensions": f"{result.get('width', 0)}x{result.get('height', 0)}",
                "relevance_score": result.get("@search.score")
            })
        
        self.logger.info("Search complete", result_count=len(images))
        
        return {
            "query": query,
            "total_results": len(images),
            "images": images
        }
    
    def get_image_details(self, image_id: str) -> dict[str, Any] | None:
        """
        Get detailed information about a specific image.
        
        Args:
            image_id: The unique identifier of the image
            
        Returns:
            Dictionary with image details or None if not found
        """
        self.logger.info("Getting image details", image_id=image_id)
        
        try:
            result = self.search_client.get_document(key=image_id)
            
            return {
                "id": result["id"],
                "filename": result["filename"],
                "file_path": result.get("file_path"),
                "file_url": result.get("file_url"),
                "caption": result.get("caption"),
                "dense_captions": result.get("dense_captions", []),
                "tags": result.get("tags", []),
                "objects": result.get("objects", []),
                "extracted_text": result.get("extracted_text"),
                "has_text": result.get("has_text", False),
                "face_count": result.get("face_count", 0),
                "has_faces": result.get("has_faces", False),
                "face_details": result.get("face_details", []),
                "dominant_colors": result.get("dominant_colors", []),
                "accent_color": result.get("accent_color"),
                "rich_description": result.get("rich_description"),
                "dimensions": f"{result.get('width', 0)}x{result.get('height', 0)}",
                "file_size": result.get("file_size"),
                "indexed_at": result.get("indexed_at")
            }
        except Exception as e:
            self.logger.warning("Image not found", image_id=image_id, error=str(e))
            return None
    
    def find_similar_images(self, image_id: str, top: int = 5) -> dict[str, Any]:
        """
        Find images similar to a given image.
        
        Args:
            image_id: The ID of the reference image
            top: Number of similar images to return
            
        Returns:
            Dictionary with similar images
        """
        self.logger.info("Finding similar images", image_id=image_id, top=top)
        
        # Get the source image's description vector
        try:
            source = self.search_client.get_document(
                key=image_id,
                selected_fields=["id", "filename", "description_vector", "caption"]
            )
        except Exception:
            return {"error": f"Image {image_id} not found", "images": []}
        
        if not source.get("description_vector"):
            return {"error": "Source image has no embedding", "images": []}
        
        # Search for similar images
        results = self.search_client.search(
            search_text="*",
            top=top + 1,  # Include source image
            vector_queries=[
                VectorizedQuery(
                    vector=source["description_vector"],
                    k_nearest_neighbors=50,
                    fields="description_vector"
                )
            ],
            select=[
                "id", "filename", "file_url", "caption", "tags"
            ]
        )
        
        # Filter out source image
        similar = []
        for result in results:
            if result["id"] != image_id:
                similar.append({
                    "id": result["id"],
                    "filename": result["filename"],
                    "file_url": result.get("file_url"),
                    "caption": result.get("caption"),
                    "tags": result.get("tags", []),
                    "similarity_score": result.get("@search.score")
                })
                if len(similar) >= top:
                    break
        
        return {
            "source_image": {
                "id": image_id,
                "filename": source["filename"],
                "caption": source.get("caption")
            },
            "similar_images": similar
        }
    
    def get_collection_stats(self) -> dict[str, Any]:
        """
        Get statistics about the image collection.
        
        Returns:
            Dictionary with collection statistics
        """
        self.logger.info("Getting collection stats")
        
        # Get total count
        total_count = self.search_client.get_document_count()
        
        # Get facets
        results = self.search_client.search(
            search_text="*",
            top=0,
            facets=[
                "tags,count:20",
                "objects,count:20",
                "dominant_colors,count:10",
                "has_text,count:2",
                "has_faces,count:2"
            ]
        )
        
        facets = results.get_facets()
        
        return {
            "total_images": total_count,
            "top_tags": [{"name": f["value"], "count": f["count"]} for f in facets.get("tags", [])],
            "top_objects": [{"name": f["value"], "count": f["count"]} for f in facets.get("objects", [])],
            "top_colors": [{"name": f["value"], "count": f["count"]} for f in facets.get("dominant_colors", [])],
            "images_with_text": sum(f["count"] for f in facets.get("has_text", []) if f["value"]),
            "images_with_faces": sum(f["count"] for f in facets.get("has_faces", []) if f["value"])
        }


# Tool definitions for function calling
TOOL_DEFINITIONS = [
    {
        "type": "function",
        "function": {
            "name": "search_images",
            "description": "Search for images in the collection using natural language queries. Supports filtering by tags, objects, text presence, and face presence.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Natural language search query describing what images to find"
                    },
                    "top": {
                        "type": "integer",
                        "description": "Maximum number of results to return (default: 10)",
                        "default": 10
                    },
                    "tags": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Filter by specific tags"
                    },
                    "objects": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Filter by detected objects"
                    },
                    "has_text": {
                        "type": "boolean",
                        "description": "Filter images that contain text"
                    },
                    "has_faces": {
                        "type": "boolean",
                        "description": "Filter images that contain faces"
                    }
                },
                "required": ["query"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "get_image_details",
            "description": "Get detailed information about a specific image including all analysis data, tags, detected text, and face information.",
            "parameters": {
                "type": "object",
                "properties": {
                    "image_id": {
                        "type": "string",
                        "description": "The unique identifier of the image"
                    }
                },
                "required": ["image_id"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "find_similar_images",
            "description": "Find images that are visually or semantically similar to a given image.",
            "parameters": {
                "type": "object",
                "properties": {
                    "image_id": {
                        "type": "string",
                        "description": "The ID of the reference image to find similar images for"
                    },
                    "top": {
                        "type": "integer",
                        "description": "Number of similar images to return (default: 5)",
                        "default": 5
                    }
                },
                "required": ["image_id"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "get_collection_stats",
            "description": "Get statistics about the image collection including total count, popular tags, common objects, and color distribution.",
            "parameters": {
                "type": "object",
                "properties": {}
            }
        }
    }
]
