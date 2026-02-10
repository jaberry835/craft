"""Search API endpoints."""

from functools import lru_cache
from fastapi import APIRouter, Depends, HTTPException

from ..config import Settings, get_settings
from ..models import (
    SearchRequest, SearchResponse,
    FacetsResponse, ImageDetail,
    ImageListRequest, ImageListResponse
)
from ..services import SearchService

router = APIRouter(prefix="/api", tags=["search"])

# Cached singleton instance
_search_service: SearchService | None = None


def get_search_service(settings: Settings = Depends(get_settings)) -> SearchService:
    """Dependency to get cached search service singleton."""
    global _search_service
    if _search_service is None:
        _search_service = SearchService(settings)
    return _search_service


@router.post("/search", response_model=SearchResponse)
async def search_images(
    request: SearchRequest,
    service: SearchService = Depends(get_search_service)
) -> SearchResponse:
    """
    Search for images using hybrid search (keyword + vector + semantic).
    
    - **query**: Search query text
    - **top**: Number of results to return (default: 20)
    - **skip**: Number of results to skip for pagination
    - **tags**: Filter by specific tags
    - **objects**: Filter by detected objects
    - **has_text**: Filter images containing text
    - **has_faces**: Filter images containing faces
    """
    try:
        return await service.search(request)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Search failed: {str(e)}")


@router.get("/images/{image_id}", response_model=ImageDetail)
async def get_image(
    image_id: str,
    service: SearchService = Depends(get_search_service)
) -> ImageDetail:
    """
    Get detailed information about a specific image.
    
    - **image_id**: Unique identifier of the image
    """
    result = await service.get_image(image_id)
    if result is None:
        raise HTTPException(status_code=404, detail="Image not found")
    return result


@router.get("/images", response_model=ImageListResponse)
async def list_images(
    top: int = 50,
    skip: int = 0,
    order_by: str = "indexed_at",
    order_desc: bool = True,
    service: SearchService = Depends(get_search_service)
) -> ImageListResponse:
    """
    List all indexed images with pagination.
    
    - **top**: Number of images to return (default: 50)
    - **skip**: Number of images to skip
    - **order_by**: Field to order by (indexed_at, filename, file_size)
    - **order_desc**: Order descending (default: true)
    """
    request = ImageListRequest(
        top=top,
        skip=skip,
        order_by=order_by,
        order_desc=order_desc
    )
    return await service.list_images(request)


@router.get("/facets", response_model=FacetsResponse)
async def get_facets(
    service: SearchService = Depends(get_search_service)
) -> FacetsResponse:
    """
    Get available facets for filtering.
    
    Returns counts for tags, objects, colors, and boolean filters.
    """
    return await service.get_facets()
