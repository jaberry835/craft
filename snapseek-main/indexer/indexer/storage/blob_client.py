"""Azure Blob Storage client for reading images."""

import structlog
from azure.storage.blob import BlobServiceClient, ContainerClient
from azure.storage.blob.aio import BlobServiceClient as AsyncBlobServiceClient

from ..config import Settings, get_storage_credential

logger = structlog.get_logger()


class BlobStorageClient:
    """Client for reading images from Azure Blob Storage."""
    
    def __init__(self, settings: Settings):
        """Initialize the blob storage client."""
        self.settings = settings
        self.logger = logger.bind(component="blob_storage")
        
        if not settings.azure_storage_blob_url:
            raise ValueError("AZURE_STORAGE_BLOB_URL is required for blob storage operations")
        
        self.credential = get_storage_credential(settings)
        
        # Create async blob service client
        self._service_client = AsyncBlobServiceClient(
            account_url=settings.azure_storage_blob_url,
            credential=self.credential
        )
    
    def _get_container_client(self, container_name: str | None = None) -> ContainerClient:
        """Get a container client."""
        container = container_name or self.settings.azure_storage_container
        if not container:
            raise ValueError("Container name must be provided or set in AZURE_STORAGE_CONTAINER")
        
        return self._service_client.get_container_client(container)
    
    async def list_blobs(
        self,
        container_name: str | None = None,
        prefix: str | None = None,
        extensions: set[str] | None = None
    ) -> list[dict]:
        """
        List blobs in a container.
        
        Args:
            container_name: Container name (uses config default if not provided)
            prefix: Filter by prefix path
            extensions: Filter by file extensions (e.g., {'.jpg', '.png'})
            
        Returns:
            List of blob info dictionaries with name, url, size, etc.
        """
        container_client = self._get_container_client(container_name)
        container = container_name or self.settings.azure_storage_container
        
        blobs = []
        async for blob in container_client.list_blobs(name_starts_with=prefix):
            # Filter by extension if specified
            if extensions:
                blob_ext = '.' + blob.name.rsplit('.', 1)[-1].lower() if '.' in blob.name else ''
                if blob_ext not in extensions:
                    continue
            
            blob_url = f"{self.settings.azure_storage_blob_url}/{container}/{blob.name}"
            
            blobs.append({
                "name": blob.name,
                "url": blob_url,
                "size": blob.size,
                "content_type": blob.content_settings.content_type if blob.content_settings else None,
                "last_modified": blob.last_modified,
                "container": container
            })
        
        self.logger.info("Listed blobs", container=container, count=len(blobs))
        return blobs
    
    async def download_blob(
        self,
        blob_name: str,
        container_name: str | None = None
    ) -> bytes:
        """
        Download a blob's content.
        
        Args:
            blob_name: Name/path of the blob
            container_name: Container name (uses config default if not provided)
            
        Returns:
            Blob content as bytes
        """
        container_client = self._get_container_client(container_name)
        blob_client = container_client.get_blob_client(blob_name)
        
        self.logger.debug("Downloading blob", blob_name=blob_name)
        
        stream = await blob_client.download_blob()
        data = await stream.readall()
        
        return data
    
    async def blob_exists(
        self,
        blob_name: str,
        container_name: str | None = None
    ) -> bool:
        """Check if a blob exists."""
        container_client = self._get_container_client(container_name)
        blob_client = container_client.get_blob_client(blob_name)
        
        return await blob_client.exists()
    
    async def close(self):
        """Close the client connection."""
        await self._service_client.close()
    
    async def __aenter__(self):
        return self
    
    async def __aexit__(self, exc_type, exc_val, exc_tb):
        await self.close()
