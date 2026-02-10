"""Text embedding generator using Azure OpenAI."""

import structlog
from openai import AzureOpenAI
from tenacity import retry, stop_after_attempt, wait_exponential

from ..config import Settings, get_openai_token_provider

logger = structlog.get_logger()


class TextEmbeddingGenerator:
    """Generate text embeddings using Azure OpenAI."""
    
    def __init__(self, settings: Settings):
        """Initialize the OpenAI client."""
        self.settings = settings
        
        # Try identity-based auth first, fall back to API key
        token_provider = get_openai_token_provider()
        if token_provider:
            logger.info("Using DefaultAzureCredential for Azure OpenAI embeddings")
            self.client = AzureOpenAI(
                azure_endpoint=settings.azure_openai_endpoint,
                azure_ad_token_provider=token_provider,
                api_version=settings.azure_openai_api_version
            )
        elif settings.azure_openai_key:
            logger.info("Using API key for Azure OpenAI embeddings")
            self.client = AzureOpenAI(
                azure_endpoint=settings.azure_openai_endpoint,
                api_key=settings.azure_openai_key,
                api_version=settings.azure_openai_api_version
            )
        else:
            raise ValueError("No valid credential available for Azure OpenAI")
        
        self.deployment = settings.azure_openai_embedding_deployment
        self.dimensions = settings.text_embedding_dimensions
        self.logger = logger.bind(component="text_embedding")
    
    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=2, max=10)
    )
    async def generate_embedding(self, text: str) -> list[float]:
        """
        Generate embedding vector for text.
        
        Args:
            text: Text to embed
            
        Returns:
            List of floats representing the embedding vector
        """
        if not text or not text.strip():
            self.logger.warning("Empty text provided for embedding")
            return [0.0] * self.dimensions
        
        self.logger.debug("Generating text embedding", text_length=len(text))
        
        try:
            response = self.client.embeddings.create(
                model=self.deployment,
                input=text[:8000],  # Truncate to avoid token limits
                dimensions=self.dimensions
            )
            
            embedding = response.data[0].embedding
            
            self.logger.debug("Text embedding generated", vector_length=len(embedding))
            
            return embedding
            
        except Exception as e:
            self.logger.error("Text embedding generation failed", error=str(e))
            raise
    
    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=2, max=10)
    )
    async def generate_embeddings_batch(self, texts: list[str]) -> list[list[float]]:
        """
        Generate embeddings for multiple texts in batch.
        
        Args:
            texts: List of texts to embed
            
        Returns:
            List of embedding vectors
        """
        if not texts:
            return []
        
        # Filter empty texts and truncate
        processed_texts = [t[:8000] if t and t.strip() else " " for t in texts]
        
        self.logger.info("Generating batch embeddings", count=len(texts))
        
        try:
            response = self.client.embeddings.create(
                model=self.deployment,
                input=processed_texts,
                dimensions=self.dimensions
            )
            
            # Sort by index to maintain order
            embeddings = [None] * len(texts)
            for item in response.data:
                embeddings[item.index] = item.embedding
            
            self.logger.info("Batch embeddings generated", count=len(embeddings))
            
            return embeddings
            
        except Exception as e:
            self.logger.error("Batch embedding generation failed", error=str(e))
            raise
    
    def build_rich_description(
        self,
        caption: str | None,
        dense_captions: list[str],
        tags: list[str],
        objects: list[str],
        extracted_text: str | None,
        face_count: int
    ) -> str:
        """
        Build a rich description from all image analysis data for embedding.
        
        Args:
            caption: Main image caption
            dense_captions: List of dense captions
            tags: List of detected tags
            objects: List of detected objects
            extracted_text: OCR extracted text
            face_count: Number of faces detected
            
        Returns:
            Combined rich description string
        """
        parts = []
        
        if caption:
            parts.append(f"This image shows: {caption}")
        
        if dense_captions:
            parts.append(f"Details: {'. '.join(dense_captions[:5])}")
        
        if tags:
            parts.append(f"Tags: {', '.join(tags[:20])}")
        
        if objects:
            unique_objects = list(set(objects))
            parts.append(f"Objects detected: {', '.join(unique_objects[:15])}")
        
        if extracted_text and extracted_text.strip():
            # Truncate long text
            text_preview = extracted_text[:500]
            parts.append(f"Text in image: {text_preview}")
        
        if face_count > 0:
            parts.append(f"Contains {face_count} {'person' if face_count == 1 else 'people'}")
        
        return " | ".join(parts) if parts else "Image with no detected features"
