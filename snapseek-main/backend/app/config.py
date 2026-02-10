"""Configuration settings for the backend API."""

import os
import structlog
from pydantic_settings import BaseSettings
from pydantic import Field
from functools import lru_cache
from azure.identity import DefaultAzureCredential, get_bearer_token_provider
from azure.core.credentials import AzureKeyCredential

logger = structlog.get_logger()


def is_running_on_azure() -> bool:
    """
    Detect if we're running on Azure (App Service, Container Apps, AKS, etc.).
    
    Azure services set specific environment variables that we can check.
    """
    azure_indicators = [
        "WEBSITE_INSTANCE_ID",      # App Service
        "IDENTITY_ENDPOINT",         # Managed Identity configured
        "CONTAINER_APP_NAME",        # Container Apps
        "KUBERNETES_SERVICE_HOST",   # AKS
    ]
    return any(os.environ.get(var) for var in azure_indicators)


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""
    
    # Azure AI Search
    azure_search_endpoint: str = Field(..., description="Azure AI Search endpoint URL")
    azure_search_key: str | None = Field(default=None, description="Azure AI Search key (optional if using identity)")
    azure_search_index_name: str = Field(default="snapseek-images", description="Search index name")
    
    # Azure OpenAI
    azure_openai_endpoint: str = Field(..., description="Azure OpenAI endpoint")
    azure_openai_key: str | None = Field(default=None, description="Azure OpenAI key (optional if using identity)")
    azure_openai_chat_deployment: str = Field(default="gpt-4o", description="Chat model deployment")
    azure_openai_embedding_deployment: str = Field(
        default="text-embedding-3-small",
        description="Embedding model deployment"
    )
    azure_openai_api_version: str = Field(default="2024-02-01")
    
    # Azure Storage (for SAS token generation)
    azure_storage_account: str | None = Field(default=None, description="Azure Storage account name")
    azure_storage_blob_url: str | None = Field(default=None, description="Azure Blob Storage URL")
    
    # Server settings
    host: str = Field(default="0.0.0.0")
    port: int = Field(default=8000)
    cors_origins: str = Field(default="http://localhost:3000,http://localhost:5173")
    
    # Azure Face API
    azure_face_endpoint: str | None = Field(default=None, description="Azure Face API endpoint")
    azure_face_key: str | None = Field(default=None, description="Azure Face API key (optional if using identity)")
    azure_face_person_group_id: str = Field(default="snapseek-faces", description="PersonGroup ID for face identification")
    azure_face_list_id: str = Field(default="snapseek-facelist", description="FaceList ID for face storage")
    
    # Feature flags
    enable_semantic_search: bool = Field(default=True)
    enable_chat: bool = Field(default=True)
    
    # Vector dimensions
    text_embedding_dimensions: int = Field(default=1536)
    image_embedding_dimensions: int = Field(default=768)
    
    @property
    def cors_origins_list(self) -> list[str]:
        """Parse CORS origins as list."""
        return [origin.strip() for origin in self.cors_origins.split(",")]
    
    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        extra = "ignore"


# Cached credential instance (module-level singleton)
_azure_credential = None


def get_azure_credential():
    """
    Get cached DefaultAzureCredential for identity-based auth.
    
    On Azure: Uses full credential chain including ManagedIdentityCredential
    Locally: Excludes IMDS to avoid 5+ second timeout on each token request
    """
    global _azure_credential
    
    if _azure_credential is not None:
        return _azure_credential
    
    try:
        if is_running_on_azure():
            # In Azure - use full credential chain with Managed Identity
            _azure_credential = DefaultAzureCredential()
            logger.info("DefaultAzureCredential initialized (Azure environment - Managed Identity enabled)")
        else:
            # Local dev - exclude IMDS to avoid slow timeouts
            _azure_credential = DefaultAzureCredential(
                exclude_managed_identity_credential=True,  # Skip slow IMDS timeout locally
                exclude_shared_token_cache_credential=True,  # Avoid VS Code token cache issues
            )
            logger.info("DefaultAzureCredential initialized (local dev - IMDS excluded for speed)")
        return _azure_credential
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


# Cached token provider (module-level singleton)
_openai_token_provider = None


def get_openai_token_provider():
    """Get cached token provider for Azure OpenAI using identity."""
    global _openai_token_provider
    
    if _openai_token_provider is not None:
        return _openai_token_provider
    
    credential = get_azure_credential()
    if credential:
        _openai_token_provider = get_bearer_token_provider(
            credential, "https://cognitiveservices.azure.com/.default"
        )
        return _openai_token_provider
    return None


@lru_cache()
def get_settings() -> Settings:
    """Get cached settings instance."""
    return Settings()
