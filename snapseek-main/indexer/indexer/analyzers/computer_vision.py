"""Azure Computer Vision analyzer for image analysis."""

import structlog
from azure.ai.vision.imageanalysis import ImageAnalysisClient
from azure.ai.vision.imageanalysis.models import VisualFeatures
from tenacity import retry, stop_after_attempt, wait_exponential

from ..config import Settings, get_cognitive_credential
from ..models import ImageAnalysisResult, DetectedObject, BoundingBox

logger = structlog.get_logger()


class ComputerVisionAnalyzer:
    """Analyzer using Azure Computer Vision 4.0 for rich image analysis."""
    
    def __init__(self, settings: Settings):
        """Initialize the Computer Vision client."""
        self.settings = settings
        self.client = ImageAnalysisClient(
            endpoint=settings.azure_cv_endpoint,
            credential=get_cognitive_credential(settings, settings.azure_cv_key)
        )
        self.logger = logger.bind(component="computer_vision")
    
    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=2, max=10)
    )
    async def analyze_image(self, image_data: bytes) -> ImageAnalysisResult:
        """
        Analyze an image using Azure Computer Vision.
        
        Args:
            image_data: Raw image bytes
            
        Returns:
            ImageAnalysisResult with all extracted features
        """
        self.logger.info("Analyzing image with Computer Vision")
        
        try:
            # Request all visual features
            result = self.client.analyze(
                image_data=image_data,
                visual_features=[
                    VisualFeatures.CAPTION,
                    VisualFeatures.DENSE_CAPTIONS,
                    VisualFeatures.TAGS,
                    VisualFeatures.OBJECTS,
                    VisualFeatures.SMART_CROPS,
                    VisualFeatures.PEOPLE,
                    VisualFeatures.READ,
                ]
            )
            
            # Extract caption
            caption = None
            caption_confidence = None
            if result.caption:
                caption = result.caption.text
                caption_confidence = result.caption.confidence
            
            # Extract dense captions
            dense_captions = []
            if result.dense_captions:
                dense_captions = [dc.text for dc in result.dense_captions.list]
            
            # Extract tags
            tags = []
            if result.tags:
                tags = [tag.name for tag in result.tags.list if tag.confidence > 0.5]
            
            # Extract objects
            objects = []
            if result.objects:
                for obj in result.objects.list:
                    bbox = None
                    if obj.bounding_box:
                        bbox = BoundingBox(
                            x=obj.bounding_box.x,
                            y=obj.bounding_box.y,
                            width=obj.bounding_box.width,
                            height=obj.bounding_box.height
                        )
                    objects.append(DetectedObject(
                        name=obj.tags[0].name if obj.tags else "unknown",
                        confidence=obj.tags[0].confidence if obj.tags else 0.0,
                        bounding_box=bbox
                    ))
            
            # Get metadata
            metadata = {}
            if result.metadata:
                metadata = {
                    "width": result.metadata.width,
                    "height": result.metadata.height
                }
            
            analysis_result = ImageAnalysisResult(
                caption=caption,
                caption_confidence=caption_confidence,
                dense_captions=dense_captions,
                tags=tags,
                objects=objects,
                metadata=metadata
            )
            
            self.logger.info(
                "Image analysis complete",
                caption=caption,
                tag_count=len(tags),
                object_count=len(objects)
            )
            
            return analysis_result
            
        except Exception as e:
            self.logger.error("Computer Vision analysis failed", error=str(e))
            raise
    
    async def analyze_image_from_url(self, image_url: str) -> ImageAnalysisResult:
        """
        Analyze an image from URL using Azure Computer Vision.
        
        Args:
            image_url: Public URL of the image
            
        Returns:
            ImageAnalysisResult with all extracted features
        """
        self.logger.info("Analyzing image from URL", url=image_url)
        
        try:
            result = self.client.analyze_from_url(
                image_url=image_url,
                visual_features=[
                    VisualFeatures.CAPTION,
                    VisualFeatures.DENSE_CAPTIONS,
                    VisualFeatures.TAGS,
                    VisualFeatures.OBJECTS,
                    VisualFeatures.SMART_CROPS,
                    VisualFeatures.PEOPLE,
                    VisualFeatures.READ,
                ]
            )
            
            # Process results same as above
            caption = result.caption.text if result.caption else None
            caption_confidence = result.caption.confidence if result.caption else None
            dense_captions = [dc.text for dc in result.dense_captions.list] if result.dense_captions else []
            tags = [tag.name for tag in result.tags.list if tag.confidence > 0.5] if result.tags else []
            
            objects = []
            if result.objects:
                for obj in result.objects.list:
                    bbox = None
                    if obj.bounding_box:
                        bbox = BoundingBox(
                            x=obj.bounding_box.x,
                            y=obj.bounding_box.y,
                            width=obj.bounding_box.width,
                            height=obj.bounding_box.height
                        )
                    objects.append(DetectedObject(
                        name=obj.tags[0].name if obj.tags else "unknown",
                        confidence=obj.tags[0].confidence if obj.tags else 0.0,
                        bounding_box=bbox
                    ))
            
            metadata = {}
            if result.metadata:
                metadata = {
                    "width": result.metadata.width,
                    "height": result.metadata.height
                }
            
            return ImageAnalysisResult(
                caption=caption,
                caption_confidence=caption_confidence,
                dense_captions=dense_captions,
                tags=tags,
                objects=objects,
                metadata=metadata
            )
            
        except Exception as e:
            self.logger.error("Computer Vision URL analysis failed", error=str(e))
            raise
