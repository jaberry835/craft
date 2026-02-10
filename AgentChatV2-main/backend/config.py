"""
AgentChatV2 Configuration Management
Uses Pydantic Settings for type-safe environment configuration.
"""
import os
from functools import lru_cache
from typing import Union
from pydantic_settings import BaseSettings
from pydantic import Field
from azure.identity import AzureCliCredential, ManagedIdentityCredential


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""
    
    # Environment
    environment: str = Field(default="development", alias="ENVIRONMENT")
    log_level: str = Field(default="INFO", alias="LOG_LEVEL")
    
    # Logging Toggles - enable verbose logging for specific categories
    show_performance_logs: bool = Field(default=False, alias="SHOW_PERFORMANCE_LOGS")
    show_auth_logs: bool = Field(default=False, alias="SHOW_AUTH_LOGS")
    show_a2a_logs: bool = Field(default=False, alias="SHOW_A2A_LOGS")
    show_mcp_logs: bool = Field(default=False, alias="SHOW_MCP_LOGS")
    show_agent_logs: bool = Field(default=False, alias="SHOW_AGENT_LOGS")
    
    # Azure Government
    azure_authority_host: str = Field(
        default="https://login.microsoftonline.us",
        alias="AZURE_AUTHORITY_HOST"
    )
    
    # Entra ID - optional when using managed identity in production
    # Required for token validation of incoming user tokens
    azure_tenant_id: str = Field(default="", alias="AZURE_TENANT_ID")
    azure_client_id: str = Field(default="", alias="AZURE_CLIENT_ID")
    
    # Azure OpenAI
    azure_openai_endpoint: str = Field(default="", alias="AZURE_OPENAI_ENDPOINT")
    azure_openai_key: str = Field(default="", alias="AZURE_OPENAI_KEY")
    azure_openai_api_version: str = Field(
        default="2024-02-15-preview",
        alias="AZURE_OPENAI_API_VERSION"
    )
    # Note: Deployment/model is configured per-agent by admin, not globally
    azure_openai_embedding_deployment: str = Field(default="text-embedding-ada-002", alias="AZURE_OPENAI_EMBEDDING_DEPLOYMENT")
    
    # Azure Cognitive Services scope for token auth
    # Azure Commercial: https://cognitiveservices.azure.com/.default
    # Azure Government: https://cognitiveservices.azure.us/.default
    azure_cognitive_services_scope: str = Field(
        default="https://cognitiveservices.azure.us/.default",
        alias="AZURE_COGNITIVE_SERVICES_SCOPE"
    )
    
    # Cosmos DB
    cosmos_endpoint: str = Field(default="", alias="AZURE_COSMOS_DB_ENDPOINT")
    cosmos_connection_string: str = Field(default="", alias="AZURE_COSMOS_DB_CONNECTION_STRING")
    cosmos_database: str = Field(default="AgentChatV2", alias="AZURE_COSMOS_DB_DATABASE")
    cosmos_agents_container: str = Field(default="Agents", alias="AZURE_COSMOS_DB_AGENTS_CONTAINER")
    cosmos_sessions_container: str = Field(default="Sessions", alias="AZURE_COSMOS_DB_SESSIONS_CONTAINER")
    cosmos_messages_container: str = Field(default="Messages", alias="AZURE_COSMOS_DB_MESSAGES_CONTAINER")
    
    # Azure AI Search
    search_endpoint: str = Field(default="", alias="AZURE_SEARCH_ENDPOINT")
    search_key: str = Field(default="", alias="AZURE_SEARCH_KEY")
    search_index_name: str = Field(default="documents", alias="AZURE_SEARCH_INDEX_NAME")
    
    # MCP Server
    mcp_server_endpoint: str = Field(alias="MCP_SERVER_ENDPOINT")
    
    # Backend URL for A2A (Agent-to-Agent) communication
    # In production, set this to the deployed backend URL (e.g., https://app-agentchat-api.azurewebsites.us)
    # Defaults to localhost:5000 for local development
    backend_url: str = Field(default="http://localhost:5000", alias="BACKEND_URL")
    
    # Application Insights
    appinsights_connection_string: str = Field(
        default="",
        alias="APPLICATIONINSIGHTS_CONNECTION_STRING"
    )
    
    # Token Management
    default_max_input_tokens: int = Field(default=8000, alias="DEFAULT_MAX_INPUT_TOKENS")
    default_max_output_tokens: int = Field(default=4000, alias="DEFAULT_MAX_OUTPUT_TOKENS")
    token_cost_warning_threshold: int = Field(default=10000, alias="TOKEN_COST_WARNING_THRESHOLD")
    
    class Config:
        env_file = ".env"
        case_sensitive = False


@lru_cache()
def get_settings() -> Settings:
    """Get cached settings instance."""
    return Settings()


def get_azure_credential() -> Union[AzureCliCredential, ManagedIdentityCredential]:
    """
    Get the appropriate Azure credential based on the environment.
    
    - Development: Uses AzureCliCredential (logged-in user's identity)
    - Production: Uses ManagedIdentityCredential directly (bypasses DefaultAzureCredential chain)
    
    For Azure Government, ManagedIdentityCredential automatically uses the correct
    authority when AZURE_AUTHORITY_HOST environment variable is set.
    
    Returns:
        Azure credential for authenticating to Azure services.
    """
    settings = get_settings()
    
    if settings.environment == "development":
        return AzureCliCredential()
    else:
        # Use ManagedIdentityCredential directly instead of DefaultAzureCredential
        # This avoids the credential chain that fails in App Service containers
        # The AZURE_AUTHORITY_HOST env var ensures Azure Government is used
        return ManagedIdentityCredential()

