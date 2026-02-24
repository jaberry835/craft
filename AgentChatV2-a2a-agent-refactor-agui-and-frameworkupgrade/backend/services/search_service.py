"""
Search Service
Azure AI Search integration for document embeddings and RAG.
Uses API key for local dev, DefaultAzureCredential for production.
"""
from typing import Optional, Union
import json
import time

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
from observability import get_logger, PerformanceTracker, should_log_performance, log_performance_summary, MetricType

settings = get_settings()
logger = get_logger(__name__)


class SearchService:
    """Azure AI Search service for document indexing and retrieval."""
    
    VECTOR_DIMENSIONS = 1536  # text-embedding-ada-002
    
    def __init__(self):
        self.credential = None
        self.index_client: Optional[SearchIndexClient] = None
        self.search_client: Optional[SearchClient] = None
        self.index_name = settings.search_index_name  # Use config value
    
    async def initialize(self) -> None:
        """Initialize Azure AI Search clients - uses API key if available, else managed identity."""
        try:
            if not settings.search_endpoint:
                logger.warning("Azure AI Search endpoint not configured - search disabled")
                return
            
            # Use API key for local development if provided
            if settings.search_key:
                logger.info("Using Azure AI Search with API key")
                self.credential = AzureKeyCredential(settings.search_key)
            else:
                # Use centralized credential helper (AzureCliCredential for dev, ManagedIdentityCredential for prod)
                self.credential = get_azure_credential()
                env_mode = "dev" if settings.environment == "development" else "prod"
                logger.info(f"Using Azure AI Search with {type(self.credential).__name__} ({env_mode} mode)")
            
            self.index_client = SearchIndexClient(
                endpoint=settings.search_endpoint,
                credential=self.credential
            )
            
            self.search_client = SearchClient(
                endpoint=settings.search_endpoint,
                index_name=self.index_name,
                credential=self.credential
            )
            
            await self._ensure_index()
            logger.info("Azure AI Search initialized")
            
        except Exception as e:
            logger.error(f"Search service initialization failed: {e}")
            raise
    
    async def _ensure_index(self) -> None:
        """Ensure the search index exists with proper schema."""
        try:
            self.index_client.get_index(self.index_name)
            logger.debug(f"Index {self.index_name} exists")
        except Exception:
            # Create index
            index = SearchIndex(
                name=self.index_name,
                fields=[
                    SimpleField(name="id", type=SearchFieldDataType.String, key=True),
                    SimpleField(name="sessionId", type=SearchFieldDataType.String, filterable=True),
                    SimpleField(name="userId", type=SearchFieldDataType.String, filterable=True),
                    SearchableField(name="title", type=SearchFieldDataType.String),
                    SearchableField(name="content", type=SearchFieldDataType.String),
                    SimpleField(name="fileType", type=SearchFieldDataType.String, filterable=True),
                    SimpleField(name="uploadedAt", type=SearchFieldDataType.DateTimeOffset, sortable=True),
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
            
            self.index_client.create_index(index)
            logger.info(f"Created search index: {self.index_name}")
    
    async def index_document(
        self,
        doc_id: str,
        session_id: str,
        user_id: str,
        title: str,
        content: str,
        file_type: str,
        embedding: list[float],
        uploaded_at: str
    ) -> None:
        """Index a document with its embedding and performance tracking."""
        document = {
            "id": doc_id,
            "sessionId": session_id,
            "userId": user_id,
            "title": title,
            "content": content,
            "fileType": file_type,
            "contentVector": embedding,
            "uploadedAt": uploaded_at
        }
        
        start_time = time.perf_counter()
        self.search_client.upload_documents(documents=[document])
        duration_ms = (time.perf_counter() - start_time) * 1000
        
        if should_log_performance():
            log_performance_summary(logger, "search_index_document", {
                "duration_ms": round(duration_ms, 2),
                "doc_id": doc_id,
                "content_length": len(content),
                "index": self.index_name,
                "operation": "index"
            })
        
        logger.info(f"Indexed document {doc_id} for session {session_id}")
    
    async def search_documents(
        self,
        query_embedding: list[float],
        session_id: Optional[str] = None,
        user_id: Optional[str] = None,
        top_k: int = 5
    ) -> list[dict]:
        """
        Search documents using vector similarity.
        
        Args:
            query_embedding: Embedding of the search query
            session_id: Filter to specific session
            user_id: Filter to specific user
            top_k: Number of results to return
        """
        # Build filter
        filters = []
        if session_id:
            filters.append(f"sessionId eq '{session_id}'")
        if user_id:
            filters.append(f"userId eq '{user_id}'")
        
        filter_expr = " and ".join(filters) if filters else None
        
        vector_query = VectorizedQuery(
            vector=query_embedding,
            k_nearest_neighbors=top_k,
            fields="contentVector"
        )
        
        start_time = time.perf_counter()
        results = self.search_client.search(
            search_text=None,
            vector_queries=[vector_query],
            filter=filter_expr,
            select=["id", "title", "content", "fileType", "sessionId"],
            top=top_k
        )
        
        documents = []
        for result in results:
            documents.append({
                "id": result["id"],
                "title": result["title"],
                "content": result["content"],
                "file_type": result["fileType"],
                "session_id": result["sessionId"],
                "score": result.get("@search.score", 0)
            })
        
        duration_ms = (time.perf_counter() - start_time) * 1000
        
        if should_log_performance():
            log_performance_summary(logger, "search_vector_query", {
                "duration_ms": round(duration_ms, 2),
                "result_count": len(documents),
                "top_k": top_k,
                "has_session_filter": session_id is not None,
                "has_user_filter": user_id is not None,
                "index": self.index_name,
                "operation": "vector_search"
            })
        
        return documents
    
    async def hybrid_search(
        self,
        query_text: str,
        query_embedding: list[float],
        session_id: Optional[str] = None,
        user_id: Optional[str] = None,
        top_k: int = 5
    ) -> list[dict]:
        """
        Hybrid search combining text and vector similarity with performance tracking.
        """
        filters = []
        if session_id:
            filters.append(f"sessionId eq '{session_id}'")
        if user_id:
            filters.append(f"userId eq '{user_id}'")
        
        filter_expr = " and ".join(filters) if filters else None
        
        vector_query = VectorizedQuery(
            vector=query_embedding,
            k_nearest_neighbors=top_k,
            fields="contentVector"
        )
        
        start_time = time.perf_counter()
        results = self.search_client.search(
            search_text=query_text,
            vector_queries=[vector_query],
            filter=filter_expr,
            select=["id", "title", "content", "fileType", "sessionId"],
            top=top_k
        )
        
        documents = []
        for result in results:
            documents.append({
                "id": result["id"],
                "title": result["title"],
                "content": result["content"],
                "file_type": result["fileType"],
                "session_id": result["sessionId"],
                "score": result.get("@search.score", 0)
            })
        
        duration_ms = (time.perf_counter() - start_time) * 1000
        
        if should_log_performance():
            log_performance_summary(logger, "search_hybrid_query", {
                "duration_ms": round(duration_ms, 2),
                "result_count": len(documents),
                "top_k": top_k,
                "query_text_length": len(query_text),
                "has_session_filter": session_id is not None,
                "has_user_filter": user_id is not None,
                "index": self.index_name,
                "operation": "hybrid_search"
            })
        
        return documents
    
    async def delete_document(self, doc_id: str) -> None:
        """Delete a document from the index."""
        self.search_client.delete_documents(documents=[{"id": doc_id}])
        logger.info(f"Deleted document {doc_id}")
    
    async def get_document_chunks(self, doc_id: str, user_id: str = None) -> list[dict]:
        """
        Get all chunks of a document by its ID prefix.
        Chunks are stored as {doc_id}_{chunk_num}.
        If user_id is provided, filter by user for security.
        """
        # Search for all chunks - optionally filter by user
        filter_expr = f"userId eq '{user_id}'" if user_id else None
        
        results = self.search_client.search(
            search_text="*",
            filter=filter_expr,
            select=["id", "title", "content", "fileType", "userId"],
            top=1000  # Get more results to find all chunks
        )
        
        # Filter results that match the doc_id prefix
        chunks = []
        for result in results:
            result_id = result.get("id", "")
            # Match exact doc_id prefix followed by underscore and number
            if result_id.startswith(f"{doc_id}_"):
                chunk_num = 0
                parts = result_id.split("_")
                if len(parts) > 1 and parts[-1].isdigit():
                    chunk_num = int(parts[-1])
                chunks.append({
                    "id": result_id,
                    "title": result.get("title", ""),
                    "content": result.get("content", ""),
                    "file_type": result.get("fileType", ""),
                    "user_id": result.get("userId", ""),
                    "chunk_num": chunk_num
                })
        
        # Sort by chunk number
        chunks.sort(key=lambda x: x["chunk_num"])
        logger.info(f"Found {len(chunks)} chunks for document {doc_id}")
        return chunks
    
    async def delete_session_documents(self, session_id: str) -> None:
        """Delete all documents for a session."""
        # Find all docs for session
        results = self.search_client.search(
            search_text="*",
            filter=f"sessionId eq '{session_id}'",
            select=["id"]
        )
        
        doc_ids = [{"id": r["id"]} for r in results]
        if doc_ids:
            self.search_client.delete_documents(documents=doc_ids)
            logger.info(f"Deleted {len(doc_ids)} documents for session {session_id}")


# Global instance
search_service = SearchService()
