"""
Grounding Service
Manages document grounding for agents using Azure AI Search and Azure Blob Storage.

This service enables RAG (Retrieval Augmented Generation) patterns where agents
can search through organizational documents stored in Azure Blob Storage.

Architecture (Sovereign Cloud Compatible):
- Documents are stored in Azure Blob Storage containers
- Documents are indexed into Azure AI Search with embeddings
- Agents get a custom search tool to query their grounded documents
- No dependency on Azure AI Foundry (works in Azure Government)
"""
from typing import Optional, Callable, Annotated
import asyncio
import hashlib
from datetime import datetime

from azure.storage.blob import ContainerClient
from azure.core.credentials import AzureKeyCredential
from azure.search.documents import SearchClient
from azure.search.documents.indexes import SearchIndexClient
from azure.search.documents.indexes.models import (
    SearchIndex,
    SearchField,
    SearchFieldDataType,
    VectorSearch,
    HnswAlgorithmConfiguration,
    VectorSearchProfile,
    SearchableField,
    SimpleField
)
from azure.search.documents.models import VectorizedQuery

from config import get_settings, get_azure_credential
from observability import get_logger
from services.embedding_service import embedding_service

settings = get_settings()
logger = get_logger(__name__)

# Index name prefix for grounding indices
GROUNDING_INDEX_PREFIX = "grounding-"


class GroundingService:
    """
    Manages document grounding for agents using Azure AI Search.
    
    When an agent is configured with grounding_sources (Azure Blob container URLs),
    this service:
    1. Creates a dedicated search index for that agent
    2. Indexes documents from the blob containers with embeddings
    3. Provides a search function that agents can use to query documents
    
    Works in sovereign clouds (Azure Government) - no Foundry dependency.
    """
    
    VECTOR_DIMENSIONS = 1536  # text-embedding-ada-002
    CHUNK_SIZE = 1000  # Characters per chunk
    CHUNK_OVERLAP = 200  # Overlap between chunks
    
    def __init__(self):
        self._credential = None
        self._index_client: Optional[SearchIndexClient] = None
        self._initialized = False
        self._lock = asyncio.Lock()
    
    async def initialize(self) -> None:
        """Initialize the grounding service with Azure AI Search."""
        if self._initialized:
            return
        
        async with self._lock:
            if self._initialized:
                return
            
            # Check if Azure AI Search is configured
            if not settings.search_endpoint:
                logger.warning(
                    "Azure AI Search endpoint not configured. "
                    "Grounding features will be disabled. "
                    "Set AZURE_SEARCH_ENDPOINT to enable document grounding."
                )
                self._initialized = True
                return
            
            try:
                # Use API key if available, otherwise managed identity
                if settings.search_key:
                    self._credential = AzureKeyCredential(settings.search_key)
                else:
                    self._credential = get_azure_credential()
                
                self._index_client = SearchIndexClient(
                    endpoint=settings.search_endpoint,
                    credential=self._credential
                )
                
                logger.info(f"Grounding service initialized with Azure AI Search: {settings.search_endpoint}")
                self._initialized = True
            except Exception as e:
                logger.error(f"Failed to initialize grounding service: {e}")
                self._initialized = True  # Mark as initialized to avoid retry loops
    
    @property
    def is_available(self) -> bool:
        """Check if grounding features are available."""
        return self._index_client is not None
    
    def _get_index_name(self, agent_id: str) -> str:
        """Get the search index name for an agent's grounding documents."""
        # Create a safe index name from agent ID
        safe_id = agent_id.replace("-", "").lower()[:20]
        return f"{GROUNDING_INDEX_PREFIX}{safe_id}"
    
    async def _ensure_grounding_index(self, agent_id: str) -> str:
        """Ensure the grounding search index exists for an agent."""
        index_name = self._get_index_name(agent_id)
        
        try:
            self._index_client.get_index(index_name)
            logger.debug(f"Grounding index {index_name} exists")
        except Exception:
            # Create the index
            index = SearchIndex(
                name=index_name,
                fields=[
                    SimpleField(name="id", type=SearchFieldDataType.String, key=True),
                    SimpleField(name="agentId", type=SearchFieldDataType.String, filterable=True),
                    SimpleField(name="sourceUrl", type=SearchFieldDataType.String, filterable=True),
                    SimpleField(name="sourceName", type=SearchFieldDataType.String, filterable=True),
                    SearchableField(name="fileName", type=SearchFieldDataType.String),
                    SearchableField(name="content", type=SearchFieldDataType.String),
                    SimpleField(name="chunkIndex", type=SearchFieldDataType.Int32, sortable=True),
                    SimpleField(name="indexedAt", type=SearchFieldDataType.DateTimeOffset, sortable=True),
                    SearchField(
                        name="contentVector",
                        type=SearchFieldDataType.Collection(SearchFieldDataType.Single),
                        searchable=True,
                        vector_search_dimensions=self.VECTOR_DIMENSIONS,
                        vector_search_profile_name="vector-profile"
                    )
                ],
                vector_search=VectorSearch(
                    algorithms=[
                        HnswAlgorithmConfiguration(name="hnsw-config")
                    ],
                    profiles=[
                        VectorSearchProfile(
                            name="vector-profile",
                            algorithm_configuration_name="hnsw-config"
                        )
                    ]
                )
            )
            
            self._index_client.create_index(index)
            logger.info(f"Created grounding index: {index_name}")
        
        return index_name
    
    def _chunk_text(self, text: str) -> list[str]:
        """Split text into overlapping chunks."""
        chunks = []
        start = 0
        while start < len(text):
            end = start + self.CHUNK_SIZE
            chunk = text[start:end]
            if chunk.strip():
                chunks.append(chunk)
            start = end - self.CHUNK_OVERLAP
        return chunks
    
    async def _index_blob_documents(
        self,
        agent_id: str,
        index_name: str,
        container_url: str,
        source_name: str,
        blob_prefix: Optional[str] = None
    ) -> int:
        """
        Index documents from an Azure Blob Storage container.
        
        Returns the number of chunks indexed.
        """
        indexed_count = 0
        
        try:
            # Create container client with managed identity
            container_client = ContainerClient.from_container_url(
                container_url,
                credential=get_azure_credential()
            )
            
            # Create search client for this index
            search_client = SearchClient(
                endpoint=settings.search_endpoint,
                index_name=index_name,
                credential=self._credential
            )
            
            # List blobs (with optional prefix filter)
            blobs = container_client.list_blobs(name_starts_with=blob_prefix)
            
            for blob in blobs:
                # Skip non-text files
                if not self._is_supported_file(blob.name):
                    logger.debug(f"Skipping unsupported file: {blob.name}")
                    continue
                
                try:
                    # Download blob content
                    blob_client = container_client.get_blob_client(blob.name)
                    content = blob_client.download_blob().readall()
                    
                    # Decode text (try utf-8, fallback to latin-1)
                    try:
                        text = content.decode('utf-8')
                    except UnicodeDecodeError:
                        text = content.decode('latin-1')
                    
                    # Chunk the document
                    chunks = self._chunk_text(text)
                    
                    # Index each chunk
                    for i, chunk in enumerate(chunks):
                        # Generate embedding
                        embedding = await embedding_service.generate_embedding(chunk)
                        
                        if not embedding:
                            logger.warning(f"Failed to generate embedding for chunk {i} of {blob.name}")
                            continue
                        
                        # Create document ID
                        doc_id = hashlib.md5(f"{agent_id}:{container_url}:{blob.name}:{i}".encode()).hexdigest()
                        
                        document = {
                            "id": doc_id,
                            "agentId": agent_id,
                            "sourceUrl": container_url,
                            "sourceName": source_name,
                            "fileName": blob.name,
                            "content": chunk,
                            "chunkIndex": i,
                            "indexedAt": datetime.utcnow().isoformat() + "Z",
                            "contentVector": embedding
                        }
                        
                        search_client.upload_documents(documents=[document])
                        indexed_count += 1
                    
                    logger.info(f"Indexed {len(chunks)} chunks from {blob.name}")
                    
                except Exception as e:
                    logger.error(f"Failed to index blob {blob.name}: {e}")
                    continue
            
        except Exception as e:
            logger.error(f"Failed to access container {container_url}: {e}")
        
        return indexed_count
    
    def _is_supported_file(self, filename: str) -> bool:
        """Check if the file type is supported for indexing."""
        supported_extensions = {
            '.txt', '.md', '.json', '.csv', '.xml',
            '.html', '.htm', '.log', '.yaml', '.yml',
            '.py', '.js', '.ts', '.java', '.cs', '.cpp', '.c', '.h',
            '.sql', '.sh', '.ps1', '.bat', '.cmd'
        }
        ext = '.' + filename.rsplit('.', 1)[-1].lower() if '.' in filename else ''
        return ext in supported_extensions
    
    async def create_or_update_grounding_index(
        self,
        agent_id: str,
        agent_name: str,
        grounding_sources: list[dict]
    ) -> Optional[str]:
        """
        Create or update the grounding index for an agent.
        
        Args:
            agent_id: Unique identifier for the agent
            agent_name: Human-readable agent name
            grounding_sources: List of grounding source configurations
            
        Returns:
            Index name if successful, None otherwise
        """
        if not self.is_available:
            logger.warning("Grounding service not available - skipping index creation")
            return None
        
        if not grounding_sources:
            return None
        
        try:
            # Ensure index exists
            index_name = await self._ensure_grounding_index(agent_id)
            
            # Clear existing documents for this agent (to handle updates)
            await self._clear_agent_documents(index_name, agent_id)
            
            # Index documents from each grounding source
            total_indexed = 0
            for source in grounding_sources:
                container_url = source.get("container_url", "")
                source_name = source.get("name") or self._extract_container_name(container_url)
                blob_prefix = source.get("blob_prefix")
                
                count = await self._index_blob_documents(
                    agent_id=agent_id,
                    index_name=index_name,
                    container_url=container_url,
                    source_name=source_name,
                    blob_prefix=blob_prefix
                )
                total_indexed += count
            
            logger.info(f"Indexed {total_indexed} total chunks for agent {agent_id} in index {index_name}")
            return index_name
            
        except Exception as e:
            logger.error(f"Failed to create grounding index for agent {agent_id}: {e}")
            return None
    
    async def _clear_agent_documents(self, index_name: str, agent_id: str) -> None:
        """Clear all documents for an agent from the index."""
        try:
            search_client = SearchClient(
                endpoint=settings.search_endpoint,
                index_name=index_name,
                credential=self._credential
            )
            
            # Find all documents for this agent
            results = search_client.search(
                search_text="*",
                filter=f"agentId eq '{agent_id}'",
                select=["id"],
                top=1000
            )
            
            doc_ids = [{"id": r["id"]} for r in results]
            if doc_ids:
                search_client.delete_documents(documents=doc_ids)
                logger.info(f"Cleared {len(doc_ids)} existing documents for agent {agent_id}")
        except Exception as e:
            logger.debug(f"Could not clear documents (index may not exist yet): {e}")
    
    async def delete_grounding_index(self, agent_id: str) -> bool:
        """Delete the grounding index for an agent."""
        if not self.is_available:
            return False
        
        try:
            index_name = self._get_index_name(agent_id)
            self._index_client.delete_index(index_name)
            logger.info(f"Deleted grounding index: {index_name}")
            return True
        except Exception as e:
            logger.warning(f"Failed to delete grounding index for {agent_id}: {e}")
            return False
    
    def _extract_container_name(self, url: str) -> str:
        """Extract container name from URL."""
        try:
            parts = url.rstrip('/').split('/')
            return parts[-1] if parts else 'documents'
        except:
            return 'documents'
    
    async def search_grounding_documents(
        self,
        agent_id: str,
        query: str,
        top_k: int = 5
    ) -> list[dict]:
        """
        Search grounding documents for an agent.
        
        Args:
            agent_id: The agent ID
            query: Search query text
            top_k: Number of results to return
            
        Returns:
            List of matching document chunks with content and metadata
        """
        if not self.is_available:
            return []
        
        try:
            index_name = self._get_index_name(agent_id)
            
            # Generate query embedding
            query_embedding = await embedding_service.generate_embedding(query)
            if not query_embedding:
                logger.warning("Failed to generate query embedding")
                return []
            
            search_client = SearchClient(
                endpoint=settings.search_endpoint,
                index_name=index_name,
                credential=self._credential
            )
            
            vector_query = VectorizedQuery(
                vector=query_embedding,
                k_nearest_neighbors=top_k,
                fields="contentVector"
            )
            
            results = search_client.search(
                search_text=query,  # Hybrid search
                vector_queries=[vector_query],
                filter=f"agentId eq '{agent_id}'",
                select=["id", "fileName", "content", "sourceName", "chunkIndex"],
                top=top_k
            )
            
            documents = []
            for result in results:
                documents.append({
                    "file_name": result.get("fileName", ""),
                    "source": result.get("sourceName", ""),
                    "content": result.get("content", ""),
                    "chunk_index": result.get("chunkIndex", 0),
                    "score": result.get("@search.score", 0)
                })
            
            return documents
            
        except Exception as e:
            logger.error(f"Failed to search grounding documents for agent {agent_id}: {e}")
            return []
    
    def create_search_tool(self, agent_id: str, agent_name: str) -> Callable:
        """
        Create a search tool function that an agent can use to query its grounded documents.
        
        This returns a function that can be passed to the agent as a tool.
        """
        async def search_knowledge_base(
            query: Annotated[str, "The search query to find relevant information in the agent's knowledge base documents"]
        ) -> str:
            """
            Search the agent's knowledge base for relevant information.
            Use this tool when you need to find specific information from your grounding documents.
            """
            results = await self.search_grounding_documents(agent_id, query, top_k=5)
            
            if not results:
                return "No relevant documents found in the knowledge base."
            
            # Format results for the agent
            formatted = []
            for i, doc in enumerate(results, 1):
                formatted.append(
                    f"**Source: {doc['source']} - {doc['file_name']}**\n"
                    f"{doc['content']}\n"
                )
            
            return "\n---\n".join(formatted)
        
        return search_knowledge_base
    
    async def validate_container_access(self, container_url: str) -> tuple[bool, str]:
        """
        Validate that the container URL is accessible.
        
        Args:
            container_url: Azure Blob Storage container URL
            
        Returns:
            Tuple of (success: bool, message: str)
        """
        # Basic URL validation
        if not container_url.startswith("https://") or ".blob." not in container_url:
            return False, "Invalid Azure Blob Storage URL format. Expected: https://<account>.blob.core.windows.net/<container>"
        
        try:
            # Try to list blobs (just check access)
            container_client = ContainerClient.from_container_url(
                container_url,
                credential=get_azure_credential()
            )
            # Just try to get container properties to verify access
            container_client.get_container_properties()
            return True, "Container is accessible"
        except Exception as e:
            return False, f"Cannot access container: {str(e)}"
    
    async def get_index_status(self, agent_id: str) -> Optional[dict]:
        """
        Get the status of a grounding index.
        
        Args:
            agent_id: The agent ID
            
        Returns:
            Status dict with document count, etc. or None if not found
        """
        if not self.is_available:
            return None
        
        try:
            index_name = self._get_index_name(agent_id)
            
            search_client = SearchClient(
                endpoint=settings.search_endpoint,
                index_name=index_name,
                credential=self._credential
            )
            
            # Count documents for this agent
            results = search_client.search(
                search_text="*",
                filter=f"agentId eq '{agent_id}'",
                select=["id"],
                top=0,
                include_total_count=True
            )
            
            return {
                "index_name": index_name,
                "document_count": results.get_count() or 0,
                "status": "ready"
            }
        except Exception as e:
            logger.debug(f"Could not get index status for {agent_id}: {e}")
            return None


# Global singleton instance
grounding_service = GroundingService()
