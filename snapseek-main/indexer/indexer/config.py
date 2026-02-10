"""Configuration settings for the indexer."""

import structlog
from pydantic_settings import BaseSettings
from pydantic import Field
from functools import lru_cache
from azure.identity import DefaultAzureCredential, get_bearer_token_provider
from azure.core.credentials import AzureKeyCredential

logger = structlog.get_logger()


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""
    
    # Azure AI Search
    azure_search_endpoint: str = Field(..., description="Azure AI Search endpoint URL")
    azure_search_key: str | None = Field(default=None, description="Azure AI Search admin key (optional if using identity)")
    azure_search_index_name: str = Field(default="snapseek-images", description="Search index name")
    
    # Azure Computer Vision
    azure_cv_endpoint: str = Field(..., description="Azure Computer Vision endpoint")
    azure_cv_key: str | None = Field(default=None, description="Azure Computer Vision key (optional if using identity)")
    
    # Azure Document Intelligence
    azure_doc_intel_endpoint: str = Field(..., description="Azure Document Intelligence endpoint")
    azure_doc_intel_key: str | None = Field(default=None, description="Azure Document Intelligence key (optional if using identity)")
    
    # Azure Face API (Optional)
    azure_face_endpoint: str | None = Field(default=None, description="Azure Face API endpoint")
    azure_face_key: str | None = Field(default=None, description="Azure Face API key")
    azure_face_person_group_id: str = Field(default="snapseek-faces", description="PersonGroup ID for persistent face identification")
    azure_face_list_id: str = Field(default="snapseek-facelist", description="FaceList ID for temporary face storage during indexing")
    
    # Azure OpenAI
    azure_openai_endpoint: str = Field(..., description="Azure OpenAI endpoint")
    azure_openai_key: str | None = Field(default=None, description="Azure OpenAI key (optional if using identity)")
    azure_openai_embedding_deployment: str = Field(
        default="text-embedding-3-small",
        description="OpenAI embedding model deployment name"
    )
    azure_openai_api_version: str = Field(default="2024-02-01")
    
    # Azure Storage
    azure_storage_account: str | None = Field(default=None, description="Azure Storage account name")
    azure_storage_blob_url: str | None = Field(default=None, description="Azure Blob Storage URL")
    azure_storage_container: str | None = Field(default=None, description="Azure Blob container name")
    azure_storage_key: str | None = Field(default=None, description="Azure Storage key (optional if using identity)")
    
    # Processing settings
    batch_size: int = Field(default=10, ge=1, le=100)
    enable_face_detection: bool = Field(default=True)
    use_persistent_faces: bool = Field(default=True, description="Use two-pass face clustering with FaceList storage")
    enable_image_embeddings: bool = Field(default=True)
    
    # Vector dimensions
    text_embedding_dimensions: int = Field(default=1536)
    image_embedding_dimensions: int = Field(default=768)
    
    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        extra = "ignore"


def get_azure_credential():
    """Get DefaultAzureCredential for identity-based auth."""
    try:
        credential = DefaultAzureCredential()
        return credential
    except Exception as e:
        logger.warning("Failed to get DefaultAzureCredential", error=str(e))
        return None


def get_search_credential(settings: Settings):
    """Get credential for Azure AI Search - tries identity first, falls back to key."""
    credential = get_azure_credential()
    if credential:
        logger.info("Using DefaultAzureCredential for Azure AI Search")
        return credential
    if settings.azure_search_key:
        logger.info("Using API key for Azure AI Search")
        return AzureKeyCredential(settings.azure_search_key)
    raise ValueError("No valid credential available for Azure AI Search")


def get_cognitive_credential(settings: Settings, key: str | None):
    """Get credential for Cognitive Services - tries identity first, falls back to key."""
    credential = get_azure_credential()
    if credential:
        logger.info("Using DefaultAzureCredential for Cognitive Services")
        return credential
    if key:
        logger.info("Using API key for Cognitive Services")
        return AzureKeyCredential(key)
    raise ValueError("No valid credential available for Cognitive Services")


def get_openai_token_provider():
    """Get token provider for Azure OpenAI using identity."""
    credential = get_azure_credential()
    if credential:
        return get_bearer_token_provider(credential, "https://cognitiveservices.azure.com/.default")
    return None


def get_storage_credential(settings: Settings):
    """Get credential for Azure Storage - tries identity first, falls back to key."""
    credential = get_azure_credential()
    if credential:
        logger.info("Using DefaultAzureCredential for Azure Storage")
        return credential
    if settings.azure_storage_key:
        logger.info("Using connection string for Azure Storage")
        return settings.azure_storage_key
    raise ValueError("No valid credential available for Azure Storage")


@lru_cache()
def get_settings() -> Settings:
    """Get cached settings instance."""
    return Settings()
