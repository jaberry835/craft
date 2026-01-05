"""
Azure Document Service for handling document upload, processing, and search.
Matches the functionality of the C# AzureDocumentService.
"""

import logging
import os
import uuid
import json
import asyncio
from datetime import datetime, timezone
from typing import List, Dict, Any, Optional, Tuple
from io import BytesIO
import tempfile

# Azure imports
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
except ImportError:
    AZURE_AVAILABLE = False
    logging.error("Azure SDK packages not available. Install: azure-storage-blob, azure-ai-formrecognizer, azure-ai-openai, azure-search-documents")

logger = logging.getLogger(__name__)

class DocumentMetadata:
    def __init__(self, data: dict):
        self.document_id = data.get('documentId', '')
        self.file_name = data.get('fileName', '')
        self.user_id = data.get('userId', '')
        self.session_id = data.get('sessionId', '')
        self.upload_date = data.get('uploadDate', datetime.now(timezone.utc).isoformat())
        self.file_size = data.get('fileSize', 0)
        self.status = data.get('status', 'uploaded')
        self.blob_url = data.get('blobUrl', '')
    
    def to_dict(self):
        return {
            'documentId': self.document_id,
            'fileName': self.file_name,
            'userId': self.user_id,
            'sessionId': self.session_id,
            'uploadDate': self.upload_date,
            'fileSize': self.file_size,
            'status': self.status,
            'blobUrl': self.blob_url
        }

class DocumentChunk:
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
        """Convert to Azure Search document format"""
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

class AzureDocumentService:
    """Azure Document Service for handling document upload, processing, and search"""
    
    def __init__(self, config: Dict[str, Any], cosmos_sessions_container=None):
        self.config = config
        self.sessions_container = cosmos_sessions_container
        
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
        """Initialize Azure service clients"""
        try:
            # Azure Storage
            storage_config = self.config.get('AzureStorage', {})
            storage_connection_string = storage_config.get('ConnectionString', '')
            logger.info(f"Azure Storage config present: {bool(storage_config)}")
            logger.info(f"Connection string present: {bool(storage_connection_string)}")
            logger.info(f"Connection string valid (no brackets): {bool(storage_connection_string and '[' not in storage_connection_string)}")
            
            if storage_connection_string and '[' not in storage_connection_string:
                try:
                    self.blob_service_client = BlobServiceClient.from_connection_string(storage_connection_string)
                    logger.info("✅ Azure Blob Storage client initialized successfully")
                except Exception as e:
                    logger.error(f"❌ Failed to initialize Azure Blob Storage client: {e}")
                    self.blob_service_client = None
            else:
                logger.warning("❌ Azure Storage not configured properly")
                logger.warning(f"Storage config: {storage_config}")
                logger.warning(f"Connection string length: {len(storage_connection_string) if storage_connection_string else 0}")
            
            # Azure Document Intelligence
            doc_intel_config = self.config.get('AzureDocumentIntelligence', {})
            endpoint = doc_intel_config.get('Endpoint', '')
            api_key = doc_intel_config.get('ApiKey', '')
            if endpoint and api_key and '[' not in endpoint and '[' not in api_key:
                self.document_analysis_client = DocumentAnalysisClient(endpoint, AzureKeyCredential(api_key))
                logger.info("✅ Azure Document Intelligence client initialized")
            else:
                logger.warning("Azure Document Intelligence not configured")
            
            # Azure OpenAI
            openai_config = self.config.get('AzureOpenAI', {})
            openai_endpoint = openai_config.get('Endpoint', '')
            openai_key = openai_config.get('ApiKey', '')
            if openai_endpoint and openai_key and '[' not in openai_endpoint and '[' not in openai_key:
                self.openai_client = AzureOpenAI(
                    azure_endpoint=openai_endpoint,
                    api_key=openai_key,
                    api_version="2024-02-01"
                )
                logger.info("✅ Azure OpenAI client initialized")
            else:
                logger.warning("Azure OpenAI not configured")
            
            # Azure AI Search
            search_config = self.config.get('AzureSearch', {})
            search_endpoint = search_config.get('Endpoint', '')
            search_key = search_config.get('Key', '')
            index_name = search_config.get('IndexName', 'documents')
            if search_endpoint and search_key and '[' not in search_endpoint and '[' not in search_key:
                self.search_index_client = SearchIndexClient(search_endpoint, AzureKeyCredential(search_key))
                self.search_client = SearchClient(search_endpoint, index_name, AzureKeyCredential(search_key))
                logger.info("✅ Azure AI Search client initialized")
                
                # Initialize search index synchronously
                self._ensure_search_index()
            else:
                logger.warning("Azure AI Search not configured")
        
        except Exception as e:
            logger.error(f"Error initializing Azure clients: {e}")
    
    def _ensure_search_index(self):
        """Ensure the search index exists with proper schema"""
        try:
            if not self.search_index_client:
                return
            
            index_name = self.config.get('AzureSearch', {}).get('IndexName', 'documents')
            
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
    
    async def _ensure_search_index_async(self):
        """Async version - for compatibility"""
        self._ensure_search_index()
    
    async def upload_document_async(self, file_stream, file_name: str, user_id: str, session_id: str) -> str:
        """Upload a document to Azure Blob Storage and save metadata"""
        try:
            document_id = str(uuid.uuid4())
            blob_url = ""
            
            logger.info(f"Starting document upload: {file_name} for user {user_id}, session {session_id}")
            
            # Upload to Azure Blob Storage
            if self.blob_service_client:
                container_name = self.config.get('AzureStorage', {}).get('ContainerName', 'documents')
                container_client = self.blob_service_client.get_container_client(container_name)
                
                # Create container if it doesn't exist
                try:
                    container_client.create_container()
                    # logger.info(f"Created container: {container_name}")  # Reduced logging
                except Exception as e:
                    # logger.info(f"Container {container_name} already exists or error: {e}")  # Reduced logging
                    pass
                
                blob_name = f"{user_id}/{session_id}/{document_id}/{file_name}"
                blob_client = container_client.get_blob_client(blob_name)
                
                # Upload file
                file_stream.seek(0)
                file_data = file_stream.read()
                # logger.info(f"Uploading {len(file_data)} bytes to blob: {blob_name}")  # Reduced logging
                
                file_stream.seek(0)
                blob_client.upload_blob(file_stream, overwrite=True)
                blob_url = blob_client.url
                
                logger.info(f"Document uploaded to blob storage: {blob_url}")
            else:
                logger.warning("No blob service client available - skipping blob upload")
            
            # Get file size
            file_stream.seek(0, 2)  # Seek to end
            file_size = file_stream.tell()
            file_stream.seek(0)  # Reset position
            
            # Store document metadata in Cosmos DB session
            document_metadata = {
                'documentId': document_id,
                'fileName': file_name,
                'fileSize': file_size,
                'blobUrl': blob_url,
                'uploadDate': datetime.now(timezone.utc).isoformat(),
                'status': 0  # Uploaded status
            }
            
            # logger.info(f"Document metadata to store: {document_metadata}")  # Reduced logging
            
            if self.sessions_container:
                await self._add_document_to_session_async(user_id, session_id, document_metadata)
            else:
                logger.warning("No sessions container available - skipping metadata storage")
            
            logger.info(f"Document uploaded successfully: {document_id}")
            return document_id
        
        except Exception as e:
            logger.error(f"Error uploading document: {e}")
            raise
    
    async def _add_document_to_session_async(self, user_id: str, session_id: str, document_metadata: dict):
        """Add document metadata to session in Cosmos DB"""
        try:
            # Get current session
            session_doc = self.sessions_container.read_item(item=session_id, partition_key=user_id)
            
            # Add document to session's documents array
            if 'documents' not in session_doc:
                session_doc['documents'] = []
            
            session_doc['documents'].append(document_metadata)
            
            # Save back to Cosmos DB
            self.sessions_container.replace_item(item=session_id, body=session_doc)
            
            # logger.info(f"Added document {document_metadata['documentId']} to session {session_id}")  # Reduced logging
        
        except Exception as e:
            logger.error(f"Error adding document to session: {e}")
            raise
    
    async def process_document_async(self, document_id: str) -> DocumentProcessingResult:
        """Process document: extract text, chunk, generate embeddings, and index"""
        try:
            # Find document in Cosmos DB
            document_context = await self._find_document_with_context_async(document_id)
            if not document_context:
                raise ValueError(f"Document not found: {document_id}")
            
            document_metadata, user_id, session_id = document_context
            blob_url = document_metadata.get('blobUrl', '')
            
            logger.info(f"Processing document {document_id} with blob URL: {blob_url}")
            
            # Update status to processing
            await self._update_document_status_async(user_id, document_id, 1)  # Processing
            
            # Extract text
            extracted_text = await self._extract_text_async(blob_url, document_metadata.get('fileName', ''))
            
            if not extracted_text:
                raise ValueError("No text could be extracted from document")
            
            # Create document metadata object
            doc_meta = DocumentMetadata({
                'documentId': document_id,
                'fileName': document_metadata.get('fileName', ''),
                'userId': user_id,
                'sessionId': session_id,
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
                await self._index_chunks_async(chunks)
            else:
                logger.warning("OpenAI or Search not configured, chunks will not be indexed for vector search")
            
            # Update status to processed
            await self._update_document_status_async(user_id, document_id, 2)  # Processed
            
            logger.info(f"Document processed successfully: {document_id}, Chunks: {len(chunks)}")
            
            return DocumentProcessingResult(
                document_id=document_id,
                success=True,
                chunk_count=len(chunks),
                extracted_text=extracted_text
            )
        
        except Exception as e:
            logger.error(f"Error processing document {document_id}: {e}")
            
            # Try to update status to failed
            try:
                document_context = await self._find_document_with_context_async(document_id)
                if document_context:
                    _, user_id, _ = document_context
                    await self._update_document_status_async(user_id, document_id, 5)  # Failed
            except Exception:
                pass
            
            return DocumentProcessingResult(
                document_id=document_id,
                success=False,
                error_message=str(e)
            )
    
    async def _extract_text_async(self, blob_url: str, file_name: str) -> str:
        """Extract text from document using Azure Document Intelligence or direct blob read"""
        extracted_text = ""
        
        # Try Azure Document Intelligence first
        if self.document_analysis_client and blob_url:
            try:
                # logger.info("Using Azure Document Intelligence for text extraction")  # Reduced logging
                poller = self.document_analysis_client.begin_analyze_document_from_url(
                    "prebuilt-document", blob_url)
                result = poller.result()
                
                text_parts = []
                for page in result.pages:
                    for line in page.lines:
                        text_parts.append(line.content)
                
                extracted_text = '\n'.join(text_parts)
                # logger.info(f"Document Intelligence extracted {len(extracted_text)} characters")  # Reduced logging
                
            except Exception as e:
                logger.warning(f"Document Intelligence failed: {e}")
        
        # If Document Intelligence failed, try direct blob read
        if not extracted_text and self.blob_service_client and blob_url:
            try:
                # logger.info("Reading text directly from blob storage")  # Reduced logging
                
                # Parse blob URL to get container and blob name
                from urllib.parse import urlparse
                parsed_url = urlparse(blob_url)
                path_parts = parsed_url.path.strip('/').split('/', 1)
                
                if len(path_parts) >= 2:
                    container_name = path_parts[0]
                    blob_name = path_parts[1]
                    
                    blob_client = self.blob_service_client.get_blob_client(
                        container=container_name, blob=blob_name)
                    
                    download_stream = blob_client.download_blob()
                    extracted_text = download_stream.readall().decode('utf-8')
                    # logger.info(f"Read {len(extracted_text)} characters from blob storage")  # Reduced logging
                
            except Exception as e:
                logger.warning(f"Failed to read from blob: {e}")
        
        return extracted_text
    
    def _chunk_text(self, text: str, document_id: str, metadata: DocumentMetadata) -> List[DocumentChunk]:
        """Chunk text into smaller pieces for vector search"""
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
        """Create a document chunk"""
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
        """Generate embedding for text using Azure OpenAI"""
        try:
            if not self.openai_client:
                return None
            
            # Use the embedding model
            response = self.openai_client.embeddings.create(
                input=text,
                model="text-embedding-ada-002"  # Standard Azure OpenAI embedding model
            )
            
            return response.data[0].embedding
        
        except Exception as e:
            logger.error(f"Error generating embedding: {e}")
            return None

    async def _index_chunks_async(self, chunks: List[DocumentChunk]):
        """Index chunks in Azure AI Search with vector embeddings"""
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
    
    async def search_documents_async(self, query: str, user_id: str, session_id: str = None, max_results: int = 5) -> List[DocumentChunk]:
        """Search documents using Azure AI Search with hybrid text and vector search"""
        try:
            results = []
            
            if not self.search_client:
                logger.warning("Search client not available")
                return results
            
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
                logger.info("Performing hybrid text + vector search")
            else:
                logger.info("Performing text-only search")
            
            # Perform search
            search_results = self.search_client.search(**search_kwargs)
            
            for result in search_results:
                chunk_data = {
                    'chunkId': result.get('chunkId', ''),
                    'documentId': result.get('documentId', ''),
                    'userId': result.get('userId', ''),
                    'sessionId': result.get('sessionId', ''),
                    'fileName': result.get('fileName', ''),
                    'content': result.get('content', ''),
                    'chunkIndex': result.get('chunkIndex', 0),
                    'uploadedAt': result.get('uploadedAt', '')
                }
                results.append(DocumentChunk(chunk_data))
            
            logger.info(f"Found {len(results)} search results for query: {query}")
            return results
            
        except Exception as e:
            logger.error(f"Error searching documents: {e}")
            return []
    
    async def get_user_documents_async(self, user_id: str, session_id: str = None) -> List[DocumentMetadata]:
        """Get documents for a user/session"""
        try:
            documents = []
            
            if not self.sessions_container:
                return documents
            
            if session_id:
                # Get documents for specific session
                try:
                    session_doc = self.sessions_container.read_item(item=session_id, partition_key=user_id)
                    session_documents = session_doc.get('documents', [])
                    
                    for doc_data in session_documents:
                        documents.append(DocumentMetadata(doc_data))
                
                except Exception as e:
                    logger.warning(f"Session not found: {session_id}")
            else:
                # Get documents across all user sessions
                query = "SELECT * FROM c WHERE c.userId = @userId"
                parameters = [{"name": "@userId", "value": user_id}]
                
                items = list(self.sessions_container.query_items(
                    query=query,
                    parameters=parameters,
                    partition_key=user_id
                ))
                
                for session in items:
                    session_documents = session.get('documents', [])
                    for doc_data in session_documents:
                        documents.append(DocumentMetadata(doc_data))
            
            return documents
        
        except Exception as e:
            logger.error(f"Error getting user documents: {e}")
            return []
    
    async def _find_document_with_context_async(self, document_id: str, session_id: str = None) -> Optional[Tuple[dict, str, str]]:
        """Find document metadata with user and session context, with optional session validation"""
        try:
            if not self.sessions_container:
                return None
            
            # Use a simpler query that checks if any document in the array has the matching ID
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
                items = list(self.sessions_container.query_items(
                    query=query,
                    parameters=parameters,
                    enable_cross_partition_query=True  # Enable cross-partition query
                ))
                
                # logger.info(f"Found {len(items)} sessions containing document {document_id}")  # Reduced logging
                
                for session in items:
                    documents = session.get('documents', [])
                    # logger.info(f"Session {session.get('id', '')} has {len(documents)} documents")  # Reduced logging
                    for doc in documents:
                        if doc.get('documentId') == document_id:
                            doc_session_id = session.get('id', '')
                            
                            # If session_id is provided, verify document belongs to that session
                            if session_id and doc_session_id != session_id:
                                logger.warning(f"🚫 Session isolation violation: Document {document_id} belongs to session {doc_session_id}, not {session_id}")
                                return None
                            
                            logger.info(f"Found document {document_id} with blob URL: {doc.get('blobUrl', '')}")
                            return doc, session.get('userId', ''), doc_session_id
                
            except Exception as query_error:
                logger.warning(f"Query failed, falling back to scan all sessions: {query_error}")
                # Fallback: scan all sessions (less efficient but more reliable)
                items = list(self.sessions_container.read_all_items())
                for session in items:
                    documents = session.get('documents', [])
                    for doc in documents:
                        if doc.get('documentId') == document_id:
                            doc_session_id = session.get('id', '')
                            
                            # If session_id is provided, verify document belongs to that session
                            if session_id and doc_session_id != session_id:
                                logger.warning(f"🚫 Session isolation violation (fallback): Document {document_id} belongs to session {doc_session_id}, not {session_id}")
                                return None
                                
                            logger.info(f"Found document {document_id} (fallback) with blob URL: {doc.get('blobUrl', '')}")
                            return doc, session.get('userId', ''), doc_session_id
            
            logger.warning(f"Document {document_id} not found in any session")
            return None
        
        except Exception as e:
            logger.error(f"Error finding document context: {e}")
            return None
    
    async def _update_document_status_async(self, user_id: str, document_id: str, status: int):
        """Update document status in Cosmos DB"""
        try:
            if not self.sessions_container:
                return
            
            # Find the session containing this document
            document_context = await self._find_document_with_context_async(document_id)
            if not document_context:
                return
            
            _, _, session_id = document_context
            
            # Update the document status
            session_doc = self.sessions_container.read_item(item=session_id, partition_key=user_id)
            documents = session_doc.get('documents', [])
            
            for doc in documents:
                if doc.get('documentId') == document_id:
                    doc['status'] = status
                    break
            
            # Save back to Cosmos DB
            self.sessions_container.replace_item(item=session_id, body=session_doc)
            
            # logger.info(f"Updated document {document_id} status to {status}")  # Reduced logging
        
        except Exception as e:
            logger.error(f"Error updating document status: {e}")
    
    async def download_document_async(self, document_id: str, user_id: str) -> Tuple[bytes, str, str]:
        """Download a document from Azure Blob Storage"""
        try:
            # Find document metadata
            document_context = await self._find_document_with_context_async(document_id)
            if not document_context:
                raise ValueError(f"Document not found: {document_id}")
            
            document_metadata, doc_user_id, session_id = document_context
            
            # Verify user has access to this document
            if doc_user_id != user_id:
                raise PermissionError("Access denied to document")
            
            blob_url = document_metadata.get('blobUrl', '')
            file_name = document_metadata.get('fileName', 'document')
            
            if not blob_url or not self.blob_service_client:
                raise ValueError("Document not available for download")
            
            # Parse blob URL to get container and blob name
            from urllib.parse import urlparse
            parsed_url = urlparse(blob_url)
            path_parts = parsed_url.path.strip('/').split('/', 1)
            
            if len(path_parts) >= 2:
                container_name = path_parts[0]
                blob_name = path_parts[1]
                
                blob_client = self.blob_service_client.get_blob_client(
                    container=container_name, blob=blob_name)
                
                # Download blob content
                download_stream = blob_client.download_blob()
                content = download_stream.readall()
                
                # Determine content type based on file extension
                file_ext = os.path.splitext(file_name)[1].lower()
                content_type_map = {
                    '.pdf': 'application/pdf',
                    '.doc': 'application/msword',
                    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                    '.txt': 'text/plain',
                    '.md': 'text/markdown'
                }
                content_type = content_type_map.get(file_ext, 'application/octet-stream')
                
                # logger.info(f"Downloaded document {document_id}: {file_name} ({len(content)} bytes)")  # Reduced logging
                return content, file_name, content_type
            else:
                raise ValueError("Invalid blob URL format")
        
        except Exception as e:
            logger.error(f"Error downloading document {document_id}: {e}")
            raise
