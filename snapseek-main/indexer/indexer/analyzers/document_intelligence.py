"""Azure Document Intelligence analyzer for OCR text extraction."""

import structlog
from azure.ai.formrecognizer import DocumentAnalysisClient
from tenacity import retry, stop_after_attempt, wait_exponential

from ..config import Settings, get_cognitive_credential
from ..models import DocumentAnalysisResult, ExtractedText, BoundingBox

logger = structlog.get_logger()


class DocumentIntelligenceAnalyzer:
    """Analyzer using Azure Document Intelligence for OCR text extraction."""
    
    def __init__(self, settings: Settings):
        """Initialize the Document Intelligence client."""
        self.settings = settings
        self.client = DocumentAnalysisClient(
            endpoint=settings.azure_doc_intel_endpoint,
            credential=get_cognitive_credential(settings, settings.azure_doc_intel_key)
        )
        self.logger = logger.bind(component="document_intelligence")
    
    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=2, max=10)
    )
    async def extract_text(self, image_data: bytes) -> DocumentAnalysisResult:
        """
        Extract text from an image using Azure Document Intelligence.
        
        Args:
            image_data: Raw image bytes
            
        Returns:
            DocumentAnalysisResult with extracted text
        """
        self.logger.info("Extracting text with Document Intelligence")
        
        try:
            # Use the Read model for general text extraction
            poller = self.client.begin_analyze_document(
                model_id="prebuilt-read",
                document=image_data
            )
            result = poller.result()
            
            # Extract all text content
            all_text = []
            text_blocks = []
            
            for page in result.pages:
                for line in page.lines:
                    all_text.append(line.content)
                    
                    # Get bounding box if available
                    bbox = None
                    if line.polygon and len(line.polygon) >= 4:
                        # Convert polygon to bounding box
                        x_coords = [p.x for p in line.polygon]
                        y_coords = [p.y for p in line.polygon]
                        bbox = BoundingBox(
                            x=int(min(x_coords)),
                            y=int(min(y_coords)),
                            width=int(max(x_coords) - min(x_coords)),
                            height=int(max(y_coords) - min(y_coords))
                        )
                    
                    text_blocks.append(ExtractedText(
                        content=line.content,
                        confidence=1.0,  # Read model doesn't provide line-level confidence
                        bounding_box=bbox
                    ))
            
            # Combine all text
            extracted_text = "\n".join(all_text)
            
            # Get language if detected
            language = None
            if result.languages:
                language = result.languages[0].locale
            
            analysis_result = DocumentAnalysisResult(
                extracted_text=extracted_text,
                text_blocks=text_blocks,
                language=language,
                confidence=None
            )
            
            self.logger.info(
                "Text extraction complete",
                text_length=len(extracted_text),
                block_count=len(text_blocks)
            )
            
            return analysis_result
            
        except Exception as e:
            self.logger.error("Document Intelligence extraction failed", error=str(e))
            raise
    
    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=2, max=10)
    )
    async def extract_text_from_url(self, image_url: str) -> DocumentAnalysisResult:
        """
        Extract text from an image URL using Azure Document Intelligence.
        
        Args:
            image_url: Public URL of the image
            
        Returns:
            DocumentAnalysisResult with extracted text
        """
        self.logger.info("Extracting text from URL", url=image_url)
        
        try:
            poller = self.client.begin_analyze_document_from_url(
                model_id="prebuilt-read",
                document_url=image_url
            )
            result = poller.result()
            
            all_text = []
            text_blocks = []
            
            for page in result.pages:
                for line in page.lines:
                    all_text.append(line.content)
                    
                    bbox = None
                    if line.polygon and len(line.polygon) >= 4:
                        x_coords = [p.x for p in line.polygon]
                        y_coords = [p.y for p in line.polygon]
                        bbox = BoundingBox(
                            x=int(min(x_coords)),
                            y=int(min(y_coords)),
                            width=int(max(x_coords) - min(x_coords)),
                            height=int(max(y_coords) - min(y_coords))
                        )
                    
                    text_blocks.append(ExtractedText(
                        content=line.content,
                        confidence=1.0,
                        bounding_box=bbox
                    ))
            
            extracted_text = "\n".join(all_text)
            language = result.languages[0].locale if result.languages else None
            
            return DocumentAnalysisResult(
                extracted_text=extracted_text,
                text_blocks=text_blocks,
                language=language,
                confidence=None
            )
            
        except Exception as e:
            self.logger.error("Document Intelligence URL extraction failed", error=str(e))
            raise
