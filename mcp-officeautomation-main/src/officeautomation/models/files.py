from datetime import UTC, datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator

FileState = Literal["reserved", "uploaded", "validated"]


class FileCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    content_type: str = Field(min_length=1, max_length=255)
    size: int = Field(ge=0)
    sha256: str | None = Field(default=None, pattern=r"^[0-9a-fA-F]{64}$")

    @field_validator("name")
    @classmethod
    def safe_name(cls, value: str) -> str:
        if value in {".", ".."} or "/" in value or "\\" in value or "\x00" in value:
            raise ValueError("name must be a plain file name")
        return value


class FileReference(BaseModel):
    file_id: str
    name: str
    content_type: str
    size: int
    sha256: str | None
    parent_file_id: str | None = None
    state: FileState
    created_at: datetime
    expires_at: datetime
    content_url: str


class UploadReservation(FileReference):
    upload_url: str
    block_upload_url_template: str
    commit_url: str
    max_block_size: int


class CommitRequest(BaseModel):
    block_count: int = Field(ge=1, le=10000)
    sha256: str | None = Field(default=None, pattern=r"^[0-9a-fA-F]{64}$")


class StoredFile(BaseModel):
    file_id: str
    owner: str
    name: str
    content_type: str
    declared_size: int
    size: int = 0
    sha256: str | None = None
    expected_sha256: str | None = None
    parent_file_id: str | None = None
    state: FileState = "reserved"
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    expires_at: datetime
