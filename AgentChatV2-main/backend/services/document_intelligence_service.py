"""
Document Intelligence Service
Azure AI Document Intelligence integration for rich document extraction.

Uses the Layout model to extract structured text (paragraphs, tables, headings,
reading order) from PDFs, scanned images, Office documents, and more.

Authentication:
- Uses API key if AZURE_DOCUMENT_INTELLIGENCE_KEY is provided
- Otherwise uses managed identity (AzureCliCredential for dev, ManagedIdentityCredential for prod)
"""
import asyncio
import io
from typing import Optional

from azure.core.credentials import AzureKeyCredential
from azure.ai.documentintelligence import DocumentIntelligenceClient
from azure.ai.documentintelligence.models import (
    AnalyzeDocumentRequest,
    AnalyzeResult,
    DocumentContentFormat,
)

from config import get_settings, get_azure_credential
from observability import get_logger

settings = get_settings()
logger = get_logger(__name__)


class DocumentIntelligenceService:
    """
    Azure AI Document Intelligence service for structured document extraction.

    Extracts text with layout awareness: reading order, headings, tables,
    and paragraph boundaries. Produces Markdown output that preserves
    document structure for better RAG chunking and retrieval.
    """

    # File extensions that Document Intelligence handles well
    SUPPORTED_EXTENSIONS = {
        '.pdf', '.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.tif',
        '.docx', '.xlsx', '.pptx', '.html', '.htm',
    }

    def __init__(self):
        self._client: Optional[DocumentIntelligenceClient] = None
        self._initialized = False

    async def initialize(self) -> None:
        """Initialize Document Intelligence client with key or managed identity."""
        if self._initialized:
            return

        if not settings.document_intelligence_endpoint:
            logger.warning(
                "Azure Document Intelligence endpoint not configured — "
                "DI features disabled. Set AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT to enable."
            )
            self._initialized = True
            return

        try:
            # Build kwargs for the client — audience + credential_scopes needed for sovereign clouds
            # Derive from the cognitive services scope setting:
            #   Gov:  "https://cognitiveservices.azure.us/.default" → audience "https://cognitiveservices.azure.us"
            #   Com:  "https://cognitiveservices.azure.com/.default" → audience "https://cognitiveservices.azure.com"
            client_kwargs = {}
            if settings.document_intelligence_key:
                logger.info("Using Document Intelligence with API key")
                credential = AzureKeyCredential(settings.document_intelligence_key)
            else:
                credential = get_azure_credential()
                env_mode = "dev" if settings.environment == "development" else "prod"
                logger.info(
                    f"Using Document Intelligence with {type(credential).__name__} ({env_mode} mode)"
                )
                # Set audience and credential_scopes so the SDK requests the
                # correct token for the target cloud (commercial vs government)
                scope = settings.azure_cognitive_services_scope  # e.g. "https://cognitiveservices.azure.us/.default"
                audience = scope.removesuffix("/.default")
                client_kwargs["audience"] = audience
                client_kwargs["credential_scopes"] = [scope]
                logger.info(f"Document Intelligence audience: {audience}")

            self._client = DocumentIntelligenceClient(
                endpoint=settings.document_intelligence_endpoint,
                credential=credential,
                **client_kwargs,
            )

            logger.info(
                f"Document Intelligence initialized: endpoint={settings.document_intelligence_endpoint}"
            )
        except Exception as e:
            logger.error(f"Document Intelligence initialization failed: {e}")
            # Don't raise — fall back to local parsers gracefully
        finally:
            self._initialized = True

    @property
    def is_available(self) -> bool:
        """True when the DI client is ready to use."""
        return self._client is not None

    def supports_file(self, filename: str) -> bool:
        """Check whether DI can process this file type."""
        ext = ('.' + filename.rsplit('.', 1)[-1].lower()) if '.' in filename else ''
        return ext in self.SUPPORTED_EXTENSIONS

    # ------------------------------------------------------------------
    # Core extraction
    # ------------------------------------------------------------------

    async def extract_text(self, content: bytes, filename: str) -> Optional[str]:
        """
        Extract structured text from a document using the Layout model.

        Returns Markdown-formatted text preserving headings, paragraphs,
        tables, and reading order. Returns None if DI is unavailable or
        the file type is unsupported, allowing callers to fall back to
        local parsers.

        Args:
            content: Raw file bytes.
            filename: Original filename (used to detect content type).

        Returns:
            Markdown string, or None on failure / unavailability.
        """
        if not self.is_available:
            return None

        if not self.supports_file(filename):
            logger.debug(f"DI does not support file type: {filename}")
            return None

        try:
            # Run the synchronous SDK call in a thread to avoid blocking the event loop
            loop = asyncio.get_event_loop()
            result: AnalyzeResult = await loop.run_in_executor(
                None,
                self._analyze_document,
                content,
            )

            if not result or not result.content:
                logger.warning(f"DI returned empty content for {filename}")
                return None

            # The Layout model with Markdown output format returns structured
            # Markdown in result.content (headings, tables, paragraphs).
            text = result.content.strip()

            logger.info(
                f"DI extracted {len(text)} chars from {filename} "
                f"({result.pages and len(result.pages) or 0} pages, "
                f"{result.tables and len(result.tables) or 0} tables)"
            )
            return text

        except Exception as e:
            logger.error(f"Document Intelligence extraction failed for {filename}: {e}")
            return None

    def _analyze_document(self, content: bytes) -> AnalyzeResult:
        """
        Synchronous wrapper around the DI analyze API.
        Called via run_in_executor from the async extract_text method.
        """
        poller = self._client.begin_analyze_document(
            model_id="prebuilt-layout",
            body=AnalyzeDocumentRequest(bytes_source=content),
            output_content_format=DocumentContentFormat.MARKDOWN,
        )
        return poller.result()

    # ------------------------------------------------------------------
    # Convenience: extract with fallback
    # ------------------------------------------------------------------

    async def extract_text_or_none(self, content: bytes, filename: str) -> Optional[str]:
        """
        Try DI extraction; return None silently on any failure.
        Callers should fall back to their local parser when None is returned.
        """
        try:
            return await self.extract_text(content, filename)
        except Exception:
            return None


# Global singleton
document_intelligence_service = DocumentIntelligenceService()
