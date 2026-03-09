"""Configuration settings for the indexer."""

import structlog
from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import Field
from functools import lru_cache
from azure.identity import DefaultAzureCredential, get_bearer_token_provider
from azure.core.credentials import AzureKeyCredential

logger = structlog.get_logger()

# Resolve .env relative to this file's directory (indexer/indexer/),
# then check the indexer/ root and workspace root as fallbacks.
_THIS_DIR = Path(__file__).resolve().parent
_ENV_CANDIDATES = [
    _THIS_DIR.parent / ".env",        # indexer/.env
    _THIS_DIR.parent.parent / ".env", # workspace root .env
    Path(".env"),                       # cwd
]
_ENV_FILE = next((p for p in _ENV_CANDIDATES if p.is_file()), ".env")


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""
    
    model_config = SettingsConfigDict(
        env_file=str(_ENV_FILE),
        env_file_encoding="utf-8",
        extra="ignore",
    )
    
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
    
    # Local face embeddings
    enable_face_embeddings: bool = Field(
        default=True,
        description="Enable local face embedding generation"
    )
    face_embedding_backend: str = Field(
        default="dlib",
        description="Backend for face embeddings: 'dlib' (128-dim, no download) or 'deepface' (512-dim, requires weight download)"
    )
    face_embedding_dimensions: int = Field(default=128, description="Dimension of face embeddings (dlib=128, Facenet512=512)")
    azure_search_faces_index_name: str = Field(
        default="snapseek-faces",
        description="Separate Azure AI Search index for face embeddings"
    )
    face_detection_fallback: bool = Field(
        default=True,
        description="Use local face detection when Azure Face API finds no faces"
    )
    deepface_model_name: str = Field(
        default="Facenet512",
        description="DeepFace model for face embeddings (Facenet512, VGG-Face, ArcFace, etc.) — only used when face_embedding_backend='deepface'"
    )
    
    # Vector dimensions
    text_embedding_dimensions: int = Field(default=1536)
    image_embedding_dimensions: int = Field(default=768)
    
    # Identity auth scope
    azure_credential_scope: str = Field(
        default="https://cognitiveservices.azure.com/.default",
        description="Token scope for DefaultAzureCredential (e.g. OpenAI, Cognitive Services)"
    )
    

def _is_running_on_azure() -> bool:
    """Detect if we're running on Azure (App Service, Container Apps, AKS, etc.)."""
    import os
    azure_indicators = [
        "WEBSITE_INSTANCE_ID",      # App Service
        "IDENTITY_ENDPOINT",         # Managed Identity configured
        "CONTAINER_APP_NAME",        # Container Apps
        "KUBERNETES_SERVICE_HOST",   # AKS
    ]
    return any(os.environ.get(var) for var in azure_indicators)


def get_azure_credential():
    """Get DefaultAzureCredential for identity-based auth.

    On Azure: Uses full credential chain including ManagedIdentityCredential.
    Locally: Excludes IMDS to avoid 5+ second timeout on each token request,
             so AzureCliCredential is used instead.
    """
    try:
        if _is_running_on_azure():
            credential = DefaultAzureCredential()
            logger.info("DefaultAzureCredential initialized (Azure environment)")
        else:
            credential = DefaultAzureCredential(
                exclude_managed_identity_credential=True,
                exclude_shared_token_cache_credential=True,
            )
            logger.info("DefaultAzureCredential initialized (local dev - IMDS excluded)")
        return credential
    except Exception as e:
        logger.warning("Failed to get DefaultAzureCredential", error=str(e))
        return None


def get_search_credential(settings: Settings):
    """Get credential for Azure AI Search - uses key if available, falls back to identity."""
    if settings.azure_search_key:
        logger.info("Using API key for Azure AI Search")
        return AzureKeyCredential(settings.azure_search_key)
    credential = get_azure_credential()
    if credential:
        logger.info("Using DefaultAzureCredential for Azure AI Search")
        return credential
    raise ValueError("No valid credential available for Azure AI Search")


def get_cognitive_credential(settings: Settings, key: str | None):
    """Get credential for Cognitive Services - uses key if available, falls back to identity."""
    if key:
        logger.info("Using API key for Cognitive Services")
        return AzureKeyCredential(key)
    credential = get_azure_credential()
    if credential:
        logger.info("Using DefaultAzureCredential for Cognitive Services")
        return credential
    raise ValueError("No valid credential available for Cognitive Services")


def get_openai_token_provider(scope: str = "https://cognitiveservices.azure.com/.default"):
    """Get token provider for Azure OpenAI using identity."""
    credential = get_azure_credential()
    if credential:
        return get_bearer_token_provider(credential, scope)
    return None


def get_storage_credential(settings: Settings):
    """Get credential for Azure Storage - uses key if available, falls back to identity."""
    if settings.azure_storage_key:
        logger.info("Using storage key for Azure Storage")
        return settings.azure_storage_key
    credential = get_azure_credential()
    if credential:
        logger.info("Using DefaultAzureCredential for Azure Storage")
        return credential
    raise ValueError("No valid credential available for Azure Storage")


@lru_cache()
def get_settings() -> Settings:
    """Get cached settings instance."""
    return Settings()
