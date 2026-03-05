"""
Document API Routes
File upload, indexing, and search with Azure AI Search.
"""
from typing import Optional
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Request, HTTPException, UploadFile, File, Form, Query

from models import (
    DocumentMetadata, DocumentUploadResponse,
    DocumentSearchResult, DocumentSearchResponse
)
from services.cosmos_service import cosmos_service
from services.search_service import search_service
from services.embedding_service import embedding_service
from services.grounding_service import grounding_service
from services.security_token_service import security_token_service
from services.document_intelligence_service import document_intelligence_service
from observability import get_logger, track_performance, MetricType

router = APIRouter(prefix="/api/documents", tags=["documents"])
logger = get_logger(__name__)

# Supported file types
ALLOWED_TYPES = {
    "text/plain": "txt",
    "text/markdown": "md",
    "application/pdf": "pdf",
    "application/json": "json",
    "text/csv": "csv",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/tiff": "tiff",
}

MAX_FILE_SIZE = 10 * 1024 * 1024  # 10MB


@router.post("/upload", response_model=DocumentUploadResponse)
@track_performance("document_upload", MetricType.HTTP_REQUEST)
async def upload_document(
    request: Request,
    file: UploadFile = File(...),
    session_id: str = Form(...)
):
    """
    Upload a document and index it for RAG.
    The document is chunked, embedded, and stored in Azure AI Search.
    """
    user = request.state.user
    
    # Validate session
    session = await cosmos_service.get_session(session_id, user.user_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    
    # Validate file type
    content_type = file.content_type or "application/octet-stream"
    if content_type not in ALLOWED_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"File type not supported. Allowed: {list(ALLOWED_TYPES.values())}"
        )
    
    # Read file content
    content = await file.read()
    if len(content) > MAX_FILE_SIZE:
        raise HTTPException(status_code=400, detail=f"File too large. Max: {MAX_FILE_SIZE // 1024 // 1024}MB")
    
    # --- Extract text: DI first, then local fallback ---
    file_ext = ALLOWED_TYPES[content_type]
    text_content = None
    extraction_method = "unknown"
    
    # Try Document Intelligence for binary/complex documents
    if document_intelligence_service.is_available and document_intelligence_service.supports_file(file.filename):
        text_content = await document_intelligence_service.extract_text_or_none(content, file.filename)
        if text_content:
            extraction_method = "document-intelligence"
            logger.info(f"Extracted text via Document Intelligence: {len(text_content)} chars from {file.filename}")
    
    # Fallback: local parsing for text files or when DI is unavailable/failed
    if text_content is None:
        if file_ext in ("txt", "md", "json", "csv"):
            # Plain text — decode directly
            try:
                text_content = content.decode("utf-8")
                extraction_method = "utf8-decode"
            except UnicodeDecodeError:
                raise HTTPException(status_code=400, detail="File must be valid UTF-8 text")
        elif file_ext == "pdf":
            # Fallback PDF parser (pymupdf)
            from services.grounding_service import grounding_service as gs
            text_content = gs._extract_text_from_pdf(content)
            extraction_method = "pymupdf-fallback"
        elif file_ext == "docx":
            from services.grounding_service import grounding_service as gs
            text_content = gs._extract_text_from_docx(content)
            extraction_method = "python-docx-fallback"
        elif file_ext == "xlsx":
            from services.grounding_service import grounding_service as gs
            text_content = gs._extract_text_from_excel(content)
            extraction_method = "openpyxl-fallback"
        elif file_ext == "pptx":
            from services.grounding_service import grounding_service as gs
            text_content = gs._extract_text_from_pptx(content)
            extraction_method = "python-pptx-fallback"
        elif file_ext in ("jpg", "png", "tiff"):
            # Images: DI OCR is optional — vision path uses base64, not extracted text
            logger.info(f"No text extracted from image {file.filename} (DI unavailable or failed); proceeding with vision-only path")
            extraction_method = "vision-only"
        else:
            raise HTTPException(status_code=400, detail=f"Cannot extract text from .{file_ext} files")
    
    # For non-image files, text extraction is required
    is_image = file_ext in ("jpg", "png", "tiff")
    if not is_image and (not text_content or not text_content.strip()):
        raise HTTPException(status_code=422, detail="No text could be extracted from the uploaded file")
    
    # Generate document ID
    doc_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc)
    
    # Chunk and embed (skip if no text was extracted, e.g. image-only uploads)
    chunks_with_embeddings = []
    if text_content and text_content.strip():
        logger.info(f"Document extraction: method={extraction_method}, chars={len(text_content)}, file={file.filename}")
        chunks_with_embeddings = await embedding_service.chunk_and_embed(text_content)
        
        for i, (chunk_text, embedding) in enumerate(chunks_with_embeddings):
            chunk_id = f"{doc_id}_{i}"
            await search_service.index_document(
                doc_id=chunk_id,
                session_id=session_id,
                user_id=user.user_id,
                title=f"{file.filename} (chunk {i+1})",
                content=chunk_text,
                file_type=file_ext,
                embedding=embedding,
                uploaded_at=now.isoformat()
            )
    
    metadata = DocumentMetadata(
        id=doc_id,
        session_id=session_id,
        title=file.filename,
        file_type=ALLOWED_TYPES[content_type],
        size_bytes=len(content),
        uploaded_at=now,
        chunks_count=len(chunks_with_embeddings)
    )
    
    # Update session with document reference
    try:
        # Get raw session to get existing documents in CosmosDB format
        raw_session = await cosmos_service.get_session_raw(session_id, user.user_id)
        existing_docs = raw_session.get("documents", []) if raw_session else []
        doc_ref = {
            "id": doc_id,
            "title": file.filename,
            "fileType": ALLOWED_TYPES[content_type],
            "sizeBytes": len(content),
            "uploadedAt": now.isoformat(),
            "chunksCount": len(chunks_with_embeddings)
        }
        existing_docs.append(doc_ref)
        await cosmos_service.update_session(session_id, user.user_id, {"documents": existing_docs})
        logger.info(f"Updated session {session_id} with document reference")
    except Exception as e:
        logger.warning(f"Failed to update session with document reference: {e}")
    
    logger.info(f"Uploaded document {doc_id}: {file.filename} ({len(chunks_with_embeddings)} chunks)")
    
    # For image uploads, save a chat message with the image as base64 so the
    # LLM can reference it via multimodal vision on future conversation turns.
    if file_ext in ("jpg", "jpeg", "png", "tiff"):
        import base64
        try:
            from PIL import Image
            import io

            img = Image.open(io.BytesIO(content))
            # Resize to max 1280px for efficient storage + vision API usage
            max_dim = 1280
            if max(img.size) > max_dim:
                ratio = max_dim / max(img.size)
                new_size = (int(img.size[0] * ratio), int(img.size[1] * ratio))
                img = img.resize(new_size, Image.LANCZOS)
            # Convert to JPEG for consistent, compact format
            if img.mode in ("RGBA", "P", "LA"):
                img = img.convert("RGB")
            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=85)
            image_bytes = buf.getvalue()
            image_b64 = base64.b64encode(image_bytes).decode("utf-8")

            await cosmos_service.save_message(
                session_id=session_id,
                user_id=user.user_id,
                role="user",
                content=f"[Uploaded image: {file.filename}]",
                metadata={
                    "image_attachment": {
                        "filename": file.filename,
                        "content_type": "image/jpeg",
                        "base64": image_b64,
                        "width": img.size[0],
                        "height": img.size[1],
                    }
                }
            )
            logger.info(
                f"Saved image message for vision: {file.filename} "
                f"({len(image_b64)} chars base64, {img.size[0]}x{img.size[1]})"
            )
        except Exception as e:
            logger.warning(f"Failed to save image message for vision: {e}")

    if is_image and not chunks_with_embeddings:
        msg = "Image uploaded for visual analysis"
    else:
        msg = f"Document indexed with {len(chunks_with_embeddings)} chunks"
    
    return DocumentUploadResponse(
        document=metadata,
        message=msg
    )


@router.get("/search", response_model=DocumentSearchResponse)
@track_performance("document_search", MetricType.HTTP_REQUEST)
async def search_documents(
    request: Request,
    query: str = Query(..., min_length=1),
    session_id: Optional[str] = None,
    top_k: int = Query(5, ge=1, le=20)
):
    """
    Search documents using semantic similarity.
    Optionally filter to a specific session.
    """
    user = request.state.user
    
    # Generate query embedding
    query_embedding = await embedding_service.generate_embedding(query)
    
    # Search
    results = await search_service.hybrid_search(
        query_text=query,
        query_embedding=query_embedding,
        session_id=session_id,
        user_id=user.user_id,
        top_k=top_k
    )
    
    search_results = [
        DocumentSearchResult(
            id=r["id"],
            title=r["title"],
            content_snippet=r["content"][:500],
            file_type=r["file_type"],
            score=r["score"]
        )
        for r in results
    ]
    
    return DocumentSearchResponse(results=search_results, query=query)


@router.delete("/{document_id}")
async def delete_document(request: Request, document_id: str):
    """Delete a document and all its chunks from the index."""
    user = request.state.user
    
    # Delete all chunks for this document
    # Chunks are named {doc_id}_{chunk_num}
    # We need to search and delete
    await search_service.delete_document(document_id)
    
    logger.info(f"Deleted document {document_id}")
    return {"message": "Document deleted"}


@router.delete("/session/{session_id}")
async def delete_session_documents(request: Request, session_id: str):
    """Delete all documents for a session."""
    user = request.state.user
    
    # Verify session ownership
    session = await cosmos_service.get_session(session_id, user.user_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    
    await search_service.delete_session_documents(session_id)
    
    logger.info(f"Deleted all documents for session {session_id}")
    return {"message": "Session documents deleted"}


@router.get("/{document_id}/content")
@track_performance("document_get_content", MetricType.HTTP_REQUEST)
async def get_document_content(request: Request, document_id: str):
    """
    Get the full content of a document by retrieving and combining all its chunks.
    Returns the document as text/plain for viewing in a new tab.
    
    For image-only uploads (no indexed chunks), serves the image directly from
    the Cosmos DB message that stores the base64 vision attachment.
    
    Note: We don't filter by user_id here since the document_id is a UUID that 
    serves as a capability token. If you have the ID, you can view the content.
    """
    from fastapi.responses import PlainTextResponse, Response
    import base64
    
    logger.info(f"Getting content for document {document_id}")
    
    # Get all chunks for this document (no user filter - document ID is the auth)
    chunks = await search_service.get_document_chunks(document_id)
    
    logger.info(f"Found {len(chunks)} chunks for document {document_id}")
    
    if chunks:
        # Standard text document path: combine chunks
        full_content = "\n".join(chunk["content"] for chunk in chunks)
        title = chunks[0]["title"].split(" (chunk")[0] if chunks else "Document"
        logger.info(f"Retrieved document content {document_id}: {len(chunks)} chunks, {len(full_content)} chars")
        return PlainTextResponse(
            content=full_content,
            headers={"Content-Disposition": f'inline; filename="{title}"'}
        )
    
    # No chunks — check if this is an image-only upload with a vision attachment
    # Look up the session that references this document to find the image message
    try:
        image_msg = await _find_image_message_for_document(document_id)
        if image_msg:
            attachment = image_msg["metadata"]["image_attachment"]
            image_bytes = base64.b64decode(attachment["base64"])
            content_type = attachment.get("content_type", "image/jpeg")
            filename = attachment.get("filename", "image.jpg")
            logger.info(f"Serving image for document {document_id}: {filename}")
            return Response(
                content=image_bytes,
                media_type=content_type,
                headers={"Content-Disposition": f'inline; filename="{filename}"'}
            )
    except Exception as e:
        logger.warning(f"Failed to look up image for document {document_id}: {e}")
    
    logger.warning(f"Document {document_id} not found")
    raise HTTPException(status_code=404, detail="Document not found")


async def _find_image_message_for_document(document_id: str) -> dict | None:
    """
    Search for the Cosmos image message associated with a document ID.
    We find the session that references this document, then look for image
    messages in that session whose filename matches the document title.
    """
    # Query sessions that reference this document ID
    query = """
        SELECT s.id, s.userId, s.documents FROM s
        WHERE ARRAY_CONTAINS(s.documents, {"id": @doc_id}, true)
    """
    params = [{"name": "@doc_id", "value": document_id}]
    
    sessions = list(cosmos_service.sessions_container.query_items(
        query=query,
        parameters=params,
        enable_cross_partition_query=True,
    ))
    
    if not sessions:
        return None
    
    session = sessions[0]
    session_id = session["id"]
    user_id = session["userId"]
    
    # Find the document title we're looking for
    doc_title = None
    for doc in session.get("documents", []):
        if doc["id"] == document_id:
            doc_title = doc.get("title")
            break
    
    # Get image messages for this session
    image_messages = await cosmos_service.get_session_image_messages(session_id, user_id)
    
    # Match by filename
    for msg in image_messages:
        attachment = msg.get("metadata", {}).get("image_attachment", {})
        if attachment.get("filename") == doc_title:
            return msg
    
    # If only one image message and one image doc, match them
    if len(image_messages) == 1:
        return image_messages[0]
    
    return None


@router.get("/grounding/{agent_id}/{file_name:path}")
@track_performance("document_grounding_fetch", MetricType.HTTP_REQUEST)
async def get_grounding_document(request: Request, agent_id: str, file_name: str):
    """
    Fetch and display an original grounding document from Azure Blob Storage.
    
    This proxies the blob content through the backend so users can view
    cited source documents without needing direct blob access or SAS tokens.
    The user must be authenticated (auth middleware applies).
    
    Security: If the blob has an ss_tokens metadata value and the Access Checker
    endpoint is configured, the user's allowed SS tokens are verified before
    serving the document. If the user doesn't have the required token, 403 is returned.
    """
    from fastapi.responses import Response
    
    if not grounding_service.is_available:
        raise HTTPException(status_code=503, detail="Grounding service is not available")
    
    result = await grounding_service.fetch_blob_content(agent_id, file_name)
    if not result:
        raise HTTPException(status_code=404, detail=f"Document '{file_name}' not found in agent's grounding sources")
    
    content, content_type, blob_ss_token = result
    
    # ── SS Token authorization check ──
    # Enforced only when ACCESS_CHECKER_ENDPOINT is configured.
    # If not configured, all documents are served freely (dev/test mode).
    # If configured, documents with an ss_token require the user to hold
    # that token — fail-closed if the checker can't be reached.
    if blob_ss_token and security_token_service.is_available:
        user_token = getattr(request.state, 'token', None)
        if not user_token:
            raise HTTPException(status_code=401, detail="Authentication required to view secured documents")
        
        user_ss_tokens = await security_token_service.get_user_ss_tokens(user_token)
        if user_ss_tokens is None:
            # Access checker call failed — fail-closed for direct document access
            logger.warning(f"Access checker unavailable; denying document access for {file_name}")
            raise HTTPException(status_code=503, detail="Unable to verify document access permissions")
        
        if blob_ss_token not in user_ss_tokens:
            logger.warning(f"User denied access to {file_name}: blob token '{blob_ss_token}' not in user's {len(user_ss_tokens)} tokens")
            raise HTTPException(status_code=403, detail="You do not have permission to view this document")
    
    logger.info(f"Serving grounding document: agent={agent_id}, file={file_name}, size={len(content)}")
    
    return Response(
        content=content,
        media_type=content_type,
        headers={"Content-Disposition": f'inline; filename="{file_name}"'}
    )


# Allowed Azure Blob Storage host suffixes for the blob proxy.
# This prevents the proxy from being abused to fetch arbitrary URLs.
_ALLOWED_BLOB_HOSTS = [
    ".blob.core.windows.net",
    ".blob.core.usgovcloudapi.net",
    ".blob.core.chinacloudapi.cn",
]


@router.get("/blob-proxy")
@track_performance("document_blob_proxy", MetricType.HTTP_REQUEST)
async def proxy_blob_by_url(request: Request, url: str = Query(..., min_length=10)):
    """
    Fetch and display a blob document by its full Azure Blob Storage URL.
    
    Used for documents referenced by MCP tools or other external sources
    that return direct blob URLs.  The backend fetches the blob with managed
    identity so the user never needs direct storage access or SAS tokens.
    
    Security:
    - Only Azure Blob Storage URLs are allowed (validated by host suffix).
    - SS token metadata is checked when ACCESS_CHECKER_ENDPOINT is configured.
    """
    from fastapi.responses import Response
    from urllib.parse import urlparse, unquote
    
    # Validate the URL is an Azure Blob Storage URL
    parsed = urlparse(url)
    hostname = (parsed.hostname or "").lower()
    if not any(hostname.endswith(suffix) for suffix in _ALLOWED_BLOB_HOSTS):
        raise HTTPException(
            status_code=400,
            detail="Only Azure Blob Storage URLs are allowed"
        )
    
    if not grounding_service.is_available:
        raise HTTPException(status_code=503, detail="Grounding service is not available")
    
    result = await grounding_service.fetch_blob_by_url(url)
    if not result:
        raise HTTPException(status_code=404, detail="Blob not found or not accessible")
    
    content, content_type, blob_ss_token = result
    
    # ── SS Token authorization check ──
    # Same model as grounding proxy: enforced only when access checker is configured.
    if blob_ss_token and security_token_service.is_available:
        user_token = getattr(request.state, 'token', None)
        if not user_token:
            raise HTTPException(status_code=401, detail="Authentication required to view secured documents")
        
        user_ss_tokens = await security_token_service.get_user_ss_tokens(user_token)
        if user_ss_tokens is None:
            logger.warning(f"Access checker unavailable; denying blob proxy access for {url}")
            raise HTTPException(status_code=503, detail="Unable to verify document access permissions")
        
        if blob_ss_token not in user_ss_tokens:
            logger.warning(f"User denied blob proxy access: blob token '{blob_ss_token}' not in user's {len(user_ss_tokens)} tokens")
            raise HTTPException(status_code=403, detail="You do not have permission to view this document")
    
    # Extract filename for Content-Disposition
    blob_path = unquote(parsed.path)
    file_name = blob_path.rsplit('/', 1)[-1] if '/' in blob_path else 'document'
    
    logger.info(f"Serving proxied blob: url={url}, size={len(content)}")
    
    return Response(
        content=content,
        media_type=content_type,
        headers={"Content-Disposition": f'inline; filename="{file_name}"'}
    )
