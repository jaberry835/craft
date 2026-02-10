"""Image embedding generator using imgbeddings/CLIP."""

import structlog
from PIL import Image
import io
from tenacity import retry, stop_after_attempt, wait_exponential

from ..config import Settings

logger = structlog.get_logger()


class ImageEmbeddingGenerator:
    """Generate image embeddings directly from images using imgbeddings."""
    
    def __init__(self, settings: Settings):
        """Initialize the image embedding model."""
        self.settings = settings
        self.enabled = settings.enable_image_embeddings
        self.dimensions = settings.image_embedding_dimensions
        self._model = None
        self.logger = logger.bind(component="image_embedding")
    
    def _get_model(self):
        """Lazy load the imgbeddings model."""
        if self._model is None and self.enabled:
            try:
                from imgbeddings import imgbeddings
                self._model = imgbeddings()
                self.logger.info("Image embedding model loaded")
            except Exception as e:
                self.logger.error("Failed to load image embedding model", error=str(e))
                self.enabled = False
        return self._model
    
    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=2, max=10)
    )
    async def generate_embedding(self, image_data: bytes) -> list[float] | None:
        """
        Generate embedding vector directly from image.
        
        Args:
            image_data: Raw image bytes
            
        Returns:
            List of floats representing the embedding vector, or None if disabled
        """
        if not self.enabled:
            self.logger.debug("Image embeddings disabled")
            return None
        
        model = self._get_model()
        if model is None:
            return None
        
        self.logger.debug("Generating image embedding")
        
        try:
            # Convert bytes to PIL Image
            image = Image.open(io.BytesIO(image_data))
            
            # Convert to RGB if necessary
            if image.mode != "RGB":
                image = image.convert("RGB")
            
            # Generate embedding
            embedding = model.to_embeddings(image)
            
            # Convert numpy array to list
            embedding_list = embedding[0].tolist()
            
            self.logger.debug("Image embedding generated", vector_length=len(embedding_list))
            
            return embedding_list
            
        except Exception as e:
            self.logger.error("Image embedding generation failed", error=str(e))
            return None
    
    async def generate_embedding_from_path(self, image_path: str) -> list[float] | None:
        """
        Generate embedding from an image file path.
        
        Args:
            image_path: Path to the image file
            
        Returns:
            List of floats representing the embedding vector, or None if disabled
        """
        if not self.enabled:
            return None
        
        model = self._get_model()
        if model is None:
            return None
        
        try:
            image = Image.open(image_path)
            
            if image.mode != "RGB":
                image = image.convert("RGB")
            
            embedding = model.to_embeddings(image)
            return embedding[0].tolist()
            
        except Exception as e:
            self.logger.error("Image embedding from path failed", error=str(e), path=image_path)
            return None
    
    async def generate_embeddings_batch(self, images_data: list[bytes]) -> list[list[float] | None]:
        """
        Generate embeddings for multiple images.
        
        Args:
            images_data: List of raw image bytes
            
        Returns:
            List of embedding vectors (or None for failed images)
        """
        if not self.enabled:
            return [None] * len(images_data)
        
        model = self._get_model()
        if model is None:
            return [None] * len(images_data)
        
        self.logger.info("Generating batch image embeddings", count=len(images_data))
        
        embeddings = []
        for image_data in images_data:
            try:
                image = Image.open(io.BytesIO(image_data))
                if image.mode != "RGB":
                    image = image.convert("RGB")
                embedding = model.to_embeddings(image)
                embeddings.append(embedding[0].tolist())
            except Exception as e:
                self.logger.warning("Failed to embed image in batch", error=str(e))
                embeddings.append(None)
        
        return embeddings
