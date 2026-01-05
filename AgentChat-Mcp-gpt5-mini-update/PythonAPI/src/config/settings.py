"""Configuration settings for the MCP Server and Flask API."""

import os
from typing import Optional
from pydantic import Field
from pydantic_settings import BaseSettings
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()


class MCPSettings(BaseSettings):
    """MCP Server specific settings."""
    
    server_name: str = Field(default="PythonAPI_MCP_Server", env="MCP_SERVER_NAME")
    server_port: int = Field(default=3001, env="MCP_SERVER_PORT")
    mount_path: str = Field(default="/mcp", env="MCP_MOUNT_PATH")
    
    # External MCP server endpoint
    server_endpoint: Optional[str] = Field(default=None, env="MCP_SERVER_ENDPOINT")
    
    class Config:
        env_prefix = "MCP_"
        extra = "ignore"


class APISettings(BaseSettings):
    """Flask API specific settings."""
    
    host: str = Field(default="localhost", env="API_HOST")
    port: int = Field(default=5007, env="API_PORT")
    debug: bool = Field(default=True, env="FLASK_DEBUG")
    
    class Config:
        env_prefix = "API_"
        extra = "ignore"


class AzureSettings(BaseSettings):
    """Azure deployment settings."""
    
    client_id: Optional[str] = Field(default=None, env="AZURE_CLIENT_ID")
    client_secret: Optional[str] = Field(default=None, env="AZURE_CLIENT_SECRET")
    tenant_id: Optional[str] = Field(default=None, env="AZURE_TENANT_ID")
    keyvault_url: Optional[str] = Field(default=None, env="AZURE_KEYVAULT_URL")
    
    # Azure OpenAI settings
    azure_openai_endpoint: Optional[str] = Field(default=None, env="AZURE_OPENAI_ENDPOINT")
    azure_openai_api_key: Optional[str] = Field(default=None, env="AZURE_OPENAI_API_KEY")
    azure_openai_api_version: Optional[str] = Field(default="2024-02-01", env="AZURE_OPENAI_API_VERSION")
    azure_openai_deployment: Optional[str] = Field(default=None, env="AZURE_OPENAI_DEPLOYMENT")
    azure_openai_embedding_deployment: Optional[str] = Field(default=None, env="AZURE_OPENAI_EMBEDDING_DEPLOYMENT")
    
    # Azure Cosmos DB settings
    azure_cosmos_endpoint: Optional[str] = Field(default=None, env="AZURE_COSMOS_DB_ENDPOINT")
    azure_cosmos_key: Optional[str] = Field(default=None, env="AZURE_COSMOS_DB_KEY")
    azure_cosmos_database: Optional[str] = Field(default=None, env="AZURE_COSMOS_DB_DATABASE")
    azure_cosmos_sessions_container: Optional[str] = Field(default=None, env="AZURE_COSMOS_DB_SESSIONS_CONTAINER")
    azure_cosmos_messages_container: Optional[str] = Field(default=None, env="AZURE_COSMOS_DB_MESSAGES_CONTAINER")
    
    # Azure Blob Storage settings
    azure_storage_account_name: Optional[str] = Field(default=None, env="AZURE_STORAGE_ACCOUNT_NAME")
    azure_storage_connection_string: Optional[str] = Field(default=None, env="AZURE_STORAGE_CONNECTION_STRING")
    azure_storage_container_name: Optional[str] = Field(default=None, env="AZURE_STORAGE_CONTAINER_NAME")
    
    # Azure AI Search settings
    azure_search_endpoint: Optional[str] = Field(default=None, env="AZURE_SEARCH_ENDPOINT")
    azure_search_key: Optional[str] = Field(default=None, env="AZURE_SEARCH_KEY")
    azure_search_index_name: Optional[str] = Field(default=None, env="AZURE_SEARCH_INDEX_NAME")
    
    # Azure Document Intelligence settings
    document_intelligence_endpoint: Optional[str] = Field(default=None, env="AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT")
    document_intelligence_key: Optional[str] = Field(default=None, env="AZURE_DOCUMENT_INTELLIGENCE_KEY")
    
    # Azure Data Explorer settings
    adx_cluster_url: Optional[str] = Field(default=None, env="ADX_CLUSTER_URL")
    
    # Azure Application Insights settings
    application_insights_connection_string: Optional[str] = Field(default=None, env="APPLICATIONINSIGHTS_CONNECTION_STRING")
    application_insights_instrumentation_key: Optional[str] = Field(default=None, env="APPINSIGHTS_INSTRUMENTATIONKEY")
    
    class Config:
        case_sensitive = False
        env_file = ".env"
        extra = "ignore"


class AppSettings(BaseSettings):
    """Main application settings."""
    
    log_level: str = Field(default="INFO", env="LOG_LEVEL")
    environment: str = Field(default="development", env="FLASK_ENV")
    reduce_log_verbosity: bool = Field(default=True, env="REDUCE_LOG_VERBOSITY")
    quiet_mode: bool = Field(default=False, env="QUIET_MODE")
    suppress_azure_logs: bool = Field(default=True, env="SUPPRESS_AZURE_LOGS")
    suppress_semantic_kernel_logs: bool = Field(default=True, env="SUPPRESS_SEMANTIC_KERNEL_LOGS")
    
    # Default system settings
    DEFAULT_USER_ID: str = Field(default="system", env="DEFAULT_USER_ID")
    
    # Research settings
    RESEARCH_ROUND_TIME_LIMIT_SECONDS: int = Field(default=240, env="RESEARCH_ROUND_TIME_LIMIT_SECONDS")  # 4 minutes default
    
    # Sub-configurations
    mcp: MCPSettings = MCPSettings()
    api: APISettings = APISettings()
    azure: AzureSettings = AzureSettings()
    
    class Config:
        case_sensitive = False
        env_file = ".env"
        extra = "ignore"


# Global settings instance
settings = AppSettings()
