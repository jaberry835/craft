"""
Document Tools for Rude MCP Server
Direct integration with Azure AI Search and Azure Blob Storage for document management
"""

import os
import json
import base64
import asyncio
from typing import List, Dict, Any, Optional
import logging
from fastmcp import FastMCP
from urllib.parse import quote

logger = logging.getLogger(__name__)

# Import shared context variables
from context import current_user_id, current_session_id

def get_effective_user_context(user_id: str = None, session_id: str = None) -> tuple[str, str]:
    """Get effective user context from parameters or context variables.
    
    Args:
        user_id: Optional explicit user ID
        session_id: Optional explicit session ID
        
    Returns:
        Tuple of (effective_user_id, effective_session_id)
    """
    try:
        # Try to get from context variables first (set by middleware)
        context_user_id = current_user_id.get()
        context_session_id = current_session_id.get(None)
        
        logger.info(f"🔍 Context variables: user_id={context_user_id}, session_id={context_session_id}")
        
    except LookupError:
        # Context variables not set 
        logger.warning("⚠️ Context variables not available, using defaults")
        context_user_id = 'defaMCPUser'
        context_session_id = None
    
    # Parameters override context variables if provided
    effective_user_id = user_id or context_user_id
    effective_session_id = session_id or context_session_id
    
    logger.info(f"✅ Effective context: user_id={effective_user_id}, session_id={effective_session_id}")
    
    return effective_user_id, effective_session_id

# Azure SDK imports with availability check
try:
    from azure.storage.blob import BlobServiceClient
    from azure.search.documents import SearchClient
    from azure.search.documents.models import VectorizedQuery
    from azure.core.credentials import AzureKeyCredential
    from azure.core.exceptions import ResourceNotFoundError, HttpResponseError
    from openai import AzureOpenAI
    AZURE_AVAILABLE = True
except ImportError as e:
    AZURE_AVAILABLE = False
    logger.warning(f"Azure SDK packages not available: {e}")
    # Fallbacks so references still work if Azure SDK isn't installed
    class ResourceNotFoundError(Exception):
        pass
    class HttpResponseError(Exception):
        pass

class DocumentChunk:
    """Document chunk model for search results."""
    
    def __init__(self, data: dict):
        self.chunk_id = data.get('chunkId', '')
        self.document_id = data.get('documentId', '')
        self.user_id = data.get('userId', '')
        self.session_id = data.get('sessionId', '')
        self.file_name = data.get('fileName', '')
        self.content = data.get('content', '')
        self.chunk_index = data.get('chunkIndex', 0)
        self.uploaded_at = data.get('uploadedAt', '')
        self.score = data.get('score', 0.0)

class DocumentMetadata:
    """Document metadata model."""
    
    def __init__(self, data: dict):
        self.document_id = data.get('documentId', '')
        self.file_name = data.get('fileName', '')
        self.user_id = data.get('userId', '')
        self.session_id = data.get('sessionId', '')
        self.upload_date = data.get('uploadDate', '')
        self.file_size = data.get('fileSize', 0)
        self.status = data.get('status', 'uploaded')
        self.blob_url = data.get('blobUrl', '')
        self.content_type = data.get('contentType', 'application/octet-stream')
    
    def to_dict(self):
        return {
            'documentId': self.document_id,
            'fileName': self.file_name,
            'userId': self.user_id,
            'sessionId': self.session_id,
            'uploadDate': self.upload_date,
            'fileSize': self.file_size,
            'status': self.status,
            'blobUrl': self.blob_url,
            'contentType': self.content_type
        }

def register_document_tools(mcp: FastMCP):
    """Register all document tools with the FastMCP server"""
    
    # Initialize Azure clients
    search_client = None
    blob_service_client = None
    openai_client = None
    
    if AZURE_AVAILABLE:
        # Azure AI Search
        azure_search_endpoint = os.getenv("AZURE_SEARCH_ENDPOINT")
        azure_search_key = os.getenv("AZURE_SEARCH_KEY")
        azure_search_index = os.getenv("AZURE_SEARCH_INDEX_NAME") or os.getenv("AZURE_SEARCH_INDEX") or "documents"

        if azure_search_endpoint and azure_search_key:
            try:
                search_client = SearchClient(
                    azure_search_endpoint,
                    azure_search_index,
                    AzureKeyCredential(azure_search_key)
                )
                logger.info("✅ Azure AI Search client initialized")
            except Exception as e:
                logger.error(f"❌ Failed to initialize Azure AI Search: {e}")
        
        # Azure Blob Storage
        azure_storage_connection = os.getenv("AZURE_STORAGE_CONNECTION_STRING")
        if azure_storage_connection:
            try:
                blob_service_client = BlobServiceClient.from_connection_string(azure_storage_connection)
                logger.info("✅ Azure Blob Storage client initialized")
            except Exception as e:
                logger.error(f"❌ Failed to initialize Azure Blob Storage: {e}")
        
        # Azure OpenAI (for embeddings)
        azure_openai_endpoint = os.getenv("AZURE_OPENAI_ENDPOINT")
        azure_openai_key = os.getenv("AZURE_OPENAI_API_KEY")
        if azure_openai_endpoint and azure_openai_key:
            try:
                openai_client = AzureOpenAI(
                    azure_endpoint=azure_openai_endpoint,
                    api_key=azure_openai_key,
                    api_version="2024-02-01"
                )
                logger.info("✅ Azure OpenAI client initialized")
            except Exception as e:
                logger.error(f"❌ Failed to initialize Azure OpenAI: {e}")
    
    async def _generate_embedding(text: str) -> list:
        """Generate embedding for text using Azure OpenAI."""
        try:
            if not openai_client:
                return None
            
            deployment = os.getenv("AZURE_OPENAI_EMBEDDING_DEPLOYMENT", "text-embedding-ada-002")
            response = openai_client.embeddings.create(
                input=text,
                model=deployment
            )
            return response.data[0].embedding
        except Exception as e:
            logger.error(f"Error generating embedding: {e}")
            return None
    
    @mcp.tool
    def list_documents(limit: int = 50, user_id: str = None, session_id: str = None) -> Dict[str, Any]:
        """List documents for a user/session from Azure AI Search
        
        Args:
            limit: Maximum number of documents to return (default 50)
            user_id: Optional user ID (uses context or default if not provided)
            session_id: Optional session ID (uses context or default if not provided)
            
        Returns:
            Dictionary with list of unique documents and metadata
        """
        try:
            # Get effective user context
            effective_user_id, effective_session_id = get_effective_user_context(user_id, session_id)
            
            if not search_client:
                return {
                    "success": False,
                    "error": "Azure AI Search not configured",
                    "documents": [],
                    "count": 0,
                    "message": "Azure AI Search client not available"
                }
            
            # Build search filters
            filter_parts = [f"userId eq '{effective_user_id}'"]
            if effective_session_id:
                filter_parts.append(f"sessionId eq '{effective_session_id}'")
            
            filter_expression = " and ".join(filter_parts)
            
            logger.info(f"Listing documents for user_id: {effective_user_id}, session_id: {effective_session_id}")
            
            # Search for all documents for this user/session
            search_results = search_client.search(
                search_text="*",
                filter=filter_expression,
                select=["documentId", "fileName", "userId", "sessionId", "uploadedAt"],
                top=1000  # Get many results to deduplicate
            )
            
            # Deduplicate by documentId to get unique documents
            unique_documents = {}
            for result in search_results:
                doc_id = result.get('documentId', '')
                if doc_id not in unique_documents:
                    unique_documents[doc_id] = {
                        'documentId': doc_id,
                        'fileName': result.get('fileName', ''),
                        'userId': result.get('userId', ''),
                        'sessionId': result.get('sessionId', ''),
                        'uploadDate': result.get('uploadedAt', ''),
                        'fileSize': 0,  # Not available in search index
                        'status': 'indexed',
                        'blobUrl': '',  # Not available in search index
                        'contentType': 'unknown'
                    }
            
            # Convert to list and limit
            documents_list = list(unique_documents.values())[:limit]
             
            logger.info(
                f"ListDocuments: returning {len(documents_list)} document(s) "
                f"(limit={limit}) for user_id={effective_user_id}, session_id={effective_session_id}"
            )
            return {
                "success": True,
                "documents": documents_list,
                "count": len(documents_list),
                "message": f"Found {len(documents_list)} documents for user {effective_user_id}"
            }
            
        except Exception as e:
            logger.error(f"Error listing documents: {e}")
            return {
                "success": False,
                "error": str(e),
                "documents": [],
                "count": 0,
                "message": "Error listing documents"
            }
    
    @mcp.tool
    async def search_documents(query: str, limit: int = 10, user_id: str = None, session_id: str = None) -> Dict[str, Any]:
        """Search documents using Azure AI Search with hybrid text and vector search
        
        Args:
            query: Search query string (e.g., file name like "names.txt" or content description)
            limit: Maximum number of results to return (default 10)
            user_id: Optional user ID (uses context or default if not provided)
            session_id: Optional session ID (uses context or default if not provided)
            
        Returns:
            Dictionary with search results containing documentId, fileName, and content snippets
        """
        try:
            # Get effective user context
            effective_user_id, effective_session_id = get_effective_user_context(user_id, session_id)
            
            if not search_client:
                return {
                    "success": False,
                    "error": "Azure AI Search not configured",
                    "results": [],
                    "count": 0,
                    "message": "Azure AI Search client not available"
                }
            
            logger.info(f"Searching documents with query: '{query}', user_id: '{effective_user_id}', session_id: '{effective_session_id}'")
            
            # Validate inputs
            if not query:
                return {
                    "success": False,
                    "error": "Empty search query",
                    "results": [],
                    "count": 0,
                    "message": "Search query cannot be empty"
                }
            
            # Build search filters
            filter_parts = [f"userId eq '{effective_user_id}'"]
            if effective_session_id:
                filter_parts.append(f"sessionId eq '{effective_session_id}'")
            
            filter_expression = " and ".join(filter_parts)
            
            # Generate embedding for the query
            query_embedding = await _generate_embedding(query)
            
            search_kwargs = {
                "search_text": query,
                "filter": filter_expression,
                "top": limit,
                "highlight_fields": "content",
                "select": ["chunkId", "documentId", "userId", "sessionId", "fileName", "content", "chunkIndex", "uploadedAt"]
            }
            
            # Add vector search if embedding is available
            if query_embedding:
                vector_query = VectorizedQuery(
                    vector=query_embedding,
                    k_nearest_neighbors=limit,
                    fields="contentVector"
                )
                search_kwargs["vector_queries"] = [vector_query]
                logger.info("Performing hybrid text + vector search")
            else:
                logger.info("Performing text-only search")
            
            # Perform search
            search_results = search_client.search(**search_kwargs)
            
            results = []
            for result in search_results:
                chunk_data = {
                    'chunkId': result.get('chunkId', ''),
                    'documentId': result.get('documentId', ''),
                    'userId': result.get('userId', ''),
                    'sessionId': result.get('sessionId', ''),
                    'fileName': result.get('fileName', ''),
                    'content': result.get('content', ''),
                    'chunkIndex': result.get('chunkIndex', 0),
                    'uploadedAt': result.get('uploadedAt', ''),
                    'score': getattr(result, '@search.score', 0.0)
                }
                results.append(chunk_data)
            
            logger.info(f"Found {len(results)} search results for query: '{query}'")
            
            return {
                "success": True,
                "query": query,
                "results": results,
                "count": len(results),
                "message": f"Found {len(results)} results for '{query}'"
            }
            
        except Exception as e:
            logger.error(f"Error searching documents: {e}")
            return {
                "success": False,
                "error": str(e),
                "query": query,
                "results": [],
                "count": 0,
                "message": f"Error searching documents: {str(e)}"
            }
    
    @mcp.tool
    async def get_document(document_id: str, user_id: str = None) -> Dict[str, Any]:
        """Get document content from Azure Blob Storage
        
        Args:
            document_id: The ID of the document to retrieve (required)
            user_id: Optional user ID (uses context or default if not provided)
            
        Returns:
            Dictionary with document metadata and base64 encoded content
        """
        try:
            # Get effective user context
            effective_user_id, _ = get_effective_user_context(user_id, None)
            
            if not blob_service_client:
                return {
                    "success": False,
                    "error": "Azure Blob Storage not configured",
                    "message": "Azure Blob Storage client not available"
                }
            
            logger.info(f"Getting document: {document_id} for user: {effective_user_id}")
            
            # First, try to find the document in search to get metadata
            document_info = None
            if search_client:
                try:
                    filter_expr = f"documentId eq '{document_id}' and userId eq '{effective_user_id}'"
                    
                    search_results = search_client.search(
                        search_text="*",
                        filter=filter_expr,
                        select=["documentId", "fileName", "userId", "sessionId"],
                        top=1
                    )
                    
                    for result in search_results:
                        document_info = result
                        break
                except Exception as e:
                    logger.warning(f"Could not find document in search index: {e}")
            
            if not document_info:
                return {
                    "success": False,
                    "error": f"Document not found: {document_id}",
                    "message": "Document not found in search index or access denied"
                }
            
            # Try to construct blob path robustly and handle filenames with spaces or encoding
            container_name = os.getenv("AZURE_STORAGE_CONTAINER_NAME", "documents")

            userId = document_info.get('userId') or ''
            sessId = document_info.get('sessionId') or ''
            file_name = document_info.get('fileName', '') or ''

            # Build the common prefix; skip sessionId if it's empty/None
            path_parts = [userId]
            if sessId:
                path_parts.append(sessId)
            path_parts.append(document_id)
            prefix = "/".join(path_parts)

            # Candidate filename variants to try
            def _filename_candidates(name: str) -> list[str]:
                cands = []
                if name:
                    stripped = name.strip()
                    cands.append(stripped)
                    # URL-encoded (space -> %20)
                    cands.append(quote(stripped, safe="()[]{}!@#$^&-=;.,_+'"))
                    # Replace spaces with underscores (common sanitizer)
                    if " " in stripped:
                        cands.append(stripped.replace(" ", "_"))
                # Return unique in order
                seen = set()
                unique = []
                for c in cands:
                    if c not in seen:
                        seen.add(c)
                        unique.append(c)
                return unique

            candidates = _filename_candidates(file_name)

            # Also allow a fallback by listing blobs under the prefix if direct attempts fail
            last_error: Optional[Exception] = None
            for cand in candidates or [file_name]:
                blob_name = f"{prefix}/{cand}" if cand else prefix
                try:
                    blob_client = blob_service_client.get_blob_client(
                        container=container_name,
                        blob=blob_name
                    )
                    # Faster existence check before download to avoid large exception traces
                    if hasattr(blob_client, "exists") and not blob_client.exists():
                        logger.debug(f"Blob not found (exists()=False), tried: {blob_name}")
                        continue

                    download_stream = blob_client.download_blob()
                    content = download_stream.readall()

                    # Convert to base64
                    content_b64 = base64.b64encode(content).decode('utf-8')

                    return {
                        "success": True,
                        "document_id": document_id,
                        "file_name": document_info.get('fileName', ''),
                        "content": content_b64,
                        "content_type": _get_content_type(document_info.get('fileName', '')),
                        "size": len(content),
                        "message": "Document retrieved successfully (content base64 encoded)"
                    }
                except ResourceNotFoundError as e:
                    logger.debug(f"Blob not found for candidate '{blob_name}': {e}")
                    last_error = e
                    continue
                except HttpResponseError as e:
                    # Some characters may cause URL issues; try other candidates
                    logger.debug(f"HTTP error for candidate '{blob_name}': {e}")
                    last_error = e
                    continue
                except Exception as e:
                    logger.debug(f"Error trying candidate '{blob_name}': {e}")
                    last_error = e
                    continue

            # Fallback: list blobs under the document prefix and pick a best match
            try:
                container_client = blob_service_client.get_container_client(container_name)
                # Ensure trailing slash in prefix for name_starts_with
                list_prefix = prefix + "/"
                matches = list(container_client.list_blobs(name_starts_with=list_prefix))
                if matches:
                    # Prefer exact case-insensitive match on filename ignoring spaces vs underscores
                    def _norm(s: str) -> str:
                        return (s or "").lower().replace("_", " ")

                    best = None
                    for b in matches:
                        # b.name is the full path; extract the last segment
                        last = b.name.split("/")[-1]
                        if _norm(last) == _norm(file_name):
                            best = b
                            break
                    if not best:
                        # Otherwise just take the first blob under the prefix
                        best = matches[0]

                    blob_client = blob_service_client.get_blob_client(
                        container=container_name,
                        blob=best.name
                    )
                    download_stream = blob_client.download_blob()
                    content = download_stream.readall()
                    content_b64 = base64.b64encode(content).decode('utf-8')

                    return {
                        "success": True,
                        "document_id": document_id,
                        "file_name": document_info.get('fileName', ''),
                        "content": content_b64,
                        "content_type": _get_content_type(document_info.get('fileName', '')),
                        "size": len(content),
                        "message": "Document retrieved successfully via prefix fallback (content base64 encoded)"
                    }
                else:
                    logger.error(f"No blobs found under prefix '{list_prefix}'")
            except Exception as e:
                logger.error(f"Error during prefix fallback list/download: {e}")
                last_error = e

            # If we got here, we failed all attempts
            err_msg = str(last_error) if last_error else "Blob not found"
            return {
                "success": False,
                "error": err_msg,
                "message": "Error downloading document from blob storage"
            }
            
        except Exception as e:
            logger.error(f"Error getting document: {e}")
            return {
                "success": False,
                "error": str(e),
                "message": f"Error getting document: {str(e)}"
            }
    
    @mcp.tool
    async def get_document_content_summary(document_id: str, max_length: int = 500, user_id: str = None) -> Dict[str, Any]:
        """Get a summary of document content from search index chunks
        
        Args:
            document_id: The ID of the document (required)
            max_length: Maximum length of content summary (default 500)
            user_id: Optional user ID (uses context or default if not provided)
            
        Returns:
            Dictionary with document content summary
        """
        try:
            # Get effective user context
            effective_user_id, _ = get_effective_user_context(user_id, None)
            
            if not search_client:
                return {
                    "success": False,
                    "error": "Azure AI Search not configured",
                    "message": "Azure AI Search client not available"
                }
            
            logger.info(f"Getting document content summary: {document_id} for user: {effective_user_id}")
            
            # Search for chunks of this document
            filter_expr = f"documentId eq '{document_id}' and userId eq '{effective_user_id}'"
            
            search_results = search_client.search(
                search_text="*",
                filter=filter_expr,
                select=["chunkId", "documentId", "fileName", "content", "chunkIndex", "uploadedAt"],
                top=50  # Get multiple chunks to build summary
            )
            
            chunks = []
            file_name = "unknown"
            upload_date = ""
            
            for result in search_results:
                chunks.append({
                    'content': result.get('content', ''),
                    'chunkIndex': result.get('chunkIndex', 0)
                })
                if not file_name or file_name == "unknown":
                    file_name = result.get('fileName', 'unknown')
                if not upload_date:
                    upload_date = result.get('uploadedAt', '')
            
            if not chunks:
                return {
                    "success": False,
                    "error": f"Document not found: {document_id}",
                    "message": "No content found for document"
                }
            
            # Combine content from chunks to create summary
            combined_content = ""
            total_chars = 0
            
            # Sort chunks by index to maintain order
            chunks.sort(key=lambda x: x['chunkIndex'])
            
            for chunk in chunks:
                chunk_content = chunk['content']
                if total_chars + len(chunk_content) <= max_length:
                    if combined_content:
                        combined_content += "\n\n"
                    combined_content += chunk_content
                    total_chars += len(chunk_content)
                else:
                    # Add partial content if we have space
                    remaining_space = max_length - total_chars
                    if remaining_space > 50:  # Only add if meaningful space left
                        if combined_content:
                            combined_content += "\n\n"
                        combined_content += chunk_content[:remaining_space] + "..."
                    break
            
            return {
                "success": True,
                "document_id": document_id,
                "file_name": file_name,
                "content_type": _get_content_type(file_name),
                "chunk_count": len(chunks),
                "summary": combined_content,
                "is_text": True,
                "upload_date": upload_date,
                "message": f"Document content summary retrieved from {len(chunks)} chunks"
            }
            
        except Exception as e:
            logger.error(f"Error getting document content summary: {e}")
            return {
                "success": False,
                "error": str(e),
                "message": f"Error getting document content summary: {str(e)}"
            }
    
    # Log successful registration
    logger.info("📄 Document tools registered successfully - List, Search, Get, Summary tools available")

def _get_content_type(file_name: str) -> str:
    """Determine content type based on file extension."""
    file_ext = os.path.splitext(file_name)[1].lower()
    content_type_map = {
        '.pdf': 'application/pdf',
        '.doc': 'application/msword',
        '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '.txt': 'text/plain',
        '.md': 'text/markdown',
        '.json': 'application/json',
        '.xml': 'application/xml',
        '.html': 'text/html',
        '.htm': 'text/html',
        '.csv': 'text/csv',
        '.xls': 'application/vnd.ms-excel',
        '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '.ppt': 'application/vnd.ms-powerpoint',
        '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    }
    return content_type_map.get(file_ext, 'application/octet-stream')
