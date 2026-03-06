"""Azure Computer Vision analyzer for image analysis (v3.2 API)."""

import io
import structlog
from PIL import Image
from azure.cognitiveservices.vision.computervision import ComputerVisionClient
from azure.cognitiveservices.vision.computervision.models import VisualFeatureTypes
from msrest.authentication import CognitiveServicesCredentials
from tenacity import retry, stop_after_attempt, wait_exponential

from ..config import Settings, get_azure_credential
from ..models import ImageAnalysisResult, DetectedObject, BoundingBox

logger = structlog.get_logger()

# Azure CV v3.2 stream endpoint accepts a maximum of 4 MB.
_CV_MAX_BYTES = 4 * 1024 * 1024  # 4 MB


class _AzureIdentityCredentialAdapter:
    """Wraps azure.identity credentials for msrest-based SDKs (track 1).

    The v3.2 ComputerVisionClient uses msrest which expects a credential with
    a ``signed_session`` method.  This adapter bridges ``azure.identity``
    credentials (e.g. DefaultAzureCredential / AzureCliCredential) so they
    can be used in place of ``CognitiveServicesCredentials``.
    """

    def __init__(self, credential, resource_id: str = "https://cognitiveservices.azure.com/.default"):
        self._credential = credential
        self._resource_id = resource_id

    def signed_session(self, session=None):
        """Return a requests.Session with a fresh Bearer token."""
        import requests as _requests
        if session is None:
            session = _requests.Session()
        token = self._credential.get_token(self._resource_id)
        session.headers["Authorization"] = f"Bearer {token.token}"
        return session


def _get_cv_credentials(settings: Settings):
    """Build credentials for the v3.2 ComputerVisionClient.

    Uses the API key when available; otherwise falls back to
    DefaultAzureCredential (which includes AzureCliCredential for local dev).
    """
    if settings.azure_cv_key:
        logger.info("Using API key for Computer Vision")
        return CognitiveServicesCredentials(settings.azure_cv_key)

    credential = get_azure_credential()
    if credential:
        logger.info("Using DefaultAzureCredential (CLI) for Computer Vision")
        return _AzureIdentityCredentialAdapter(credential)

    raise ValueError(
        "No valid credential for Computer Vision v3.2. "
        "Provide AZURE_CV_KEY or ensure 'az login' has been run."
    )


class ComputerVisionAnalyzer:
    """Analyzer using Azure Computer Vision v3.2 for rich image analysis."""
    
    def __init__(self, settings: Settings):
        """Initialize the Computer Vision client."""
        self.settings = settings
        self.logger = logger.bind(component="computer_vision")
        
        credentials = _get_cv_credentials(settings)
        
        self.logger.info("CV endpoint configured (v3.2)", endpoint=settings.azure_cv_endpoint)
        self.client = ComputerVisionClient(
            endpoint=settings.azure_cv_endpoint,
            credentials=credentials,
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
        image_data = self._ensure_within_size_limit(image_data)
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

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _ensure_within_size_limit(self, image_data: bytes) -> bytes:
        """Downscale the image if it exceeds the CV v3.2 4 MB stream limit.

        Progressively reduces quality (JPEG) and then resolution until the
        payload fits.  Returns the original bytes when already under the limit.
        """
        if len(image_data) <= _CV_MAX_BYTES:
            return image_data

        img = Image.open(io.BytesIO(image_data))
        fmt = img.format or "JPEG"
        # Always re-encode as JPEG for size efficiency
        if fmt.upper() in ("PNG", "BMP", "TIFF"):
            fmt = "JPEG"
            if img.mode in ("RGBA", "P", "LA"):
                img = img.convert("RGB")

        # Try reducing JPEG quality first (95 → 80 → 60)
        for quality in (95, 80, 60):
            buf = io.BytesIO()
            img.save(buf, format=fmt, quality=quality)
            data = buf.getvalue()
            if len(data) <= _CV_MAX_BYTES:
                self.logger.info(
                    "Image resized for CV",
                    original_bytes=len(image_data),
                    new_bytes=len(data),
                    method=f"quality={quality}",
                )
                return data

        # Still too large — progressively halve the resolution
        current = img
        for _ in range(5):
            w, h = current.size
            current = current.resize((w // 2, h // 2), Image.LANCZOS)
            buf = io.BytesIO()
            current.save(buf, format="JPEG", quality=80)
            data = buf.getvalue()
            if len(data) <= _CV_MAX_BYTES:
                self.logger.info(
                    "Image resized for CV",
                    original_bytes=len(image_data),
                    new_bytes=len(data),
                    new_dimensions=f"{current.size[0]}x{current.size[1]}",
                    method="resolution_reduce",
                )
                return data

        # Last resort — return whatever we have; the API will reject it
        self.logger.warning(
            "Could not shrink image below 4 MB",
            final_bytes=len(data),
        )
        return data
