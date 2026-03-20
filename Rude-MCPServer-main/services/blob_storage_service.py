"""
Blob Storage Service for Policy Document Generation

Handles downloading templates and uploading generated documents
from/to Azure Blob Storage.  Uses account-key auth when
POLICY_BLOB_ACCOUNT_KEY is set, otherwise falls back to
DefaultAzureCredential (Managed Identity / az-login / env creds).
"""

import os
import logging
from typing import Optional, List, Dict

from azure.storage.blob import BlobServiceClient, ContentSettings
from azure.identity import DefaultAzureCredential

logger = logging.getLogger(__name__)


def _build_blob_service_client() -> Optional[BlobServiceClient]:
    """Build a BlobServiceClient using the best available credential."""
    account_name = os.getenv("POLICY_BLOB_ACCOUNT_NAME", "")
    account_key = os.getenv("POLICY_BLOB_ACCOUNT_KEY", "")

    if not account_name:
        logger.warning("POLICY_BLOB_ACCOUNT_NAME not set – blob storage unavailable")
        return None

    endpoint_suffix = os.getenv("POLICY_BLOB_ENDPOINT_SUFFIX", "blob.core.windows.net")
    account_url = f"https://{account_name}.{endpoint_suffix}"

    if account_key:
        logger.info("Policy blob storage: using account key auth")
        return BlobServiceClient(account_url=account_url, credential=account_key)

    logger.info("Policy blob storage: using DefaultAzureCredential")
    return BlobServiceClient(account_url=account_url, credential=DefaultAzureCredential())


# Module-level singleton – created once on first import
_client: Optional[BlobServiceClient] = None
_client_initialised = False


def get_blob_service_client() -> Optional[BlobServiceClient]:
    global _client, _client_initialised
    if not _client_initialised:
        try:
            _client = _build_blob_service_client()
        except Exception as e:
            logger.error(f"Failed to create BlobServiceClient: {e}")
            _client = None
        _client_initialised = True
    return _client


def download_blob_bytes(container: str, blob_path: str) -> bytes:
    """Download a blob and return its content as bytes.

    Raises RuntimeError if the blob service is unavailable or the blob
    cannot be found.
    """
    client = get_blob_service_client()
    if client is None:
        raise RuntimeError("Blob storage is not configured (check POLICY_BLOB_ACCOUNT_NAME)")

    blob_client = client.get_blob_client(container=container, blob=blob_path)
    return blob_client.download_blob().readall()


def upload_blob_bytes(
    container: str,
    blob_path: str,
    data: bytes,
    content_type: str = "application/octet-stream",
) -> str:
    """Upload bytes to a blob, creating the container if needed.

    Returns the full blob URL.
    """
    client = get_blob_service_client()
    if client is None:
        raise RuntimeError("Blob storage is not configured (check POLICY_BLOB_ACCOUNT_NAME)")

    container_client = client.get_container_client(container)
    try:
        container_client.get_container_properties()
    except Exception:
        container_client.create_container()
        logger.info(f"Created blob container: {container}")

    blob_client = container_client.get_blob_client(blob_path)
    blob_client.upload_blob(
        data,
        overwrite=True,
        content_settings=ContentSettings(content_type=content_type),
    )
    return blob_client.url


def list_blobs(container: str, name_filter: str = "") -> List[Dict[str, str]]:
    """List blobs in a container, optionally filtering by name (case-insensitive partial match).

    Returns a list of dicts with 'name', 'size', and 'last_modified'.
    """
    client = get_blob_service_client()
    if client is None:
        raise RuntimeError("Blob storage is not configured (check POLICY_BLOB_ACCOUNT_NAME)")

    container_client = client.get_container_client(container)
    results: List[Dict[str, str]] = []
    for blob in container_client.list_blobs():
        if name_filter and name_filter.lower() not in blob.name.lower():
            continue
        results.append({
            "name": blob.name,
            "size": str(blob.size),
            "last_modified": blob.last_modified.isoformat() if blob.last_modified else "",
        })
    return results
