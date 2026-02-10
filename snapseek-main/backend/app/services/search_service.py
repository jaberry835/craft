"""Azure AI Search service for image retrieval."""

import json
import math
import time
import structlog
from functools import lru_cache
from azure.search.documents import SearchClient
from azure.search.documents.models import VectorizedQuery
from openai import AzureOpenAI

from ..config import Settings, get_search_credential, get_openai_token_provider
from ..models import (
    SearchRequest, SearchResponse, ImageResult,
    FacetsResponse, FacetValue,
    ImageDetail, ImageListRequest, ImageListResponse
)
from .blob_service import BlobService

logger = structlog.get_logger()

# Module-level embedding cache (survives service instances)
_embedding_cache: dict[str, list[float]] = {}
_CACHE_MAX_SIZE = 100


class SearchService:
    """Service for searching and retrieving images from Azure AI Search."""
    
    def __init__(self, settings: Settings):
        """Initialize the search service."""
        self.settings = settings
        
        self.search_client = SearchClient(
            endpoint=settings.azure_search_endpoint,
            index_name=settings.azure_search_index_name,
            credential=get_search_credential(settings)
        )
        
        # Initialize blob service for proxy URL generation
        self.blob_service = BlobService(settings)
        
        # Try identity-based auth first, fall back to API key
        token_provider = get_openai_token_provider()
        if token_provider:
            logger.info("Using DefaultAzureCredential for Azure OpenAI")
            self.openai_client = AzureOpenAI(
                azure_endpoint=settings.azure_openai_endpoint,
                azure_ad_token_provider=token_provider,
                api_version=settings.azure_openai_api_version
            )
        elif settings.azure_openai_key:
            logger.info("Using API key for Azure OpenAI")
            self.openai_client = AzureOpenAI(
                azure_endpoint=settings.azure_openai_endpoint,
                api_key=settings.azure_openai_key,
                api_version=settings.azure_openai_api_version
            )
        else:
            raise ValueError("No valid credential available for Azure OpenAI")
        
        self.logger = logger.bind(component="search_service")
    
    def _generate_embedding(self, text: str) -> list[float]:
        """Generate embedding for search query with caching."""
        global _embedding_cache
        
        # Check cache first
        cache_key = text.lower().strip()
        if cache_key in _embedding_cache:
            self.logger.debug("Embedding cache hit", query=text[:50])
            return _embedding_cache[cache_key]
        
        # Generate new embedding
        response = self.openai_client.embeddings.create(
            model=self.settings.azure_openai_embedding_deployment,
            input=text[:8000],
            dimensions=self.settings.text_embedding_dimensions
        )
        embedding = response.data[0].embedding
        
        # Cache it (with simple size limit)
        if len(_embedding_cache) >= _CACHE_MAX_SIZE:
            # Remove oldest entry (first key)
            oldest_key = next(iter(_embedding_cache))
            del _embedding_cache[oldest_key]
        _embedding_cache[cache_key] = embedding
        
        return embedding
    
    def _build_filter(self, request: SearchRequest) -> str | None:
        """Build OData filter from search request."""
        filters = []
        
        if request.tags:
            tag_filters = [f"tags/any(t: t eq '{tag}')" for tag in request.tags]
            filters.append(f"({' or '.join(tag_filters)})")
        
        if request.objects:
            obj_filters = [f"objects/any(o: o eq '{obj}')" for obj in request.objects]
            filters.append(f"({' or '.join(obj_filters)})")
        
        if request.has_text is not None:
            filters.append(f"has_text eq {str(request.has_text).lower()}")
        
        if request.has_faces is not None:
            filters.append(f"has_faces eq {str(request.has_faces).lower()}")
        
        if request.min_faces is not None:
            filters.append(f"face_count ge {request.min_faces}")
        
        if request.colors:
            color_filters = [f"dominant_colors/any(c: c eq '{color}')" for color in request.colors]
            filters.append(f"({' or '.join(color_filters)})")
        
        if request.person_ids:
            person_filters = [f"person_ids/any(p: p eq '{pid}')" for pid in request.person_ids]
            filters.append(f"({' or '.join(person_filters)})")
        
        return " and ".join(filters) if filters else None
    
    async def search(self, request: SearchRequest) -> SearchResponse:
        """
        Execute hybrid search combining keyword, vector, and semantic search.
        
        Args:
            request: Search request parameters
            
        Returns:
            SearchResponse with matching images
        """
        self.logger.info("Executing search", query=request.query)
        start_time = time.time()
        timings = {}
        
        # Build filter
        filter_expr = self._build_filter(request)
        
        # Prepare vector query if enabled
        vector_queries = []
        if request.use_vector_search:
            embed_start = time.time()
            query_embedding = self._generate_embedding(request.query)
            timings['embedding_ms'] = round((time.time() - embed_start) * 1000, 1)
            vector_queries.append(
                VectorizedQuery(
                    vector=query_embedding,
                    k_nearest_neighbors=50,
                    fields="description_vector"
                )
            )
        
        # Execute search
        search_kwargs = {
            "search_text": request.query,
            "top": request.top,
            "skip": request.skip,
            "include_total_count": True,
            "select": [
                "id", "filename", "file_url", "caption", "tags", "objects",
                "extracted_text", "has_text", "face_count", "has_faces",
                "dominant_colors", "width", "height", "file_size"
            ]
        }
        
        if filter_expr:
            search_kwargs["filter"] = filter_expr
        
        if vector_queries:
            search_kwargs["vector_queries"] = vector_queries
        
        if request.use_semantic_search and self.settings.enable_semantic_search:
            search_kwargs["query_type"] = "semantic"
            search_kwargs["semantic_configuration_name"] = "semantic-config"
        
        search_start = time.time()
        results = self.search_client.search(**search_kwargs)
        
        # Collect results first to normalize scores
        raw_results = list(results)
        timings['search_ms'] = round((time.time() - search_start) * 1000, 1)
        total_before_filter = results.get_count() or len(raw_results)
        
        # Log-scale normalization for scores
        # Azure Search scores are unbounded and can vary wildly (0.01 to 100+)
        # Log-scale compression makes score differences more meaningful
        raw_scores = [r.get("@search.score", 0) for r in raw_results]
        
        # Initialize defaults
        log_min = 0.0
        log_max = 1.0
        log_range = 1.0
        
        if raw_scores and any(s > 0 for s in raw_scores):
            # Find score range (only positive scores)
            positive_scores = [s for s in raw_scores if s > 0]
            min_score = min(positive_scores)
            max_score = max(positive_scores)
            
            # Apply log transformation: log(score + 1) to handle scores near 0
            # Then normalize to 0-1 range based on log range
            log_min = math.log(min_score + 1)
            log_max = math.log(max_score + 1)
            log_range = log_max - log_min if log_max > log_min else 1.0
        
        # Process results
        process_start = time.time()
        images = []
        for result in raw_results:
            raw_score = result.get("@search.score", 0)
            
            # Log-scale normalization
            if raw_score > 0 and log_range > 0:
                log_score = math.log(raw_score + 1)
                # Normalize: map log range to 0.3-1.0 (so even lowest matches show as 30%+)
                normalized_score = 0.3 + 0.7 * (log_score - log_min) / log_range
            else:
                normalized_score = 0.0
            
            # Clamp to 0-1 range
            normalized_score = max(0.0, min(1.0, normalized_score))
            
            # Filter by min_score if specified
            if request.min_score is not None and normalized_score < request.min_score:
                continue
            
            # Convert blob URL to proxy URL for identity-based access
            file_url = result.get("file_url")
            if file_url:
                file_url = self.blob_service.get_proxy_url(file_url)
            
            images.append(ImageResult(
                id=result["id"],
                filename=result["filename"],
                file_url=file_url,
                caption=result.get("caption"),
                tags=result.get("tags", []),
                objects=result.get("objects", []),
                extracted_text=result.get("extracted_text"),
                has_text=result.get("has_text", False),
                face_count=result.get("face_count", 0),
                has_faces=result.get("has_faces", False),
                dominant_colors=result.get("dominant_colors", []),
                score=normalized_score,
                width=result.get("width"),
                height=result.get("height"),
                file_size=result.get("file_size")
            ))
        
        timings['process_ms'] = round((time.time() - process_start) * 1000, 1)
        elapsed_ms = (time.time() - start_time) * 1000
        timings['total_ms'] = round(elapsed_ms, 1)
        
        self.logger.info(
            "Search complete",
            query=request.query,
            result_count=len(images),
            filtered_from=len(raw_results),
            **timings
        )
        
        return SearchResponse(
            results=images,
            total_count=len(images),  # Return filtered count as total
            filtered_count=len(images),
            query=request.query,
            took_ms=elapsed_ms
        )
    
    async def get_image(self, image_id: str) -> ImageDetail | None:
        """
        Get detailed information about a specific image.
        
        Args:
            image_id: The image document ID
            
        Returns:
            ImageDetail or None if not found
        """
        self.logger.info("Fetching image details", image_id=image_id)
        
        try:
            result = self.search_client.get_document(key=image_id)
            
            # Convert blob URL to proxy URL for identity-based access
            file_url = result.get("file_url")
            if file_url:
                file_url = self.blob_service.get_proxy_url(file_url)
            
            # Parse face_details from JSON strings
            import json
            face_details_raw = result.get("face_details", [])
            face_details = []
            for fd in face_details_raw:
                try:
                    if isinstance(fd, str):
                        face_details.append(json.loads(fd))
                    else:
                        face_details.append(fd)
                except (json.JSONDecodeError, TypeError):
                    pass
            
            return ImageDetail(
                id=result["id"],
                filename=result["filename"],
                file_path=result.get("file_path", ""),
                file_url=file_url,
                file_size=result.get("file_size"),
                content_type=result.get("content_type"),
                caption=result.get("caption"),
                caption_confidence=result.get("caption_confidence"),
                dense_captions=result.get("dense_captions", []),
                tags=result.get("tags", []),
                objects=result.get("objects", []),
                brands=result.get("brands", []),
                categories=result.get("categories", []),
                extracted_text=result.get("extracted_text"),
                has_text=result.get("has_text", False),
                face_count=result.get("face_count", 0),
                has_faces=result.get("has_faces", False),
                face_details=face_details,
                person_ids=result.get("person_ids", []),
                dominant_colors=result.get("dominant_colors", []),
                accent_color=result.get("accent_color"),
                is_black_white=result.get("is_black_white", False),
                rich_description=result.get("rich_description"),
                width=result.get("width"),
                height=result.get("height"),
                indexed_at=result.get("indexed_at")
            )
        except Exception as e:
            self.logger.warning("Image not found", image_id=image_id, error=str(e))
            return None
    
    async def list_images(self, request: ImageListRequest) -> ImageListResponse:
        """
        List images with pagination.
        
        Args:
            request: List request parameters
            
        Returns:
            ImageListResponse with images
        """
        self.logger.info("Listing images", skip=request.skip, top=request.top)
        
        order_direction = "desc" if request.order_desc else "asc"
        
        results = self.search_client.search(
            search_text="*",
            top=request.top,
            skip=request.skip,
            include_total_count=True,
            order_by=[f"{request.order_by} {order_direction}"],
            select=[
                "id", "filename", "file_url", "caption", "tags", "objects",
                "has_text", "face_count", "has_faces", "dominant_colors",
                "width", "height", "file_size"
            ]
        )
        
        images = []
        for result in results:
            # Convert blob URL to proxy URL for identity-based access
            file_url = result.get("file_url")
            if file_url:
                file_url = self.blob_service.get_proxy_url(file_url)
            
            images.append(ImageResult(
                id=result["id"],
                filename=result["filename"],
                file_url=file_url,
                caption=result.get("caption"),
                tags=result.get("tags", []),
                objects=result.get("objects", []),
                has_text=result.get("has_text", False),
                face_count=result.get("face_count", 0),
                has_faces=result.get("has_faces", False),
                dominant_colors=result.get("dominant_colors", []),
                width=result.get("width"),
                height=result.get("height"),
                file_size=result.get("file_size")
            ))
        
        return ImageListResponse(
            images=images,
            total_count=results.get_count() or len(images),
            skip=request.skip,
            top=request.top
        )
    
    async def get_facets(self) -> FacetsResponse:
        """
        Get available facets for filtering.
        
        Returns:
            FacetsResponse with facet values and counts
        """
        self.logger.info("Fetching facets")
        
        results = self.search_client.search(
            search_text="*",
            top=0,
            facets=[
                "tags,count:50",
                "objects,count:50",
                "dominant_colors,count:20",
                "has_text,count:2",
                "has_faces,count:2"
            ]
        )
        
        facets = results.get_facets()
        
        response = FacetsResponse()
        
        if "tags" in facets:
            response.tags = [
                FacetValue(value=f["value"], count=f["count"])
                for f in facets["tags"]
            ]
        
        if "objects" in facets:
            response.objects = [
                FacetValue(value=f["value"], count=f["count"])
                for f in facets["objects"]
            ]
        
        if "dominant_colors" in facets:
            response.colors = [
                FacetValue(value=f["value"], count=f["count"])
                for f in facets["dominant_colors"]
            ]
        
        if "has_text" in facets:
            response.has_text = [
                FacetValue(value=str(f["value"]), count=f["count"])
                for f in facets["has_text"]
            ]
        
        if "has_faces" in facets:
            response.has_faces = [
                FacetValue(value=str(f["value"]), count=f["count"])
                for f in facets["has_faces"]
            ]
        
        return response
    
    async def get_document_count(self) -> int:
        """Get total number of indexed documents."""
        try:
            return self.search_client.get_document_count()
        except Exception:
            return 0

    async def get_images_by_ids(self, doc_ids: list[str]) -> list[ImageResult]:
        """
        Get multiple images by their document IDs.
        
        Args:
            doc_ids: List of document IDs to retrieve
            
        Returns:
            List of ImageResult objects
        """
        if not doc_ids:
            return []
        
        self.logger.info("Fetching images by IDs", count=len(doc_ids))
        
        # Build filter for multiple IDs
        id_filters = [f"id eq '{doc_id}'" for doc_id in doc_ids]
        filter_str = f"({' or '.join(id_filters)})"
        
        results = self.search_client.search(
            search_text="*",
            filter=filter_str,
            top=len(doc_ids),
            select=[
                "id", "filename", "file_url", "caption", "tags", "objects",
                "has_text", "face_count", "has_faces", "dominant_colors",
                "width", "height", "file_size"
            ]
        )
        
        images = []
        for result in results:
            file_url = result.get("file_url")
            if file_url:
                file_url = self.blob_service.get_proxy_url(file_url)
            
            images.append(ImageResult(
                id=result["id"],
                filename=result["filename"],
                file_url=file_url,
                caption=result.get("caption"),
                tags=result.get("tags", []),
                objects=result.get("objects", []),
                has_text=result.get("has_text", False),
                face_count=result.get("face_count", 0),
                has_faces=result.get("has_faces", False),
                dominant_colors=result.get("dominant_colors", []),
                width=result.get("width"),
                height=result.get("height"),
                file_size=result.get("file_size")
            ))
        
        return images

    async def update_person_name_in_documents(self, person_id: str, person_name: str) -> int:
        """
        Update person_name in face_details for all documents containing a person.
        
        Args:
            person_id: The person ID to update
            person_name: The new name to set
            
        Returns:
            Number of documents updated
        """
        import json
        
        self.logger.info("Updating person name in documents", 
                        person_id=person_id, person_name=person_name)
        
        # Find all documents with this person_id
        results = self.search_client.search(
            search_text="*",
            filter=f"person_ids/any(p: p eq '{person_id}')",
            top=1000,
            select=["id", "face_details"]
        )
        
        updated_count = 0
        batch = []
        
        for result in results:
            doc_id = result["id"]
            face_details_raw = result.get("face_details", [])
            
            # Parse and update face_details
            updated_face_details = []
            modified = False
            
            for fd in face_details_raw:
                try:
                    if isinstance(fd, str):
                        face = json.loads(fd)
                    else:
                        face = fd
                    
                    if face.get("person_id") == person_id:
                        face["person_name"] = person_name
                        modified = True
                    
                    # Re-serialize as JSON string for storage
                    updated_face_details.append(json.dumps(face))
                except (json.JSONDecodeError, TypeError):
                    updated_face_details.append(fd)
            
            if modified:
                batch.append({
                    "id": doc_id,
                    "face_details": updated_face_details,
                    "@search.action": "merge"
                })
                updated_count += 1
        
        # Upload updates in batch
        if batch:
            self.search_client.upload_documents(documents=batch)
            self.logger.info("Document batch updated", count=len(batch))
        
        return updated_count

    async def find_images_by_face_id(self, face_id: str) -> list[dict]:
        """Find images containing a specific persisted_face_id."""
        if not self.search_client:
            self.logger.warning("Search client not initialized")
            return []
        
        try:
            # Use the persisted_face_ids field for efficient filtering
            self.logger.info("Searching for images by face ID", face_id=face_id)
            results = self.search_client.search(
                search_text="*",
                filter=f"persisted_face_ids/any(f: f eq '{face_id}')",
                top=100,
                select=["id", "filename", "file_url", "face_details", "person_ids"]
            )
            
            matches = []
            for result in results:
                # Find the specific face details for this face ID
                face_details_raw = result.get("face_details", [])
                person_id = None
                person_name = None
                
                for fd in face_details_raw:
                    try:
                        face = json.loads(fd) if isinstance(fd, str) else fd
                        if face.get("persisted_face_id") == face_id:
                            person_id = face.get("person_id")
                            person_name = face.get("person_name")
                            break
                    except (json.JSONDecodeError, TypeError):
                        continue
                
                matches.append({
                    "id": result.get("id"),
                    "filename": result.get("filename"),
                    "file_url": result.get("file_url"),
                    "person_id": person_id,
                    "person_name": person_name
                })
            
            self.logger.info("Found matching images", count=len(matches))
            return matches
        except Exception as e:
            self.logger.error("Error finding images by face ID", error=str(e))
            return []


# Singleton instance
_search_service: SearchService | None = None


def get_search_service(settings: Settings) -> SearchService:
    """Get or create singleton SearchService instance."""
    global _search_service
    if _search_service is None:
        _search_service = SearchService(settings)
    return _search_service
