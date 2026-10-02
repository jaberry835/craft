import hashlib
import os
import secrets
import shutil
import zipfile
from collections.abc import AsyncIterable
from datetime import UTC, datetime, timedelta
from pathlib import Path

from officeautomation.config import Settings
from officeautomation.errors import ServiceError
from officeautomation.models.files import FileCreate, FileReference, StoredFile, UploadReservation


class LocalFileStore:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.root = Path(settings.file_store_root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def reserve(self, owner: str, request: FileCreate) -> UploadReservation:
        if request.size > self.settings.max_file_size:
            raise ServiceError("PAYLOAD_TOO_LARGE", "File exceeds the configured limit", 413)
        file_id = f"f_{secrets.token_hex(16)}"
        now = datetime.now(UTC)
        stored = StoredFile(
            file_id=file_id,
            owner=owner,
            name=request.name,
            content_type=request.content_type,
            declared_size=request.size,
            expected_sha256=request.sha256.lower() if request.sha256 else None,
            expires_at=now + timedelta(seconds=self.settings.retention_seconds),
        )
        directory = self._directory(file_id)
        directory.mkdir(parents=True)
        self._write_metadata(stored)
        reference = self.to_reference(stored)
        return UploadReservation(
            **reference.model_dump(),
            upload_url=f"/api/v1/files/{file_id}/content",
            block_upload_url_template=f"/api/v1/files/{file_id}/blocks/{{block_number}}",
            commit_url=f"/api/v1/files/{file_id}/commit",
            max_block_size=self.settings.max_block_size,
        )

    async def upload(self, owner: str, file_id: str, chunks: AsyncIterable[bytes]) -> FileReference:
        stored = self.get(file_id, owner, require_uploaded=False)
        if stored.declared_size > self.settings.max_single_upload_size:
            raise ServiceError("PAYLOAD_TOO_LARGE", "Use chunked upload for this file", 413)
        await self._write_stream(stored, self._content_path(file_id), chunks)
        return self.to_reference(stored)

    async def save_bytes(
        self,
        owner: str,
        name: str,
        content_type: str,
        content: bytes,
        *,
        parent_file_id: str | None = None,
    ) -> FileReference:
        reservation = self.reserve(
            owner,
            FileCreate(name=name, content_type=content_type, size=len(content)),
        )
        stored = self.get(reservation.file_id, owner, require_uploaded=False)
        stored.parent_file_id = parent_file_id

        async def chunks() -> AsyncIterable[bytes]:
            yield content

        await self._write_stream(stored, self._content_path(stored.file_id), chunks())
        return self.to_reference(stored)

    async def upload_block(
        self,
        owner: str,
        file_id: str,
        block_number: int,
        chunks: AsyncIterable[bytes],
    ) -> None:
        stored = self.get(file_id, owner, require_uploaded=False)
        if stored.state != "reserved":
            raise ServiceError("INVALID_DOCUMENT", "Upload has already been committed", 409)
        block_path = self._blocks_path(file_id) / f"{block_number:08d}.block"
        block_path.parent.mkdir(exist_ok=True)
        total = 0
        with block_path.open("wb") as destination:
            async for chunk in chunks:
                total += len(chunk)
                if total > self.settings.max_block_size:
                    destination.close()
                    block_path.unlink(missing_ok=True)
                    raise ServiceError(
                        "PAYLOAD_TOO_LARGE", "Block exceeds the configured limit", 413
                    )
                destination.write(chunk)

    def commit(
        self, owner: str, file_id: str, block_count: int, sha256: str | None
    ) -> FileReference:
        stored = self.get(file_id, owner, require_uploaded=False)
        block_paths = [
            self._blocks_path(file_id) / f"{index:08d}.block" for index in range(block_count)
        ]
        if any(not path.is_file() for path in block_paths):
            raise ServiceError("UPLOAD_INCOMPLETE", "One or more upload blocks are missing", 409)
        content_path = self._content_path(file_id)
        digest = hashlib.sha256()
        total = 0
        with content_path.open("wb") as destination:
            for block_path in block_paths:
                with block_path.open("rb") as source:
                    for chunk in iter(lambda: source.read(1024 * 1024), b""):
                        total += len(chunk)
                        if total > self.settings.max_file_size:
                            content_path.unlink(missing_ok=True)
                            raise ServiceError(
                                "PAYLOAD_TOO_LARGE", "File exceeds the configured limit", 413
                            )
                        digest.update(chunk)
                        destination.write(chunk)
        self._finish_upload(stored, total, digest.hexdigest(), sha256)
        shutil.rmtree(self._blocks_path(file_id), ignore_errors=True)
        return self.to_reference(stored)

    def get(self, file_id: str, owner: str, *, require_uploaded: bool = True) -> StoredFile:
        metadata_path = self._metadata_path(file_id)
        if not metadata_path.is_file():
            raise ServiceError("FILE_NOT_FOUND", "File was not found", 404)
        stored = StoredFile.model_validate_json(metadata_path.read_text(encoding="utf-8"))
        if stored.owner != owner:
            raise ServiceError("FILE_NOT_FOUND", "File was not found", 404)
        if stored.expires_at <= datetime.now(UTC):
            self.delete(owner, file_id, ignore_expiry=True)
            raise ServiceError("FILE_EXPIRED", "File has expired", 410)
        if require_uploaded and stored.state != "validated":
            raise ServiceError("FILE_NOT_UPLOADED", "File upload is not complete", 409)
        return stored

    def open_content(self, owner: str, file_id: str) -> tuple[StoredFile, Path]:
        stored = self.get(file_id, owner)
        return stored, self._content_path(file_id)

    def delete(self, owner: str, file_id: str, *, ignore_expiry: bool = False) -> None:
        metadata_path = self._metadata_path(file_id)
        if not metadata_path.is_file():
            raise ServiceError("FILE_NOT_FOUND", "File was not found", 404)
        stored = StoredFile.model_validate_json(metadata_path.read_text(encoding="utf-8"))
        if stored.owner != owner:
            raise ServiceError("FILE_NOT_FOUND", "File was not found", 404)
        if not ignore_expiry and stored.expires_at <= datetime.now(UTC):
            shutil.rmtree(self._directory(file_id), ignore_errors=True)
            raise ServiceError("FILE_EXPIRED", "File has expired", 410)
        shutil.rmtree(self._directory(file_id), ignore_errors=True)

    def to_reference(self, stored: StoredFile) -> FileReference:
        return FileReference(
            file_id=stored.file_id,
            name=stored.name,
            content_type=stored.content_type,
            size=stored.size,
            sha256=stored.sha256,
            parent_file_id=stored.parent_file_id,
            state=stored.state,
            created_at=stored.created_at,
            expires_at=stored.expires_at,
            content_url=f"/api/v1/files/{stored.file_id}/content",
        )

    async def _write_stream(
        self, stored: StoredFile, path: Path, chunks: AsyncIterable[bytes]
    ) -> None:
        digest = hashlib.sha256()
        total = 0
        with path.open("wb") as destination:
            async for chunk in chunks:
                total += len(chunk)
                if total > self.settings.max_file_size:
                    destination.close()
                    path.unlink(missing_ok=True)
                    raise ServiceError(
                        "PAYLOAD_TOO_LARGE", "File exceeds the configured limit", 413
                    )
                digest.update(chunk)
                destination.write(chunk)
        self._finish_upload(stored, total, digest.hexdigest(), None)

    def _finish_upload(
        self,
        stored: StoredFile,
        actual_size: int,
        actual_sha256: str,
        commit_sha256: str | None,
    ) -> None:
        if actual_size != stored.declared_size:
            self._content_path(stored.file_id).unlink(missing_ok=True)
            raise ServiceError(
                "UPLOAD_INCOMPLETE",
                "Uploaded size does not match the reservation",
                400,
                {"declared_size": stored.declared_size, "actual_size": actual_size},
            )
        expected_hash = (commit_sha256 or stored.expected_sha256 or "").lower()
        if expected_hash and not secrets.compare_digest(expected_hash, actual_sha256):
            self._content_path(stored.file_id).unlink(missing_ok=True)
            raise ServiceError("HASH_MISMATCH", "Uploaded content hash does not match", 400)
        self._validate_package(stored)
        stored.size = actual_size
        stored.sha256 = actual_sha256
        stored.state = "validated"
        self._write_metadata(stored)

    def _validate_package(self, stored: StoredFile) -> None:
        suffix = Path(stored.name).suffix.lower()
        if suffix not in {
            ".docx",
            ".xlsx",
            ".md",
            ".png",
            ".jpg",
            ".jpeg",
            ".gif",
            ".bmp",
            ".tif",
            ".tiff",
        }:
            raise ServiceError("INVALID_DOCUMENT", "Unsupported file type", 400)
        if suffix not in {".docx", ".xlsx"}:
            return
        content_path = self._content_path(stored.file_id)
        try:
            with zipfile.ZipFile(content_path) as package:
                names = set(package.namelist())
                required = "word/document.xml" if suffix == ".docx" else "xl/workbook.xml"
                if "[Content_Types].xml" not in names or required not in names:
                    raise ServiceError("INVALID_DOCUMENT", "Invalid Office package", 400)
                expanded_size = sum(entry.file_size for entry in package.infolist())
                if expanded_size > self.settings.max_file_size * 10:
                    raise ServiceError(
                        "INVALID_DOCUMENT", "Office package expands beyond the safety limit", 400
                    )
        except zipfile.BadZipFile as error:
            raise ServiceError("INVALID_DOCUMENT", "Invalid Office package", 400) from error

    def _directory(self, file_id: str) -> Path:
        if not file_id.startswith("f_") or len(file_id) != 34 or not file_id[2:].isalnum():
            raise ServiceError("FILE_NOT_FOUND", "File was not found", 404)
        return self.root / file_id

    def _metadata_path(self, file_id: str) -> Path:
        return self._directory(file_id) / "metadata.json"

    def _content_path(self, file_id: str) -> Path:
        return self._directory(file_id) / "content"

    def _blocks_path(self, file_id: str) -> Path:
        return self._directory(file_id) / "blocks"

    def _write_metadata(self, stored: StoredFile) -> None:
        path = self._metadata_path(stored.file_id)
        temporary = path.with_suffix(".tmp")
        temporary.write_text(stored.model_dump_json(indent=2), encoding="utf-8")
        os.replace(temporary, path)
