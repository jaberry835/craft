"""
AgentChatV2 Configuration Management
Uses Pydantic Settings for type-safe environment configuration.
"""
import os
from functools import lru_cache
from typing import Union
from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import Field
from azure.identity import AzureCliCredential, ManagedIdentityCredential
from azure.identity.aio import AzureCliCredential as AzureCliCredentialAsync, ManagedIdentityCredential as ManagedIdentityCredentialAsync


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""
    
    # Environment
    environment: str = Field(default="production", alias="ENVIRONMENT")
    # Explicitly opt-in to auth/admin bypass for local development only.
    allow_dev_auth_bypass: bool = Field(default=False, alias="ALLOW_DEV_AUTH_BYPASS")
    log_level: str = Field(default="INFO", alias="LOG_LEVEL")
    
    # CORS - comma-separated origins allowed for credentialed requests
    # e.g. "http://localhost:4200,https://app-agentchat.azurewebsites.us"
    cors_origins: str = Field(default="http://localhost:4200", alias="CORS_ORIGINS")
    
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
    
    # Confidential client credentials for OBO (On-Behalf-Of) token exchange.
    # Required when calling external A2A agents that use a different app registration.
    # In production: set AZURE_CLIENT_SECRET
    # In development: set AZURE_CLIENT_CERTIFICATE_PATH to a .pfx file
    # If both are set, the certificate is preferred.
    azure_client_secret: str = Field(default="", alias="AZURE_CLIENT_SECRET")
    azure_client_certificate_path: str = Field(default="", alias="AZURE_CLIENT_CERTIFICATE_PATH")
    azure_client_certificate_password: str = Field(default="", alias="AZURE_CLIENT_CERTIFICATE_PASSWORD")
    
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
    
    # Azure Resource Manager (ARM) overrides for sovereign/custom clouds.
    # When set, these override the auto-detected ARM endpoint and scope
    # used for AOAI deployment discovery.
    # Examples:
    #   Azure Government: https://management.usgovcloudapi.net
    #   Azure Commercial: https://management.azure.com
    azure_arm_endpoint: str = Field(default="", alias="AZURE_ARM_ENDPOINT")
    azure_arm_scope: str = Field(default="", alias="AZURE_ARM_SCOPE")
    
    # Cosmos DB
    cosmos_endpoint: str = Field(default="", alias="AZURE_COSMOS_DB_ENDPOINT")
    cosmos_connection_string: str = Field(default="", alias="AZURE_COSMOS_DB_CONNECTION_STRING")
    cosmos_database: str = Field(default="AgentChatV2", alias="AZURE_COSMOS_DB_DATABASE")
    cosmos_agents_container: str = Field(default="Agents", alias="AZURE_COSMOS_DB_AGENTS_CONTAINER")
    cosmos_sessions_container: str = Field(default="Sessions", alias="AZURE_COSMOS_DB_SESSIONS_CONTAINER")
    cosmos_messages_container: str = Field(default="Messages", alias="AZURE_COSMOS_DB_MESSAGES_CONTAINER")
    cosmos_preferences_container: str = Field(default="UserPreferences", alias="AZURE_COSMOS_DB_PREFERENCES_CONTAINER")
    
    # Azure AI Search
    search_endpoint: str = Field(default="", alias="AZURE_SEARCH_ENDPOINT")
    search_key: str = Field(default="", alias="AZURE_SEARCH_KEY")
    search_index_name: str = Field(default="documents", alias="AZURE_SEARCH_INDEX_NAME")
    # Azure AI Search scope for token auth (no key auth)
    # Azure Commercial: https://search.azure.com/.default
    # Azure Government: https://search.azure.us/.default
    azure_search_scope: str = Field(
        default="https://search.azure.com/.default",
        alias="AZURE_SEARCH_SCOPE"
    )
    
    # Azure Document Intelligence
    # Used for rich document extraction (PDFs, scanned docs, Office files).
    # If endpoint is empty, DI is disabled and local parsers are used.
    document_intelligence_endpoint: str = Field(default="", alias="AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT")
    document_intelligence_key: str = Field(default="", alias="AZURE_DOCUMENT_INTELLIGENCE_KEY")
    
    # Security Token Service (SS Token / Access Checker)
    # Endpoint that returns the list of SS tokens a user is authorized for.
    # Called with the user's bearer token to enforce document-level security filtering.
    access_checker_endpoint: str = Field(default="", alias="ACCESS_CHECKER_ENDPOINT")
    # How long (in minutes) to cache a user's SS tokens before re-querying the
    # access checker.  Set to 0 to always call the access checker (no caching).
    access_checker_cache_ttl: int = Field(default=5, alias="ACCESS_CHECKER_CACHE_TTL")
    
     
    # Backend URL for A2A (Agent-to-Agent) communication
    # In production, set this to the deployed backend URL (e.g., https://app-agentchat-api.azurewebsites.us)
    # Defaults to localhost:5000 for local development
    backend_url: str = Field(default="http://localhost:5000", alias="BACKEND_URL")
    
    # Application Insights
    appinsights_connection_string: str = Field(
        default="",
        alias="APPLICATIONINSIGHTS_CONNECTION_STRING"
    )
    
    # Managed Identity
    # Set this to the client ID of a user-assigned managed identity.
    # If empty, ManagedIdentityCredential defaults to the system-assigned identity.
    azure_managed_identity_client_id: str = Field(default="", alias="AZURE_MANAGED_IDENTITY_CLIENT_ID")
    
    # Token Management
    default_max_input_tokens: int = Field(default=8000, alias="DEFAULT_MAX_INPUT_TOKENS")
    default_max_output_tokens: int = Field(default=4000, alias="DEFAULT_MAX_OUTPUT_TOKENS")
    token_cost_warning_threshold: int = Field(default=10000, alias="TOKEN_COST_WARNING_THRESHOLD")
    
    # Rate Limiting (slowapi format, e.g. "60/minute")
    rate_limit_default: str = Field(default="60/minute", alias="RATE_LIMIT_DEFAULT")
    rate_limit_chat: str = Field(default="10/minute", alias="RATE_LIMIT_CHAT")
    rate_limit_upload: str = Field(default="20/minute", alias="RATE_LIMIT_UPLOAD")
    
    model_config = SettingsConfigDict(
        env_file=".env",
        case_sensitive=False,
    )


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
        if settings.azure_managed_identity_client_id:
            # User-assigned managed identity — client_id is required to disambiguate
            return ManagedIdentityCredential(client_id=settings.azure_managed_identity_client_id)
        else:
            # System-assigned managed identity (default)
            return ManagedIdentityCredential()


def get_azure_credential_async() -> Union[AzureCliCredentialAsync, ManagedIdentityCredentialAsync]:
    """
    Get the appropriate async Azure credential based on the environment.
    Required by async SDK clients (e.g. azure.cosmos.aio) whose get_token() is a coroutine.
    """
    settings = get_settings()

    if settings.environment == "development":
        return AzureCliCredentialAsync()
    else:
        if settings.azure_managed_identity_client_id:
            return ManagedIdentityCredentialAsync(client_id=settings.azure_managed_identity_client_id)
        else:
            return ManagedIdentityCredentialAsync()
