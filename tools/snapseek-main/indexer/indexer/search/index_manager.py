"""Azure AI Search index manager."""

import structlog
from azure.search.documents import SearchClient
from azure.search.documents.indexes import SearchIndexClient
from azure.search.documents.indexes.models import (
    SearchIndex,
    SearchField,
    SearchFieldDataType,
    SimpleField,
    VectorSearch,
    HnswAlgorithmConfiguration,
    VectorSearchProfile,
    SemanticConfiguration,
    SemanticField,
    SemanticPrioritizedFields,
    SemanticSearch,
)
from tenacity import retry, stop_after_attempt, wait_exponential

from ..config import Settings, get_search_credential
from ..models import ImageDocument

logger = structlog.get_logger()


class SearchIndexManager:
    """Manager for Azure AI Search index operations."""
    
    def __init__(self, settings: Settings):
        """Initialize the search clients."""
        self.settings = settings
        self.credential = get_search_credential(settings)
        
        self.index_client = SearchIndexClient(
            endpoint=settings.azure_search_endpoint,
            credential=self.credential
        )
        
        self.search_client = SearchClient(
            endpoint=settings.azure_search_endpoint,
            index_name=settings.azure_search_index_name,
            credential=self.credential
        )
        
        self.logger = logger.bind(component="search_index")
    
    def _create_index_definition(self) -> SearchIndex:
        """Create the search index definition with all fields."""
        
        # Vector search configuration
        vector_search = VectorSearch(
            algorithms=[
                HnswAlgorithmConfiguration(
                    name="hnsw-algorithm",
                    parameters={
                        "m": 4,
                        "efConstruction": 400,
                        "efSearch": 500,
                        "metric": "cosine"
                    }
                )
            ],
            profiles=[
                VectorSearchProfile(
                    name="vector-profile-description",
                    algorithm_configuration_name="hnsw-algorithm"
                ),
                VectorSearchProfile(
                    name="vector-profile-image",
                    algorithm_configuration_name="hnsw-algorithm"
                )
            ]
        )
        
        # Semantic search configuration
        semantic_config = SemanticConfiguration(
            name="semantic-config",
            prioritized_fields=SemanticPrioritizedFields(
                title_field=SemanticField(field_name="caption"),
                content_fields=[
                    SemanticField(field_name="rich_description"),
                    SemanticField(field_name="extracted_text")
                ],
                keywords_fields=[
                    SemanticField(field_name="tags"),
                    SemanticField(field_name="objects")
                ]
            )
        )
        
        semantic_search = SemanticSearch(configurations=[semantic_config])
        
        # Field definitions
        # Note: Use SearchField (not SearchableField) for Collection types
        # SearchableField doesn't properly handle Collection(String) types
        fields = [
            # Key field
            SimpleField(
                name="id",
                type=SearchFieldDataType.String,
                key=True,
                filterable=True
            ),
            
            # Basic file info
            SearchField(name="filename", type=SearchFieldDataType.String, filterable=True, sortable=True, searchable=True),
            SimpleField(name="file_path", type=SearchFieldDataType.String),
            SimpleField(name="file_url", type=SearchFieldDataType.String),
            SimpleField(name="file_size", type=SearchFieldDataType.Int64, filterable=True, sortable=True),
            SimpleField(name="content_type", type=SearchFieldDataType.String, filterable=True),
            
            # Image analysis
            SearchField(name="caption", type=SearchFieldDataType.String, searchable=True),
            SimpleField(name="caption_confidence", type=SearchFieldDataType.Double),
            SearchField(
                name="dense_captions",
                type=SearchFieldDataType.Collection(SearchFieldDataType.String),
                searchable=True
            ),
            SearchField(
                name="tags",
                type=SearchFieldDataType.Collection(SearchFieldDataType.String),
                filterable=True,
                facetable=True,
                searchable=True
            ),
            SearchField(
                name="objects",
                type=SearchFieldDataType.Collection(SearchFieldDataType.String),
                filterable=True,
                facetable=True,
                searchable=True
            ),
            SearchField(
                name="brands",
                type=SearchFieldDataType.Collection(SearchFieldDataType.String),
                filterable=True,
                facetable=True,
                searchable=True
            ),
            SearchField(
                name="categories",
                type=SearchFieldDataType.Collection(SearchFieldDataType.String),
                filterable=True,
                facetable=True,
                searchable=True
            ),
            
            # OCR
            SearchField(name="extracted_text", type=SearchFieldDataType.String, searchable=True),
            SimpleField(name="has_text", type=SearchFieldDataType.Boolean, filterable=True, facetable=True),
            
            # Faces
            SimpleField(name="face_count", type=SearchFieldDataType.Int32, filterable=True, sortable=True),
            SimpleField(name="has_faces", type=SearchFieldDataType.Boolean, filterable=True, facetable=True),
            SimpleField(name="face_details", type=SearchFieldDataType.Collection(SearchFieldDataType.String)),
            SearchField(
                name="person_ids",
                type=SearchFieldDataType.Collection(SearchFieldDataType.String),
                filterable=True,
                facetable=True,
                searchable=True
            ),
            SearchField(
                name="persisted_face_ids",
                type=SearchFieldDataType.Collection(SearchFieldDataType.String),
                filterable=True,
                searchable=True
            ),
            
            # Colors
            SearchField(
                name="dominant_colors",
                type=SearchFieldDataType.Collection(SearchFieldDataType.String),
                filterable=True,
                facetable=True,
                searchable=True
            ),
            SimpleField(name="accent_color", type=SearchFieldDataType.String, filterable=True),
            SimpleField(name="is_black_white", type=SearchFieldDataType.Boolean, filterable=True, facetable=True),
            
            # Rich description for semantic search
            SearchField(name="rich_description", type=SearchFieldDataType.String, searchable=True),
            
            # Vector fields
            SearchField(
                name="description_vector",
                type=SearchFieldDataType.Collection(SearchFieldDataType.Single),
                searchable=True,
                vector_search_dimensions=self.settings.text_embedding_dimensions,
                vector_search_profile_name="vector-profile-description"
            ),
            SearchField(
                name="image_vector",
                type=SearchFieldDataType.Collection(SearchFieldDataType.Single),
                searchable=True,
                vector_search_dimensions=self.settings.image_embedding_dimensions,
                vector_search_profile_name="vector-profile-image"
            ),
            
            # Timestamps
            SimpleField(name="indexed_at", type=SearchFieldDataType.DateTimeOffset, filterable=True, sortable=True),
            SimpleField(name="modified_at", type=SearchFieldDataType.DateTimeOffset, filterable=True, sortable=True),
            
            # Image dimensions
            SimpleField(name="width", type=SearchFieldDataType.Int32, filterable=True, sortable=True),
            SimpleField(name="height", type=SearchFieldDataType.Int32, filterable=True, sortable=True),
        ]
        
        return SearchIndex(
            name=self.settings.azure_search_index_name,
            fields=fields,
            vector_search=vector_search,
            semantic_search=semantic_search
        )
    
    async def index_exists(self) -> bool:
        """Check if the search index exists."""
        try:
            self.index_client.get_index(self.settings.azure_search_index_name)
            return True
        except Exception:
            return False
    
    async def create_index_if_not_exists(self) -> bool:
        """
        Create the search index only if it doesn't exist.
        
        Returns:
            True if index was created, False if it already existed
        """
        if await self.index_exists():
            self.logger.info("Search index already exists", index_name=self.settings.azure_search_index_name)
            return False
        
        await self.create_index()
        return True
    
    async def create_index(self) -> None:
        """Create a new search index (fails if exists)."""
        self.logger.info("Creating search index", index_name=self.settings.azure_search_index_name)
        
        try:
            index_definition = self._create_index_definition()
            self.index_client.create_index(index_definition)
            self.logger.info("Search index created successfully")
        except Exception as e:
            self.logger.error("Failed to create search index", error=str(e))
            raise
    
    async def create_or_update_index(self) -> None:
        """Create or update the search index."""
        self.logger.info("Creating/updating search index", index_name=self.settings.azure_search_index_name)
        
        try:
            index_definition = self._create_index_definition()
            self.index_client.create_or_update_index(index_definition)
            self.logger.info("Search index created/updated successfully")
        except Exception as e:
            self.logger.error("Failed to create/update search index", error=str(e))
            raise
    
    async def delete_index(self) -> bool:
        """
        Delete the search index.
        
        Returns:
            True if deleted, False if it didn't exist
        """
        self.logger.info("Deleting search index", index_name=self.settings.azure_search_index_name)
        
        try:
            if not await self.index_exists():
                self.logger.info("Index does not exist, nothing to delete")
                return False
            
            self.index_client.delete_index(self.settings.azure_search_index_name)
            self.logger.info("Search index deleted successfully")
            return True
        except Exception as e:
            self.logger.error("Failed to delete search index", error=str(e))
            raise
    
    async def recreate_index(self) -> None:
        """Delete and recreate the search index (clears all data)."""
        self.logger.info("Recreating search index", index_name=self.settings.azure_search_index_name)
        
        await self.delete_index()
        await self.create_index()
        
        self.logger.info("Search index recreated successfully")
    
    async def clear_all_documents(self) -> int:
        """
        Clear all documents from the index without deleting the index itself.
        
        Returns:
            Number of documents deleted
        """
        self.logger.info("Clearing all documents from index", index_name=self.settings.azure_search_index_name)
        
        try:
            # Get all document IDs
            results = self.search_client.search(
                search_text="*",
                select=["id"],
                top=1000  # Process in batches
            )
            
            total_deleted = 0
            batch = []
            
            for doc in results:
                batch.append({"id": doc["id"]})
                
                if len(batch) >= 100:
                    self.search_client.delete_documents(documents=batch)
                    total_deleted += len(batch)
                    batch = []
            
            # Delete remaining
            if batch:
                self.search_client.delete_documents(documents=batch)
                total_deleted += len(batch)
            
            self.logger.info("Documents cleared", count=total_deleted)
            return total_deleted
            
        except Exception as e:
            self.logger.error("Failed to clear documents", error=str(e))
            raise
    
    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=2, max=10)
    )
    async def upload_documents(self, documents: list[ImageDocument]) -> dict:
        """
        Upload documents to the search index.
        
        Args:
            documents: List of ImageDocument objects
            
        Returns:
            Upload result summary
        """
        if not documents:
            return {"uploaded": 0, "failed": 0}
        
        self.logger.info("Uploading documents to search index", count=len(documents))
        
        try:
            # Convert to search documents
            search_docs = [doc.to_search_document() for doc in documents]
            
            result = self.search_client.upload_documents(documents=search_docs)
            
            succeeded = sum(1 for r in result if r.succeeded)
            failed = len(result) - succeeded
            
            self.logger.info("Document upload complete", succeeded=succeeded, failed=failed)
            
            return {"uploaded": succeeded, "failed": failed}
            
        except Exception as e:
            self.logger.error("Document upload failed", error=str(e))
            raise
    
    async def delete_document(self, document_id: str) -> bool:
        """Delete a document from the index."""
        try:
            self.search_client.delete_documents(documents=[{"id": document_id}])
            self.logger.info("Document deleted", document_id=document_id)
            return True
        except Exception as e:
            self.logger.error("Document deletion failed", error=str(e), document_id=document_id)
            return False
    
    async def get_document_count(self) -> int:
        """Get the total number of documents in the index."""
        try:
            return self.search_client.get_document_count()
        except Exception:
            return 0
