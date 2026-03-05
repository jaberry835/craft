"""Azure Computer Vision analyzer for image analysis (v3.2 API)."""

import io
import structlog
from azure.cognitiveservices.vision.computervision import ComputerVisionClient
from azure.cognitiveservices.vision.computervision.models import VisualFeatureTypes
from msrest.authentication import CognitiveServicesCredentials
from tenacity import retry, stop_after_attempt, wait_exponential

from ..config import Settings
from ..models import ImageAnalysisResult, DetectedObject, BoundingBox

logger = structlog.get_logger()


class ComputerVisionAnalyzer:
    """Analyzer using Azure Computer Vision v3.2 for rich image analysis."""
    
    def __init__(self, settings: Settings):
        """Initialize the Computer Vision client."""
        self.settings = settings
        self.logger = logger.bind(component="computer_vision")
        
        if not settings.azure_cv_key:
            raise ValueError("AZURE_CV_KEY is required for Computer Vision v3.2")
        
        self.logger.info("CV endpoint configured (v3.2)", endpoint=settings.azure_cv_endpoint)
        self.client = ComputerVisionClient(
            endpoint=settings.azure_cv_endpoint,
            credentials=CognitiveServicesCredentials(settings.azure_cv_key)
        )
    
    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=2, max=10)
    )
    async def analyze_image(self, image_data: bytes) -> ImageAnalysisResult:
        """
        Analyze an image using Azure Computer Vision v3.2.
        
        Args:
            image_data: Raw image bytes
            
        Returns:
            ImageAnalysisResult with all extracted features
        """
        self.logger.info("Analyzing image with Computer Vision v3.2")
        
        try:
            stream = io.BytesIO(image_data)
            
            result = self.client.analyze_image_in_stream(
                image=stream,
                visual_features=[
                    VisualFeatureTypes.description,
                    VisualFeatureTypes.tags,
                    VisualFeatureTypes.objects,
                    VisualFeatureTypes.categories,
                ]
            )
            
            # Extract caption from description
            caption = None
            caption_confidence = None
            dense_captions = []
            if result.description:
                if result.description.captions:
                    caption = result.description.captions[0].text
                    caption_confidence = result.description.captions[0].confidence
                    dense_captions = [c.text for c in result.description.captions]
            
            # Extract tags
            tags = []
            if result.tags:
                tags = [tag.name for tag in result.tags if tag.confidence > 0.5]
            
            # Extract objects
            objects = []
            if result.objects:
                for obj in result.objects:
                    bbox = None
                    if obj.rectangle:
                        bbox = BoundingBox(
                            x=obj.rectangle.x,
                            y=obj.rectangle.y,
                            width=obj.rectangle.w,
                            height=obj.rectangle.h
                        )
                    objects.append(DetectedObject(
                        name=obj.object_property,
                        confidence=obj.confidence,
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
        Analyze an image from URL using Azure Computer Vision v3.2.
        
        Args:
            image_url: Public URL of the image
            
        Returns:
            ImageAnalysisResult with all extracted features
        """
        self.logger.info("Analyzing image from URL", url=image_url)
        
        try:
            result = self.client.analyze_image(
                url=image_url,
                visual_features=[
                    VisualFeatureTypes.description,
                    VisualFeatureTypes.tags,
                    VisualFeatureTypes.objects,
                    VisualFeatureTypes.categories,
                ]
            )
            
            caption = None
            caption_confidence = None
            dense_captions = []
            if result.description:
                if result.description.captions:
                    caption = result.description.captions[0].text
                    caption_confidence = result.description.captions[0].confidence
                    dense_captions = [c.text for c in result.description.captions]
            
            tags = [tag.name for tag in result.tags if tag.confidence > 0.5] if result.tags else []
            
            objects = []
            if result.objects:
                for obj in result.objects:
                    bbox = None
                    if obj.rectangle:
                        bbox = BoundingBox(
                            x=obj.rectangle.x,
                            y=obj.rectangle.y,
                            width=obj.rectangle.w,
                            height=obj.rectangle.h
                        )
                    objects.append(DetectedObject(
                        name=obj.object_property,
                        confidence=obj.confidence,
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
