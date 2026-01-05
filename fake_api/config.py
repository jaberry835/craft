from pydantic_settings import BaseSettings
from typing import Optional

class Settings(BaseSettings):
    # Azure OpenAI Configuration
    azure_openai_endpoint: str
    azure_openai_api_key: Optional[str] = None
    azure_openai_api_version: str = "2024-02-01"
    azure_openai_deployment_name: str = "gpt-4o"
    
    # Application Configuration
    app_name: str = "Fictional Information API"
    app_version: str = "1.0.0"
    debug: bool = True
    log_level: str = "INFO"
    
    # Server Configuration
    host: str = "0.0.0.0"
    port: int = 8000
    
    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"

# Global settings instance
settings = Settings()
