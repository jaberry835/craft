"""Image proxy router for serving blob storage images via identity auth."""

import time
import hashlib
from fastapi import APIRouter, HTTPException, Response, Request, Header
from fastapi.responses import StreamingResponse
import structlog
from io import BytesIO
from typing import Optional

from ..config import get_settings
from ..services.blob_service import BlobService

router = APIRouter(prefix="/api/blob", tags=["blob"])
logger = structlog.get_logger()

# Initialize blob service
settings = get_settings()
blob_service = BlobService(settings)

# In-memory cache for small images (< 100KB)
_image_cache: dict[str, tuple[bytes, str, str]] = {}  # key -> (data, content_type, etag)
_CACHE_MAX_SIZE = 50
_CACHE_MAX_ITEM_SIZE = 100 * 1024  # 100KB


@router.get("/{container}/{blob_path:path}")
async def get_image(
    container: str, 
    blob_path: str,
    request: Request,
    if_none_match: Optional[str] = Header(default=None)
):
    """
    Proxy endpoint to retrieve images from Azure Blob Storage using identity auth.
    
    This endpoint fetches images from blob storage using the app's managed identity
    or local developer credentials, avoiding the need for public access or SAS tokens.
    
    Supports:
    - ETag-based conditional requests (If-None-Match)
    - In-memory caching for small images
    - Aggressive browser caching
    
    Args:
        container: The blob container name
        blob_path: The blob path/name (can include subdirectories)
        
    Returns:
        The image data with appropriate content type
    """
    global _image_cache
    
    if not blob_service.enabled:
        raise HTTPException(status_code=503, detail="Blob service not configured")
    
    cache_key = f"{container}/{blob_path}"
    
    # Check in-memory cache first
    if cache_key in _image_cache:
        cached_data, content_type, etag = _image_cache[cache_key]
        
        # Check if client has current version (304 Not Modified)
        if if_none_match and if_none_match == etag:
            return Response(status_code=304)
            
        return Response(
            content=cached_data,
            media_type=content_type,
            headers={
                "Cache-Control": "public, max-age=86400, immutable",  # 24 hours, immutable
                "ETag": etag,
                "X-Cache": "HIT",
            }
        )
    
    start_time = time.time()
    
    try:
        # Download the blob
        blob_data, content_type = await blob_service.download_blob(container, blob_path)
        
        elapsed_ms = (time.time() - start_time) * 1000
        size_kb = len(blob_data) / 1024
        
        # Generate ETag from content hash
        etag = f'"{hashlib.md5(blob_data).hexdigest()}"'
        
        # Check if client has current version
        if if_none_match and if_none_match == etag:
            return Response(status_code=304)
        
        # Cache small images in memory
        if len(blob_data) <= _CACHE_MAX_ITEM_SIZE:
            if len(_image_cache) >= _CACHE_MAX_SIZE:
                # Remove oldest entry
                oldest_key = next(iter(_image_cache))
                del _image_cache[oldest_key]
            _image_cache[cache_key] = (blob_data, content_type, etag)
        
        logger.info(
            "Blob download complete",
            blob=blob_path,
            container=container,
            size_kb=round(size_kb, 1),
            elapsed_ms=round(elapsed_ms, 1),
            throughput_kbps=round(size_kb / (elapsed_ms / 1000), 1) if elapsed_ms > 0 else 0
        )
        
        # Return the image with aggressive caching headers
        return Response(
            content=blob_data,
            media_type=content_type,
            headers={
                "Cache-Control": "public, max-age=86400, immutable",  # 24 hours, immutable
                "ETag": etag,
                "X-Content-Type-Options": "nosniff",
                "X-Blob-Time-Ms": str(round(elapsed_ms, 1)),
                "X-Cache": "MISS",
            }
        )
        
    except Exception as e:
        logger.error("Failed to retrieve image", error=str(e), container=container, blob=blob_path)
        raise HTTPException(status_code=404, detail=f"Image not found: {blob_path}")
