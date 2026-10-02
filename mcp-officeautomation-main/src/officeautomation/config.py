from functools import lru_cache
from typing import Literal

from pydantic import Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_prefix="OFFICE_AUTOMATION_",
        extra="ignore",
    )

    environment: Literal["local", "test", "production"] = "local"
    auth_mode: Literal["disabled", "api_key", "entra"] = "api_key"
    api_key: SecretStr | None = None
    file_store_root: str = "var/files"
    retention_seconds: int = Field(default=3600, ge=60)
    max_file_size: int = Field(default=100 * 1024 * 1024, ge=1)
    max_single_upload_size: int = Field(default=32 * 1024 * 1024, ge=1)
    max_inline_upload_size: int = Field(default=2 * 1024 * 1024, ge=1)
    max_block_size: int = Field(default=8 * 1024 * 1024, ge=1)
    mcp_allowed_hosts: list[str] = Field(
        default_factory=lambda: ["127.0.0.1:*", "localhost:*", "testserver"]
    )
    mcp_allowed_origins: list[str] = Field(default_factory=list)
    entra_tenant_id: str | None = None
    entra_client_id: str | None = None
    entra_required_role: str = "OfficeAutomation.Use"

    @model_validator(mode="after")
    def validate_auth(self) -> "Settings":
        if self.environment == "production" and self.auth_mode == "disabled":
            raise ValueError("Authentication cannot be disabled in production")
        if self.auth_mode == "api_key" and self.api_key is None:
            raise ValueError("OFFICE_AUTOMATION_API_KEY is required in api_key mode")
        if self.auth_mode == "entra" and not (self.entra_tenant_id and self.entra_client_id):
            raise ValueError("Entra tenant and client IDs are required in entra mode")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
