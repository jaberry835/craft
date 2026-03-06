"""Download endpoints – build ZIP, upload to blob storage, return proxy URL."""

from __future__ import annotations

import io
import zipfile
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
import structlog

from ..config import Settings, get_settings
from ..services.blob_service import BlobService
from ..services.search_service import SearchService

router = APIRouter(prefix="/api/v1/downloads", tags=["downloads"])
logger = structlog.get_logger()

DOWNLOADS_CONTAINER = "snapseek-downloads"

# Singletons ------------------------------------------------------------------
_blob_service: BlobService | None = None
_search_service: SearchService | None = None


def _get_blob_service(settings: Settings = Depends(get_settings)) -> BlobService:
    global _blob_service
    if _blob_service is None:
        _blob_service = BlobService(settings)
    return _blob_service


def _get_search_service(settings: Settings = Depends(get_settings)) -> SearchService:
    global _search_service
    if _search_service is None:
        _search_service = SearchService(settings)
    return _search_service


# Request / Response models ----------------------------------------------------

class ZipRequest(BaseModel):
    """Request body for creating a ZIP download."""
    image_ids: list[str] = Field(..., min_length=1, max_length=500)
    group_by_date: bool = Field(default=False, description="Organise images into date folders")


class ZipResponse(BaseModel):
    """Response containing a download URL for the ZIP."""
    download_url: str = Field(..., description="Proxy URL to download the ZIP")
    filename: str
    image_count: int
    size_kb: int


# Helpers ----------------------------------------------------------------------

def _parse_proxy_url(raw_url: str, blob_service: BlobService) -> tuple[str, str] | None:
    """Extract (container, blob_path) from a proxy or absolute blob URL."""
    proxy_prefix = "/api/v1/blob/"
    if raw_url.startswith(proxy_prefix):
        rest = raw_url[len(proxy_prefix):]
        parts = rest.split("/", 1)
        if len(parts) == 2:
            return parts[0], parts[1]
        return None
    return blob_service.parse_blob_url(raw_url)


# Endpoint ---------------------------------------------------------------------

@router.post("/zip", response_model=ZipResponse)
async def create_zip(
    request: ZipRequest,
    settings: Settings = Depends(get_settings),
):
    """Build a ZIP of the requested images, upload it to blob storage,
    and return a proxy URL the frontend can open directly.
    """
    blob_service = _get_blob_service(settings)
    search_service = _get_search_service(settings)

    if not blob_service.enabled:
        raise HTTPException(status_code=503, detail="Blob service not configured")

    # 1. Fetch metadata for each image (try by ID first, fall back to filename search)
    image_metas: list[dict] = []
    for img_id in request.image_ids:
        detail = None
        try:
            detail = await search_service.get_image(img_id)
        except Exception:
            pass

        # Fallback: the model may have passed a filename stem instead of a doc ID
        if detail is None:
            try:
                from azure.search.documents import SearchClient
                hits = search_service.search_client.search(
                    search_text=img_id,
                    search_fields=["filename"],
                    select=["id", "filename", "file_url", "indexed_at"],
                    top=1,
                )
                for hit in hits:
                    detail = type("D", (), {
                        "id": hit["id"],
                        "filename": hit.get("filename"),
                        "file_url": hit.get("file_url"),
                        "indexed_at": hit.get("indexed_at"),
                    })()
                    # Convert to proxy URL if needed
                    if detail.file_url and not detail.file_url.startswith("/api/"):
                        detail.file_url = blob_service.get_proxy_url(detail.file_url)
                    break
            except Exception:
                pass

        if detail and detail.file_url:
            image_metas.append({
                "id": detail.id,
                "filename": detail.filename or f"{detail.id}.jpg",
                "file_url": detail.file_url,
                "indexed_at": detail.indexed_at,
            })

    if not image_metas:
        raise HTTPException(status_code=404, detail="No downloadable images found")

    # 2. Download source blobs and build the ZIP in memory
    buf = io.BytesIO()
    added = 0
    seen_names: dict[str, int] = {}

    def _unique_name(base: str, folder: str = "") -> str:
        key = f"{folder}/{base}"
        if key in seen_names:
            seen_names[key] += 1
            name, ext = base.rsplit(".", 1) if "." in base else (base, "jpg")
            base = f"{name}_{seen_names[key]}.{ext}"
        else:
            seen_names[key] = 0
        return f"{folder}/{base}" if folder else base

    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for meta in image_metas:
            parsed = _parse_proxy_url(meta["file_url"], blob_service)
            if not parsed:
                continue
            container, blob_path = parsed

            try:
                data, _ct = await blob_service.download_blob(container, blob_path)
            except Exception as exc:
                logger.warning("Zip: skip blob", blob=blob_path, error=str(exc))
                continue

            folder = ""
            if request.group_by_date and meta.get("indexed_at"):
                dt = meta["indexed_at"]
                if isinstance(dt, str):
                    try:
                        dt = datetime.fromisoformat(dt.replace("Z", "+00:00"))
                    except ValueError:
                        dt = None
                if dt:
                    folder = dt.strftime("%Y-%m-%d")

            arcname = _unique_name(meta["filename"], folder)
            zf.writestr(arcname, data)
            added += 1

    if added == 0:
        raise HTTPException(status_code=500, detail="Could not download any images")

    zip_bytes = buf.getvalue()
    size_kb = round(len(zip_bytes) / 1024)
    logger.info("ZIP built", images=added, size_kb=size_kb)

    # 3. Upload ZIP to blob storage
    timestamp = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
    zip_name = f"snapseek_{timestamp}.zip"

    proxy_url = await blob_service.upload_blob(
        container_name=DOWNLOADS_CONTAINER,
        blob_name=zip_name,
        data=zip_bytes,
        content_type="application/zip",
    )

    logger.info("ZIP uploaded to blob", url=proxy_url, filename=zip_name)

    return ZipResponse(
        download_url=proxy_url,
        filename=zip_name,
        image_count=added,
        size_kb=size_kb,
    )
