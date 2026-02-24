"""
Embedding Service
Generates embeddings using Azure OpenAI for document indexing and search.
Uses AzureCliCredential for local dev, DefaultAzureCredential for production.
"""
from typing import Optional, Union
import time

from openai import AzureOpenAI

from config import get_settings, get_azure_credential
from observability import get_logger, track_performance, should_log_performance, log_performance_summary, MetricType

settings = get_settings()
logger = get_logger(__name__)


class EmbeddingService:
    """Service for generating text embeddings."""
    
    def __init__(self):
        self.client: Optional[AzureOpenAI] = None
        self._credential = None
        self._initialized = False
    
    async def initialize(self) -> None:
        """Initialize the embedding client - uses AzureCliCredential for dev, DefaultAzureCredential for prod."""
        try:
            if not settings.azure_openai_endpoint:
                logger.warning("Azure OpenAI endpoint not configured - embeddings disabled")
                return
            
            # Use API key if explicitly provided (for testing or specific scenarios)
            if settings.azure_openai_key:
                logger.info("Using Azure OpenAI with API key")
                self.client = AzureOpenAI(
                    azure_endpoint=settings.azure_openai_endpoint,
                    api_version=settings.azure_openai_api_version,
                    api_key=settings.azure_openai_key
                )
            else:
                # Use centralized credential helper (AzureCliCredential for dev, ManagedIdentityCredential for prod)
                self._credential = get_azure_credential()
                env_mode = "dev" if settings.environment == "development" else "prod"
                logger.info(f"Using Azure OpenAI with {type(self._credential).__name__} ({env_mode} mode)")
                
                # Create client with token provider for automatic token refresh
                self.client = AzureOpenAI(
                    azure_endpoint=settings.azure_openai_endpoint,
                    api_version=settings.azure_openai_api_version,
                    azure_ad_token_provider=self._get_token_provider()
                )
            
            self._initialized = True
            logger.info(f"Embedding service initialized: "
                        f"endpoint={settings.azure_openai_endpoint}, "
                        f"deployment={settings.azure_openai_embedding_deployment}, "
                        f"api_version={settings.azure_openai_api_version}")
        except Exception as e:
            logger.error(f"Embedding service initialization failed: {e}")
            raise
    
    def _get_token_provider(self):
        """Get a token provider function for Azure OpenAI.
        
        Uses the configured cognitive services scope from settings.
        Azure Commercial: https://cognitiveservices.azure.com/.default
        Azure Government: https://cognitiveservices.azure.us/.default
        """
        scope = settings.azure_cognitive_services_scope
        
        def get_token() -> str:
            token = self._credential.get_token(scope)
            return token.token
        
        return get_token
    
    @track_performance("embedding_generate", MetricType.AOAI_EMBEDDING)
    async def generate_embedding(self, text: str) -> list[float]:
        """Generate embedding for a single text with performance tracking."""
        if not self._initialized:
            logger.warning("Embedding service not initialized - returning empty embedding")
            return []
        
        start_time = time.perf_counter()
        
        # Log the AOAI call details for debugging 404 errors
        logger.info(f"[AOAI-EMBEDDING] Calling embedding API: "
                    f"endpoint={settings.azure_openai_endpoint}, "
                    f"deployment={settings.azure_openai_embedding_deployment}, "
                    f"text_length={len(text)}")
        
        try:
            response = self.client.embeddings.create(
                input=text,
                model=settings.azure_openai_embedding_deployment
            )
        except Exception as e:
            logger.error(f"[AOAI-EMBEDDING] Embedding API call failed: "
                         f"endpoint={settings.azure_openai_endpoint}, "
                         f"deployment={settings.azure_openai_embedding_deployment}, "
                         f"error={e}")
            raise
        
        duration_ms = (time.perf_counter() - start_time) * 1000
        tokens_used = getattr(response.usage, 'total_tokens', 0) if hasattr(response, 'usage') else 0
        
        if should_log_performance():
            log_performance_summary(logger, "aoai_embedding_single", {
                "duration_ms": round(duration_ms, 2),
                "tokens_used": tokens_used,
                "text_length": len(text),
                "deployment": settings.azure_openai_embedding_deployment
            })
        
        return response.data[0].embedding
    
    @track_performance("embedding_generate_batch", MetricType.AOAI_EMBEDDING)
    async def generate_embeddings(self, texts: list[str]) -> list[list[float]]:
        """Generate embeddings for multiple texts with performance tracking."""
        if not self._initialized:
            return []
        
        start_time = time.perf_counter()
        
        response = self.client.embeddings.create(
            input=texts,
            model=settings.azure_openai_embedding_deployment
        )
        
        duration_ms = (time.perf_counter() - start_time) * 1000
        tokens_used = getattr(response.usage, 'total_tokens', 0) if hasattr(response, 'usage') else 0
        
        if should_log_performance():
            log_performance_summary(logger, "aoai_embedding_batch", {
                "duration_ms": round(duration_ms, 2),
                "tokens_used": tokens_used,
                "batch_size": len(texts),
                "avg_text_length": sum(len(t) for t in texts) / len(texts) if texts else 0,
                "deployment": settings.azure_openai_embedding_deployment
            })
        
        return [item.embedding for item in response.data]
    
    async def chunk_and_embed(
        self,
        text: str,
        chunk_size: int = 1000,
        overlap: int = 200
    ) -> list[tuple[str, list[float]]]:
        """
        Chunk text and generate embeddings for each chunk.
        
        Returns: List of (chunk_text, embedding) tuples
        """
        chunks = self._chunk_text(text, chunk_size, overlap)
        embeddings = await self.generate_embeddings(chunks)
        
        return list(zip(chunks, embeddings))
    
    def _chunk_text(
        self,
        text: str,
        chunk_size: int,
        overlap: int
    ) -> list[str]:
        """Split text into overlapping chunks."""
        if len(text) <= chunk_size:
            return [text]
        
        chunks = []
        start = 0
        
        while start < len(text):
            end = start + chunk_size
            
            # Try to break at sentence boundary
            if end < len(text):
                last_period = text.rfind(".", start, end)
                if last_period > start + chunk_size // 2:
                    end = last_period + 1
            
            chunks.append(text[start:end].strip())
            start = end - overlap
        
        return chunks


# Global instance
embedding_service = EmbeddingService()
