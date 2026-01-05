"""
Azure Document Service for handling document upload, processing, and search.
Integrates with Azure Blob Storage, Azure AI Search, Azure Document Intelligence, and Azure OpenAI.
"""

# Apply early logging suppressions before any Azure imports
try:
    from ..utils.early_logging_config import apply_early_logging_suppressions
    apply_early_logging_suppressions()
except ImportError:
    from utils.early_logging_config import apply_early_logging_suppressions
    apply_early_logging_suppressions()

import os
import uuid
import json
import asyncio
import base64
import tempfile
import logging
from datetime import datetime, timezone
from typing import List, Dict, Any, Optional, Tuple
from io import BytesIO
from urllib.parse import quote, unquote, urlparse

# Use relative imports since this is within the src package
try:
    from ..config.settings import settings
    from ..utils.logging import get_logger
    from ..services.cosmos_client import cosmos_client
except ImportError:
    # Fallback to absolute imports
    from src.config.settings import settings
    from src.utils.logging import get_logger
    from src.services.cosmos_client import cosmos_client

# Azure imports with availability check
try:
    from azure.storage.blob import BlobServiceClient, BlobClient
    from azure.ai.formrecognizer import DocumentAnalysisClient
    from openai import AzureOpenAI
    from azure.search.documents import SearchClient
    from azure.search.documents.indexes import SearchIndexClient
    from azure.search.documents.indexes.models import (
        SearchIndex, SearchField, SimpleField, SearchableField,
        SearchFieldDataType, VectorSearch, VectorSearchProfile, HnswAlgorithmConfiguration
    )
    from azure.search.documents.models import VectorizedQuery
    from azure.core.credentials import AzureKeyCredential
    AZURE_AVAILABLE = True
except ImportError as e:
    AZURE_AVAILABLE = False
    print(f"Azure SDK packages not available: {e}")

logger = get_logger(__name__)


class DocumentMetadata:
    """Document metadata model."""
    
    def __init__(self, data: dict):
        self.document_id = data.get('documentId', '')
        self.file_name = data.get('fileName', '')
        self.user_id = data.get('userId', '')
        self.session_id = data.get('sessionId', '')
        self.upload_date = data.get('uploadDate', datetime.now(timezone.utc).isoformat())
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


class DocumentChunk:
    """Document chunk model for search indexing."""
    
    def __init__(self, data: dict):
        self.chunk_id = data.get('chunkId', '')
        self.document_id = data.get('documentId', '')
        self.user_id = data.get('userId', '')
        self.session_id = data.get('sessionId', '')
        self.file_name = data.get('fileName', '')
        self.content = data.get('content', '')
        self.chunk_index = data.get('chunkIndex', 0)
        self.uploaded_at = data.get('uploadedAt', datetime.now(timezone.utc).isoformat())
        self.score = data.get('score', 0.0)
        self.embedding = data.get('embedding', None)
    
    def to_dict(self):
        return {
            'chunkId': self.chunk_id,
            'documentId': self.document_id,
            'userId': self.user_id,
            'sessionId': self.session_id,
            'fileName': self.file_name,
            'content': self.content,
            'chunkIndex': self.chunk_index,
            'uploadedAt': self.uploaded_at,
            'score': self.score
        }
    
    def to_search_document(self):
        """Convert to Azure Search document format."""
        return {
            'chunkId': self.chunk_id,
            'documentId': self.document_id,
            'userId': self.user_id,
            'sessionId': self.session_id,
            'fileName': self.file_name,
            'content': self.content,
            'chunkIndex': self.chunk_index,
            'uploadedAt': self.uploaded_at,
            'contentVector': self.embedding
        }


class DocumentProcessingResult:
    """Result of document processing operation."""
    
    def __init__(self, document_id: str, success: bool = True, chunk_count: int = 0, 
                 extracted_text: str = '', error_message: str = None):
        self.document_id = document_id
        self.success = success
        self.chunk_count = chunk_count
        self.extracted_text = extracted_text
        self.error_message = error_message
    
    def to_dict(self):
        return {
            'documentId': self.document_id,
            'success': self.success,
            'chunkCount': self.chunk_count,
            'extractedText': self.extracted_text,
            'errorMessage': self.error_message
        }


class DocumentService:
    """Azure Document Service for handling document upload, processing, and search."""
    
    def __init__(self):
        # Initialize logger
        self.logger = get_logger(__name__)
        
        self.cosmos_client = cosmos_client
        
        # Initialize Azure clients
        self.blob_service_client = None
        self.document_analysis_client = None
        self.openai_client = None
        self.search_client = None
        self.search_index_client = None
        
        if not AZURE_AVAILABLE:
            logger.warning("Azure SDK not available. Document upload features will be limited.")
            return
        
        self._initialize_azure_clients()
    
    def _initialize_azure_clients(self):
        """Initialize Azure service clients."""
        try:
            # Azure Storage
            if settings.azure.azure_storage_connection_string and '[' not in settings.azure.azure_storage_connection_string:
                try:
                    self.blob_service_client = BlobServiceClient.from_connection_string(
                        settings.azure.azure_storage_connection_string
                    )
                    logger.info("✅ Azure Blob Storage client initialized successfully")
                except Exception as e:
                    logger.error(f"❌ Failed to initialize Azure Blob Storage client: {e}")
                    self.blob_service_client = None
            else:
                logger.warning("❌ Azure Storage not configured properly")
            
            # Azure Document Intelligence
            if (settings.azure.document_intelligence_endpoint and 
                settings.azure.document_intelligence_key and
                '[' not in settings.azure.document_intelligence_endpoint and 
                '[' not in settings.azure.document_intelligence_key):
                try:
                    self.document_analysis_client = DocumentAnalysisClient(
                        settings.azure.document_intelligence_endpoint, 
                        AzureKeyCredential(settings.azure.document_intelligence_key)
                    )
                    logger.info("✅ Azure Document Intelligence client initialized")
                except Exception as e:
                    logger.error(f"❌ Failed to initialize Azure Document Intelligence: {e}")
            else:
                logger.warning("Azure Document Intelligence not configured")
            
            # Azure OpenAI
            if (settings.azure.azure_openai_endpoint and 
                settings.azure.azure_openai_api_key and
                '[' not in settings.azure.azure_openai_endpoint and 
                '[' not in settings.azure.azure_openai_api_key):
                try:
                    self.openai_client = AzureOpenAI(
                        azure_endpoint=settings.azure.azure_openai_endpoint,
                        api_key=settings.azure.azure_openai_api_key,
                        api_version=settings.azure.azure_openai_api_version or "2024-02-01"
                    )
                    logger.info("✅ Azure OpenAI client initialized")
                except Exception as e:
                    logger.error(f"❌ Failed to initialize Azure OpenAI: {e}")
            else:
                logger.warning("Azure OpenAI not configured")
            
            # Azure AI Search
            if (settings.azure.azure_search_endpoint and 
                settings.azure.azure_search_key and
                '[' not in settings.azure.azure_search_endpoint and 
                '[' not in settings.azure.azure_search_key):
                try:
                    self.search_index_client = SearchIndexClient(
                        settings.azure.azure_search_endpoint, 
                        AzureKeyCredential(settings.azure.azure_search_key)
                    )
                    index_name = settings.azure.azure_search_index_name or 'documents'
                    self.search_client = SearchClient(                        settings.azure.azure_search_endpoint, 
                        index_name,
                        AzureKeyCredential(settings.azure.azure_search_key)
                    )
                    logger.info("✅ Azure AI Search client initialized")
                    
                    # Initialize search index
                    self._ensure_search_index()
                except Exception as e:
                    logger.error(f"❌ Failed to initialize Azure AI Search: {e}")
            else:
                logger.warning("Azure AI Search not configured")
        
        except Exception as e:
            logger.error(f"Error initializing Azure clients: {e}")
    
    def _ensure_search_index(self):
        """Ensure the search index exists with proper schema."""
        try:
            if not self.search_index_client:
                return
            
            index_name = settings.azure.azure_search_index_name or 'documents'
            
            # Create vector search configuration
            vector_search = VectorSearch(
                profiles=[
                    VectorSearchProfile(
                        name="default-vector-profile",
                        algorithm_configuration_name="default-hnsw-algorithm"
                    )
                ],
                algorithms=[
                    HnswAlgorithmConfiguration(
                        name="default-hnsw-algorithm"
                    )
                ]
            )
            
            fields = [
                SimpleField(name="chunkId", type=SearchFieldDataType.String, key=True),
                SearchableField(name="documentId", type=SearchFieldDataType.String, filterable=True),
                SearchableField(name="userId", type=SearchFieldDataType.String, filterable=True),
                SearchableField(name="sessionId", type=SearchFieldDataType.String, filterable=True),
                SearchableField(name="fileName", type=SearchFieldDataType.String),
                SearchableField(name="content", type=SearchFieldDataType.String),
                SimpleField(name="chunkIndex", type=SearchFieldDataType.Int32),
                SimpleField(name="uploadedAt", type=SearchFieldDataType.DateTimeOffset),
                SearchField(
                    name="contentVector",
                    type=SearchFieldDataType.Collection(SearchFieldDataType.Single),
                    vector_search_dimensions=1536,
                    vector_search_profile_name="default-vector-profile"
                )
            ]
            
            definition = SearchIndex(
                name=index_name,
                fields=fields,
                vector_search=vector_search
            )
            
            self.search_index_client.create_or_update_index(definition)
            logger.info(f"Search index '{index_name}' created/updated successfully with vector search")
        
        except Exception as e:
            logger.error(f"Error creating search index: {e}")
    
    async def upload_document(self, file_stream, file_name: str, user_id: str, session_id: str) -> Dict[str, Any]:
        """Upload a document to Azure Blob Storage and save metadata."""
        try:
            document_id = str(uuid.uuid4())
            blob_url = ""
            
            logger.info(f"Starting document upload: {file_name} for user {user_id}, session {session_id}")
            
            # Get file size and content type
            file_stream.seek(0, 2)  # Seek to end
            file_size = file_stream.tell()
            file_stream.seek(0)  # Reset position
            
            # Determine content type
            content_type = self._get_content_type(file_name)
            
            # Upload to Azure Blob Storage
            if self.blob_service_client:
                container_name = settings.azure.azure_storage_container_name or 'documents'
                container_client = self.blob_service_client.get_container_client(container_name)
                
                # Create container if it doesn't exist
                try:
                    container_client.create_container()
                except Exception:
                    pass  # Container already exists
                
                blob_name = f"{user_id}/{session_id}/{document_id}/{quote(file_name, safe='')}"
                blob_client = container_client.get_blob_client(blob_name)
                
                # Upload file
                file_stream.seek(0)
                blob_client.upload_blob(file_stream, overwrite=True, content_type=content_type)
                blob_url = blob_client.url
                
                logger.info(f"Document uploaded to blob storage: {blob_url}")
            else:
                logger.warning("No blob service client available - skipping blob upload")
                return {
                    "success": False,
                    "error": "Azure Blob Storage not configured",
                    "message": "Cannot upload document without blob storage configuration"
                }
            
            # Store document metadata in Cosmos DB session
            document_metadata = {
                'documentId': document_id,
                'fileName': file_name,
                'fileSize': file_size,
                'blobUrl': blob_url,
                'contentType': content_type,
                'uploadDate': datetime.now(timezone.utc).isoformat(),
                'status': 0  # Uploaded status
            }
            
            if self.cosmos_client.is_available():
                await self._add_document_to_session(user_id, session_id, document_metadata)
            else:
                logger.warning("No Cosmos DB available - skipping metadata storage")
                return {
                    "success": False,
                    "error": "Cosmos DB not configured",
                    "message": "Cannot store document metadata without Cosmos DB"
                }
            
            logger.info(f"Document uploaded successfully: {document_id}")
            return {
                "success": True,
                "document_id": document_id,
                "blob_url": blob_url,
                "file_size": file_size,
                "content_type": content_type,
                "message": "Document uploaded successfully"
            }
        
        except Exception as e:
            logger.error(f"Error uploading document: {e}")
            return {
                "success": False,
                "error": str(e),
                "message": "Error uploading document"
            }
    
    async def _add_document_to_session(self, user_id: str, session_id: str, document_metadata: dict):
        """Add document metadata to session in Cosmos DB."""
        try:
            # Get current session
            session_doc = self.cosmos_client.sessions_container.read_item(
                item=session_id, 
                partition_key=user_id
            )
            
            # Add document to session's documents array
            if 'documents' not in session_doc:
                session_doc['documents'] = []
            
            session_doc['documents'].append(document_metadata)
            
            # Save back to Cosmos DB
            self.cosmos_client.sessions_container.replace_item(
                item=session_id, 
                body=session_doc
            )
            
            logger.info(f"Added document {document_metadata['documentId']} to session {session_id}")
        
        except Exception as e:
            logger.error(f"Error adding document to session: {e}")
            raise
    
    async def process_document(self, document_id: str, user_id: str = None, session_id: str = None) -> Dict[str, Any]:
        """Process document: extract text, chunk, generate embeddings, and index."""
        try:
            # Find document in Cosmos DB
            document_context = await self._find_document_with_context(document_id, session_id)
            if not document_context:
                return {
                    "success": False,
                    "error": f"Document not found: {document_id}",
                    "message": "Document not found"
                }
            
            document_metadata, doc_user_id, doc_session_id = document_context
            
            # Verify user access if provided
            if user_id and doc_user_id != user_id:
                return {
                    "success": False,
                    "error": "Access denied",
                    "message": "User does not have access to this document"
                }
            
            blob_url = document_metadata.get('blobUrl', '')
            
            logger.info(f"Processing document {document_id} with blob URL: {blob_url}")
            
            # Update status to processing
            await self._update_document_status(doc_user_id, document_id, 1)  # Processing
            
            # Extract text
            extracted_text = await self._extract_text(blob_url, document_metadata.get('fileName', ''))
            
            if not extracted_text:
                await self._update_document_status(doc_user_id, document_id, 5)  # Failed
                return {
                    "success": False,
                    "error": "No text could be extracted from document",
                    "message": "Text extraction failed"
                }
            
            # Create document metadata object
            doc_meta = DocumentMetadata({
                'documentId': document_id,
                'fileName': document_metadata.get('fileName', ''),
                'userId': doc_user_id,
                'sessionId': doc_session_id,
                'uploadDate': document_metadata.get('uploadDate', datetime.now(timezone.utc).isoformat()),
                'fileSize': document_metadata.get('fileSize', 0),
                'status': 'processing',
                'blobUrl': blob_url
            })
            
            # Chunk the text
            chunks = self._chunk_text(extracted_text, document_id, doc_meta)
            
            logger.info(f"Document processing - ExtractedText length: {len(extracted_text)}, Chunks generated: {len(chunks)}")
            
            # Generate embeddings and index
            if self.openai_client and self.search_client:
                await self._index_chunks(chunks)
            else:
                logger.warning("OpenAI or Search not configured, chunks will not be indexed for vector search")
            
            # Update status to processed
            await self._update_document_status(doc_user_id, document_id, 2)  # Processed
            
            logger.info(f"Document processed successfully: {document_id}, Chunks: {len(chunks)}")
            
            return {
                "success": True,
                "document_id": document_id,
                "chunk_count": len(chunks),
                "extracted_text_length": len(extracted_text),
                "message": f"Document processed successfully with {len(chunks)} chunks"
            }
        
        except Exception as e:
            logger.error(f"Error processing document {document_id}: {e}")
            
            # Try to update status to failed
            try:
                document_context = await self._find_document_with_context(document_id)
                if document_context:
                    _, user_id, _ = document_context
                    await self._update_document_status(user_id, document_id, 5)  # Failed
            except Exception:
                pass
            
            return {
                "success": False,
                "error": str(e),
                "message": "Error processing document"
            }
    
    async def _extract_text(self, blob_url: str, file_name: str) -> str:
        """Extract text from document using Azure Document Intelligence or direct blob read."""
        extracted_text = ""
        
        # Try Azure Document Intelligence first
        if self.document_analysis_client and blob_url:
            try:
                logger.info("Using Azure Document Intelligence for text extraction")
                poller = self.document_analysis_client.begin_analyze_document_from_url(
                    "prebuilt-document", blob_url)
                result = poller.result()
                
                text_parts = []
                for page in result.pages:
                    for line in page.lines:
                        text_parts.append(line.content)
                
                extracted_text = '\n'.join(text_parts)
                logger.info(f"Document Intelligence extracted {len(extracted_text)} characters")
                
            except Exception as e:
                logger.warning(f"Document Intelligence failed: {e}")
        
        # If Document Intelligence failed, try direct blob read for text files
        if not extracted_text and self.blob_service_client and blob_url:
            try:
                logger.info("Reading text directly from blob storage")
                
                # Parse blob URL to get container and blob name
                parsed_url = urlparse(blob_url)
                path_parts = parsed_url.path.strip('/').split('/', 1)
                
                if len(path_parts) >= 2:
                    container_name = path_parts[0]
                    blob_name = unquote(path_parts[1])
                    
                    blob_client = self.blob_service_client.get_blob_client(
                        container=container_name, blob=blob_name)
                    
                    download_stream = blob_client.download_blob()
                    content = download_stream.readall()
                    
                    # Try to decode as UTF-8
                    try:
                        extracted_text = content.decode('utf-8')
                        logger.info(f"Read {len(extracted_text)} characters from blob storage")
                    except UnicodeDecodeError:
                        # Try other encodings
                        for encoding in ['latin1', 'cp1252', 'iso-8859-1']:
                            try:
                                extracted_text = content.decode(encoding)
                                logger.info(f"Read {len(extracted_text)} characters using {encoding} encoding")
                                break
                            except UnicodeDecodeError:
                                continue
                
            except Exception as e:
                logger.warning(f"Failed to read from blob: {e}")
        
        return extracted_text
    
    def _chunk_text(self, text: str, document_id: str, metadata: DocumentMetadata) -> List[DocumentChunk]:
        """Chunk text into smaller pieces for vector search."""
        if not text:
            return []
        
        # Simple chunking strategy - split by paragraphs and limit size
        max_chunk_size = 1000
        overlap = 100
        
        paragraphs = text.split('\n\n')
        chunks = []
        current_chunk = ""
        chunk_index = 0
        
        for paragraph in paragraphs:
            if len(current_chunk) + len(paragraph) + 2 <= max_chunk_size:
                if current_chunk:
                    current_chunk += "\n\n"
                current_chunk += paragraph
            else:
                if current_chunk:
                    chunks.append(self._create_chunk(current_chunk, document_id, metadata, chunk_index))
                    chunk_index += 1
                
                # Start new chunk, potentially with overlap
                if len(paragraph) <= max_chunk_size:
                    current_chunk = paragraph
                else:
                    # Split large paragraph
                    words = paragraph.split()
                    current_chunk = ""
                    for word in words:
                        if len(current_chunk) + len(word) + 1 <= max_chunk_size:
                            if current_chunk:
                                current_chunk += " "
                            current_chunk += word
                        else:
                            if current_chunk:
                                chunks.append(self._create_chunk(current_chunk, document_id, metadata, chunk_index))
                                chunk_index += 1
                            current_chunk = word
        
        # Add final chunk
        if current_chunk:
            chunks.append(self._create_chunk(current_chunk, document_id, metadata, chunk_index))
        
        return chunks
    
    def _create_chunk(self, content: str, document_id: str, metadata: DocumentMetadata, chunk_index: int) -> DocumentChunk:
        """Create a document chunk."""
        return DocumentChunk({
            'chunkId': f"{document_id}_{chunk_index}",
            'documentId': document_id,
            'userId': metadata.user_id,
            'sessionId': metadata.session_id,
            'fileName': metadata.file_name,
            'content': content,
            'chunkIndex': chunk_index,
            'uploadedAt': metadata.upload_date
        })
    
    async def _generate_embedding(self, text: str) -> list:
        """Generate embedding for text using Azure OpenAI."""
        try:
            if not self.openai_client:
                return None
            
            # Use the embedding model
            deployment = settings.azure.azure_openai_embedding_deployment or "text-embedding-ada-002"
            response = self.openai_client.embeddings.create(
                input=text,
                model=deployment
            )
            
            return response.data[0].embedding
        
        except Exception as e:
            logger.error(f"Error generating embedding: {e}")
            return None
    
    async def _index_chunks(self, chunks: List[DocumentChunk]):
        """Index chunks in Azure AI Search with vector embeddings."""
        try:
            if not self.search_client:
                return
            
            search_documents = []
            
            for chunk in chunks:
                # Generate embedding for the chunk content
                embedding = await self._generate_embedding(chunk.content)
                
                search_doc = {
                    'chunkId': chunk.chunk_id,
                    'documentId': chunk.document_id,
                    'userId': chunk.user_id,
                    'sessionId': chunk.session_id,
                    'fileName': chunk.file_name,
                    'content': chunk.content,
                    'chunkIndex': chunk.chunk_index,
                    'uploadedAt': chunk.uploaded_at
                }
                
                # Add embedding if available
                if embedding:
                    search_doc['contentVector'] = embedding
                
                search_documents.append(search_doc)
            
            if search_documents:
                result = self.search_client.upload_documents(documents=search_documents)
                logger.info(f"Indexed {len(search_documents)} chunks in Azure AI Search with embeddings")
            
        except Exception as e:
            logger.error(f"Error indexing chunks: {e}")
    
    async def search_documents(self, query: str, user_id: str, session_id: str = None, max_results: int = 5) -> Dict[str, Any]:
        """Search documents using Azure AI Search with hybrid text and vector search.
        
        Args:
            query: The search query string
            user_id: User ID to filter documents by (required)
            session_id: Optional session ID to further filter documents
            max_results: Maximum number of results to return
        
        Returns:
            Dict with search results containing success status, results array, count and message
        """
        try:
            self.logger.info(f"🔍 DOCUMENT SERVICE: Searching for '{query}' - User: '{user_id}', Session: '{session_id}'")
            
            # Validate inputs
            if not query:
                self.logger.error("❌ Empty search query provided")
                return {
                    "success": False,
                    "error": "Empty search query",
                    "results": [],
                    "count": 0,
                    "message": "Search query cannot be empty"
                }
                
            if not user_id:
                self.logger.error("❌ No user_id provided for document search")
                return {
                    "success": False,
                    "error": "Missing user_id",
                    "results": [],
                    "count": 0,
                    "message": "User ID is required for document search"
                }
            
            if not self.search_client:
                self.logger.error("❌ Search client not available")
                return {
                    "success": False,
                    "error": "Search client not available",
                    "results": [],
                    "count": 0,
                    "message": "Azure AI Search not configured"
                }
            
            # Build search filters
            filter_parts = [f"userId eq '{user_id}'"]
            if session_id:
                filter_parts.append(f"sessionId eq '{session_id}'")
            
            filter_expression = " and ".join(filter_parts)
            
            # Generate embedding for the query
            query_embedding = await self._generate_embedding(query)
            
            search_kwargs = {
                "search_text": query,
                "filter": filter_expression,
                "top": max_results,
                "highlight_fields": "content",
                "select": ["chunkId", "documentId", "userId", "sessionId", "fileName", "content", "chunkIndex", "uploadedAt"]
            }
            
            # Add vector search if embedding is available
            if query_embedding:
                vector_query = VectorizedQuery(
                    vector=query_embedding,
                    k_nearest_neighbors=max_results,
                    fields="contentVector"
                )
                search_kwargs["vector_queries"] = [vector_query]
                self.logger.info("Performing hybrid text + vector search")
            else:
                self.logger.info("Performing text-only search")
            
            # Perform search
            self.logger.info(f"🔍 DOCUMENT SERVICE: Executing search with filter: '{filter_expression}'")
            search_results = self.search_client.search(**search_kwargs)
            
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
            
            self.logger.info(f"� DOCUMENT SERVICE: Found {len(results)} search results for query: '{query}', user_id: '{user_id}'")
            
            # Log details about each result to help debug
            for i, result in enumerate(results[:3]):  # Log first 3 results
                self.logger.info(f"  Result {i+1}: documentId='{result.get('documentId')}', fileName='{result.get('fileName')}', score={result.get('score'):.2f}")
                content_preview = result.get('content', '')[:50].replace('\n', ' ')
                self.logger.info(f"  Content preview: '{content_preview}...'")
            
            return {
                "success": True,
                "query": query,
                "results": results,
                "count": len(results),
                "message": f"Found {len(results)} results"
            }
            
        except Exception as e:
            self.logger.error(f"❌ Error searching documents: {e}")
            import traceback
            self.logger.error(f"❌ Traceback: {traceback.format_exc()}")
            return {
                "success": False,
                "error": str(e),
                "query": query,
                "results": [],
                "count": 0,
                "message": "Error searching documents"
            }
    
    async def get_user_documents(self, user_id: str, session_id: str = None) -> Dict[str, Any]:
        """Get documents for a user/session."""
        try:
            documents = []
            
            if not self.cosmos_client.is_available():
                return {
                    "success": False,
                    "error": "Cosmos DB not available",
                    "documents": [],
                    "count": 0,
                    "message": "Cannot retrieve documents without Cosmos DB"
                }
            
            if session_id:
                # Get documents for specific session
                try:
                    session_doc = self.cosmos_client.sessions_container.read_item(
                        item=session_id, 
                        partition_key=user_id
                    )
                    session_documents = session_doc.get('documents', [])
                    
                    for doc_data in session_documents:
                        # Ensure we're always working with DocumentMetadata objects
                        if isinstance(doc_data, dict):
                            documents.append(DocumentMetadata(doc_data).to_dict())
                        elif hasattr(doc_data, 'to_dict'):
                            documents.append(doc_data.to_dict())
                        else:
                            logger.warning(f"Unexpected document data type: {type(doc_data)}")
                            # Skip this document
                
                except Exception as e:
                    logger.warning(f"Session not found: {session_id}")
                    return {
                        "success": False,
                        "error": f"Session not found: {session_id}",
                        "documents": [],
                        "count": 0,
                        "message": "Session not found"
                    }
            else:
                # Get documents across all user sessions
                query = "SELECT * FROM c WHERE c.userId = @userId"
                parameters = [{"name": "@userId", "value": user_id}]
                
                items = list(self.cosmos_client.sessions_container.query_items(
                    query=query,
                    parameters=parameters,
                    partition_key=user_id
                ))
                
                for session in items:
                    session_documents = session.get('documents', [])
                    for doc_data in session_documents:
                        # Ensure we're always working with DocumentMetadata objects
                        if isinstance(doc_data, dict):
                            documents.append(DocumentMetadata(doc_data).to_dict())
                        elif hasattr(doc_data, 'to_dict'):
                            documents.append(doc_data.to_dict())
                        else:
                            logger.warning(f"Unexpected document data type: {type(doc_data)}")
                            # Skip this document
            
            return {
                "success": True,
                "documents": documents,
                "count": len(documents),
                "message": f"Found {len(documents)} documents"
            }
        
        except Exception as e:
            logger.error(f"Error getting user documents: {e}")
            return {
                "success": False,
                "error": str(e),
                "documents": [],
                "count": 0,
                "message": "Error retrieving documents"
            }
    
    async def _find_document_with_context(self, document_id: str, session_id: str = None) -> Optional[Tuple[dict, str, str]]:
        """Find document metadata with user and session context."""
        try:
            if not self.cosmos_client.is_available():
                return None
            
            # Use a query to find the document
            query = """
            SELECT * FROM c 
            WHERE EXISTS(
                SELECT VALUE d 
                FROM d IN c.documents 
                WHERE d.documentId = @documentId
            )
            """
            parameters = [{"name": "@documentId", "value": document_id}]
            
            try:
                items = list(self.cosmos_client.sessions_container.query_items(
                    query=query,
                    parameters=parameters,
                    enable_cross_partition_query=True
                ))
                
                for session in items:
                    documents = session.get('documents', [])
                    for doc in documents:
                        if doc.get('documentId') == document_id:
                            doc_session_id = session.get('id', '')
                            
                            # If session_id is provided, verify document belongs to that session
                            if session_id and doc_session_id != session_id:
                                logger.warning(f"Session isolation violation: Document {document_id} belongs to session {doc_session_id}, not {session_id}")
                                return None
                            
                            logger.info(f"Found document {document_id} with blob URL: {doc.get('blobUrl', '')}")
                            return doc, session.get('userId', ''), doc_session_id
                
            except Exception as query_error:
                logger.warning(f"Query failed, falling back to scan all sessions: {query_error}")
                # Fallback: scan all sessions
                items = list(self.cosmos_client.sessions_container.read_all_items())
                for session in items:
                    documents = session.get('documents', [])
                    for doc in documents:
                        if doc.get('documentId') == document_id:
                            doc_session_id = session.get('id', '')
                            
                            if session_id and doc_session_id != session_id:
                                logger.warning(f"Session isolation violation (fallback): Document {document_id} belongs to session {doc_session_id}, not {session_id}")
                                return None
                                
                            logger.info(f"Found document {document_id} (fallback) with blob URL: {doc.get('blobUrl', '')}")
                            return doc, session.get('userId', ''), doc_session_id
            
            logger.warning(f"Document {document_id} not found in any session")
            return None
        
        except Exception as e:
            logger.error(f"Error finding document context: {e}")
            return None
    
    async def _update_document_status(self, user_id: str, document_id: str, status: int):
        """Update document status in Cosmos DB."""
        try:
            if not self.cosmos_client.is_available():
                return
            
            # Find the session containing this document
            document_context = await self._find_document_with_context(document_id)
            if not document_context:
                return
            
            _, _, session_id = document_context
            
            # Update the document status
            session_doc = self.cosmos_client.sessions_container.read_item(
                item=session_id, 
                partition_key=user_id
            )
            documents = session_doc.get('documents', [])
            
            for doc in documents:
                if doc.get('documentId') == document_id:
                    doc['status'] = status
                    break
            
            # Save back to Cosmos DB
            self.cosmos_client.sessions_container.replace_item(
                item=session_id, 
                body=session_doc
            )
            
            logger.info(f"Updated document {document_id} status to {status}")
        
        except Exception as e:
            logger.error(f"Error updating document status: {e}")
    
    async def download_document(self, document_id: str, user_id: str = None) -> Dict[str, Any]:
        """Download a document from Azure Blob Storage."""
        try:
            # Find document metadata
            document_context = await self._find_document_with_context(document_id)
            if not document_context:
                return {
                    "success": False,
                    "error": f"Document not found: {document_id}",
                    "message": "Document not found"
                }
            
            document_metadata, doc_user_id, session_id = document_context
            
            # Verify user has access to this document
            if user_id and doc_user_id != user_id:
                return {
                    "success": False,
                    "error": "Access denied to document",
                    "message": "User does not have access to this document"
                }
            
            blob_url = document_metadata.get('blobUrl', '')
            file_name = document_metadata.get('fileName', 'document')
            
            if not blob_url or not self.blob_service_client:
                return {
                    "success": False,
                    "error": "Document not available for download",
                    "message": "Document blob URL not found or blob storage not configured"
                }
            
            # Parse blob URL to get container and blob name
            parsed_url = urlparse(blob_url)
            path_parts = parsed_url.path.strip('/').split('/', 1)
            
            if len(path_parts) >= 2:
                container_name = path_parts[0]
                blob_name = unquote(path_parts[1])
                
                blob_client = self.blob_service_client.get_blob_client(
                    container=container_name, blob=blob_name)
                
                # Download blob content
                download_stream = blob_client.download_blob()
                content = download_stream.readall()
                
                # Convert to base64 for JSON serialization
                content_b64 = base64.b64encode(content).decode('utf-8')
                
                # Determine content type
                content_type = document_metadata.get('contentType') or self._get_content_type(file_name)
                
                logger.info(f"Downloaded document {document_id}: {file_name} ({len(content)} bytes)")
                return {
                    "success": True,
                    "document_id": document_id,
                    "file_name": file_name,
                    "content": content_b64,
                    "content_type": content_type,
                    "size": len(content),
                    "message": "Document downloaded successfully (content base64 encoded)"
                }
            else:
                return {
                    "success": False,
                    "error": "Invalid blob URL format",
                    "message": "Document blob URL is invalid"
                }
        
        except Exception as e:
            logger.error(f"Error downloading document {document_id}: {e}")
            return {
                "success": False,
                "error": str(e),
                "message": "Error downloading document"
            }
    
    async def delete_document(self, document_id: str, user_id: str = None) -> Dict[str, Any]:
        """Delete a document from Azure Blob Storage and search index."""
        try:
            # Find document metadata
            document_context = await self._find_document_with_context(document_id)
            if not document_context:
                return {
                    "success": False,
                    "error": f"Document not found: {document_id}",
                    "message": "Document not found"
                }
            
            document_metadata, doc_user_id, session_id = document_context
            
            # Verify user has access to this document
            if user_id and doc_user_id != user_id:
                return {
                    "success": False,
                    "error": "Access denied to document",
                    "message": "User does not have access to this document"
                }
            
            blob_url = document_metadata.get('blobUrl', '')
            
            # Delete from blob storage
            if blob_url and self.blob_service_client:
                try:
                    parsed_url = urlparse(blob_url)
                    path_parts = parsed_url.path.strip('/').split('/', 1)
                    
                    if len(path_parts) >= 2:
                        container_name = path_parts[0]
                        blob_name = unquote(path_parts[1])
                        
                        blob_client = self.blob_service_client.get_blob_client(
                            container=container_name, blob=blob_name)
                        blob_client.delete_blob()
                        logger.info(f"Deleted blob: {blob_name}")
                except Exception as e:
                    logger.error(f"Error deleting blob: {e}")
            
            # Delete from search index
            if self.search_client:
                try:
                    # Delete all chunks for this document
                    search_results = self.search_client.search(
                        search_text="*",
                        filter=f"documentId eq '{document_id}'",
                        select=["chunkId"]
                    )
                    
                    chunks_to_delete = [{"chunkId": result["chunkId"]} for result in search_results]
                    
                    if chunks_to_delete:
                        self.search_client.delete_documents(documents=chunks_to_delete)
                        logger.info(f"Deleted {len(chunks_to_delete)} chunks from search index")
                except Exception as e:
                    logger.error(f"Error deleting from search index: {e}")
            
            # Remove from session documents
            if self.cosmos_client.is_available():
                try:
                    session_doc = self.cosmos_client.sessions_container.read_item(
                        item=session_id, 
                        partition_key=doc_user_id
                    )
                    
                    documents = session_doc.get('documents', [])
                    session_doc['documents'] = [
                        doc for doc in documents 
                        if doc.get('documentId') != document_id
                    ]
                    
                    self.cosmos_client.sessions_container.replace_item(
                        item=session_id, 
                        body=session_doc
                    )
                    logger.info(f"Removed document {document_id} from session {session_id}")
                except Exception as e:
                    logger.error(f"Error removing document from session: {e}")
            
            return {
                "success": True,
                "document_id": document_id,
                "message": "Document deleted successfully from all locations"
            }
        
        except Exception as e:
            logger.error(f"Error deleting document {document_id}: {e}")
            return {
                "success": False,
                "error": str(e),
                "message": "Error deleting document"
            }
    
    def _get_content_type(self, file_name: str) -> str:
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


# Global document service instance
document_service = DocumentService()
