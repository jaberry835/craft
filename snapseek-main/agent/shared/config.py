"""Configuration settings for the agent."""

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
    
    # Vector dimensions
    text_embedding_dimensions: int = Field(default=1536)
    
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


def get_openai_token_provider():
    """Get token provider for Azure OpenAI using identity."""
    credential = get_azure_credential()
    if credential:
        return get_bearer_token_provider(credential, "https://cognitiveservices.azure.com/.default")
    return None


@lru_cache()
def get_settings() -> Settings:
    """Get cached settings instance."""
    return Settings()
