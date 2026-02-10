"""Azure Blob Storage service for retrieving images using identity auth."""

from datetime import datetime, timedelta, timezone
import structlog
from urllib.parse import urlparse, quote
from azure.storage.blob import BlobServiceClient, ContainerClient

from ..config import Settings, get_azure_credential

logger = structlog.get_logger()


class BlobService:
    """Service for retrieving blob storage images using identity-based authentication."""
    
    def __init__(self, settings: Settings):
        """Initialize the blob service."""
        self.settings = settings
        self.logger = logger.bind(component="blob_service")
        
        if settings.azure_storage_account:
            try:
                # Use cached credential for better performance
                self.credential = get_azure_credential()
                self.account_url = f"https://{settings.azure_storage_account}.blob.core.windows.net"
                self.blob_service_client = BlobServiceClient(
                    account_url=self.account_url,
                    credential=self.credential
                )
                self.enabled = True
                self.logger.info("Blob service initialized with identity auth", 
                               account=settings.azure_storage_account)
            except Exception as e:
                self.logger.error("Failed to initialize blob service", error=str(e))
                self.enabled = False
        else:
            self.enabled = False
            self.logger.warning("Blob service not configured - images may not be accessible")
    
    async def download_blob(self, container_name: str, blob_name: str) -> tuple[bytes, str]:
        """
        Download a blob using identity-based authentication.
        
        Args:
            container_name: The container name
            blob_name: The blob name/path
            
        Returns:
            Tuple of (blob_data, content_type)
        """
        if not self.enabled:
            raise ValueError("Blob service not configured")
        
        try:
            blob_client = self.blob_service_client.get_blob_client(
                container=container_name, 
                blob=blob_name
            )
            
            # Download the blob
            download_stream = blob_client.download_blob()
            blob_data = download_stream.readall()
            
            # Get content type from properties
            properties = blob_client.get_blob_properties()
            content_type = properties.content_settings.content_type or "application/octet-stream"
            
            # Infer content type from extension if not set
            if content_type == "application/octet-stream":
                ext = blob_name.lower().split('.')[-1] if '.' in blob_name else ''
                content_type_map = {
                    'jpg': 'image/jpeg',
                    'jpeg': 'image/jpeg',
                    'png': 'image/png',
                    'gif': 'image/gif',
                    'webp': 'image/webp',
                    'bmp': 'image/bmp',
                    'svg': 'image/svg+xml',
                }
                content_type = content_type_map.get(ext, 'application/octet-stream')
            
            self.logger.debug("Downloaded blob", container=container_name, blob=blob_name, size=len(blob_data))
            return blob_data, content_type
            
        except Exception as e:
            self.logger.error("Failed to download blob", error=str(e), container=container_name, blob=blob_name)
            raise
    
    def parse_blob_url(self, blob_url: str) -> tuple[str, str] | None:
        """
        Parse a blob URL into container and blob name.
        
        Args:
            blob_url: The original blob URL (e.g., https://account.blob.core.windows.net/container/blob.jpg)
            
        Returns:
            Tuple of (container_name, blob_name) or None if invalid
        """
        if not blob_url:
            return None
        
        try:
            parsed = urlparse(blob_url)
            path_parts = parsed.path.strip('/').split('/', 1)
            
            if len(path_parts) != 2:
                self.logger.warning("Invalid blob URL format", url=blob_url)
                return None
            
            return path_parts[0], path_parts[1]
            
        except Exception as e:
            self.logger.error("Failed to parse blob URL", error=str(e), url=blob_url)
            return None
    
    def get_proxy_url(self, blob_url: str, base_url: str = "/api/blob") -> str:
        """
        Convert a blob URL to a proxy URL that goes through our backend.
        
        Args:
            blob_url: The original blob URL
            base_url: The base URL for the proxy endpoint
            
        Returns:
            Proxy URL like /api/images/container/blob.jpg
        """
        parsed = self.parse_blob_url(blob_url)
        if not parsed:
            return blob_url
        
        container_name, blob_name = parsed
        # URL encode the blob name in case it has special characters
        encoded_blob = quote(blob_name, safe='/')
        return f"{base_url}/{container_name}/{encoded_blob}"
    
    def add_proxy_urls_to_results(self, results: list, url_field: str = "file_url", base_url: str = "/api/images") -> list:
        """
        Replace blob URLs with proxy URLs in a list of results.
        
        Args:
            results: List of result objects/dicts
            url_field: The field name containing the URL
            base_url: The base URL for the proxy endpoint
            
        Returns:
            Results with proxy URLs
        """
        for result in results:
            if hasattr(result, url_field):
                original_url = getattr(result, url_field)
                if original_url:
                    setattr(result, url_field, self.get_proxy_url(original_url, base_url))
            elif isinstance(result, dict) and url_field in result:
                if result[url_field]:
                    result[url_field] = self.get_proxy_url(result[url_field], base_url)
        
        return results
