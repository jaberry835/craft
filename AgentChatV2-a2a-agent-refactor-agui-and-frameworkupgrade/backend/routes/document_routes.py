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
from observability import get_logger, track_performance, MetricType

router = APIRouter(prefix="/api/documents", tags=["documents"])
logger = get_logger(__name__)

# Supported file types
ALLOWED_TYPES = {
    "text/plain": "txt",
    "text/markdown": "md",
    "application/pdf": "pdf",
    "application/json": "json",
    "text/csv": "csv"
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
    
    # Decode text content
    try:
        text_content = content.decode("utf-8")
    except UnicodeDecodeError:
        raise HTTPException(status_code=400, detail="File must be valid UTF-8 text")
    
    # Generate document ID
    doc_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc)
    
    # Chunk and embed
    chunks_with_embeddings = await embedding_service.chunk_and_embed(text_content)
    
    # Index each chunk
    for i, (chunk_text, embedding) in enumerate(chunks_with_embeddings):
        chunk_id = f"{doc_id}_{i}"
        await search_service.index_document(
            doc_id=chunk_id,
            session_id=session_id,
            user_id=user.user_id,
            title=f"{file.filename} (chunk {i+1})",
            content=chunk_text,
            file_type=ALLOWED_TYPES[content_type],
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
    
    return DocumentUploadResponse(
        document=metadata,
        message=f"Document indexed with {len(chunks_with_embeddings)} chunks"
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
    
    Note: We don't filter by user_id here since the document_id is a UUID that 
    serves as a capability token. If you have the ID, you can view the content.
    """
    from fastapi.responses import PlainTextResponse
    
    logger.info(f"Getting content for document {document_id}")
    
    # Get all chunks for this document (no user filter - document ID is the auth)
    chunks = await search_service.get_document_chunks(document_id)
    
    logger.info(f"Found {len(chunks)} chunks for document {document_id}")
    
    if not chunks:
        logger.warning(f"Document {document_id} not found")
        raise HTTPException(status_code=404, detail="Document not found")
    
    # Combine chunks in order
    full_content = "\n".join(chunk["content"] for chunk in chunks)
    
    # Get document title from first chunk
    title = chunks[0]["title"].split(" (chunk")[0] if chunks else "Document"
    
    logger.info(f"Retrieved document content {document_id}: {len(chunks)} chunks, {len(full_content)} chars")
    
    return PlainTextResponse(
        content=full_content,
        headers={"Content-Disposition": f'inline; filename="{title}"'}
    )
