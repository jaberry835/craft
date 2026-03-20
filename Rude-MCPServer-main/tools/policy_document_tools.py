
"""
Policy Document Tools for Rude MCP Server

Provides MCP tools for listing templates, inspecting placeholders,
previewing resolved payloads, and generating filled Word / Excel
policy documents.

Templates are discovered from Azure Blob Storage at runtime.
Any .docx / .xlsx blob in the template container is a valid template.

Callers interact via blob file names (the ``name`` parameter) and
never see storage-account details.
"""

import json
import os
import uuid
import logging
from datetime import datetime, timezone
from typing import Dict, Any, Optional
from pathlib import PurePosixPath

from fastmcp import FastMCP

logger = logging.getLogger(__name__)

# In-memory registry of generated documents for the download endpoint.
# Maps document_id -> {container, blob_path, content_type, file_name}
_generated_documents: Dict[str, Dict[str, str]] = {}


def _get_server_base_url() -> str:
    """Return the server's external base URL.

    Uses WEBSITE_HOSTNAME (set automatically on Azure App Service),
    falls back to MCP_SERVER_URL env var, or localhost:8000.
    """
    hostname = os.getenv("WEBSITE_HOSTNAME")
    if hostname:
        scheme = "https" if not hostname.startswith("localhost") else "http"
        return f"{scheme}://{hostname}"
    return os.getenv("MCP_SERVER_URL", "http://localhost:8000")


def _template_type_from_name(blob_name: str) -> Optional[str]:
    """Return 'docx' or 'xlsx' based on the file extension, or None."""
    ext = PurePosixPath(blob_name).suffix.lower().lstrip(".")
    return ext if ext in ("docx", "xlsx") else None


# ── Content-type helpers ────────────────────────────────────────────

_CONTENT_TYPES = {
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}


# ── Tool registration ──────────────────────────────────────────────

def register_policy_document_tools(mcp: FastMCP):
    """Register policy-document MCP tools with the server."""

    from services.blob_storage_service import download_blob_bytes, upload_blob_bytes, list_blobs
    from services.template_engine import fill_docx, fill_xlsx, extract_placeholders

    template_container = os.getenv("POLICY_BLOB_TEMPLATE_CONTAINER", "policy-templates")
    output_container = os.getenv("POLICY_BLOB_OUTPUT_CONTAINER", "policy-output")

    # ----------------------------------------------------------------
    # Tool 1 – List available templates (from blob storage)
    # ----------------------------------------------------------------

    @mcp.tool
    def list_policy_templates(name: str = "") -> Dict[str, Any]:
        """List policy document templates stored in the template container.

        Discovers .docx and .xlsx files from Azure Blob Storage.

        Args:
            name: Optional partial file name to filter by (case-insensitive).
                  Leave empty to list all templates.

        Returns:
            A dictionary with a list of template summaries.
        """
        try:
            blobs = list_blobs(template_container, name_filter=name)
        except Exception as exc:
            logger.error(f"Failed to list templates: {exc}")
            return {"success": False, "error": f"Could not list templates: {exc}"}

        results = []
        for b in blobs:
            ttype = _template_type_from_name(b["name"])
            if ttype is None:
                continue  # skip non-template files
            results.append({
                "template_name": b["name"],
                "template_type": ttype,
                "size": b["size"],
                "last_modified": b["last_modified"],
            })
        return {"success": True, "templates": results, "count": len(results)}

    # ----------------------------------------------------------------
    # Tool 2 – Get fields / placeholders for a template
    # ----------------------------------------------------------------

    @mcp.tool
    def get_template_fields(template_name: str) -> Dict[str, Any]:
        """Return the placeholder fields found in a policy template.

        Downloads the template and extracts placeholder names from
        ``{{field}}`` text markers and Word Content Controls.

        Args:
            template_name: Blob file name (e.g. "Contoso_Policy_Template.docx").

        Returns:
            A dictionary listing the fields/placeholders in the template.
        """
        ttype = _template_type_from_name(template_name)
        if ttype is None:
            return {"success": False, "error": f"Unsupported file type: {template_name}"}

        # Always extract placeholders from the actual document
        try:
            template_bytes = download_blob_bytes(template_container, template_name)
        except Exception as exc:
            logger.error(f"Failed to download template '{template_name}': {exc}")
            return {"success": False, "error": f"Could not load template: {exc}"}

        placeholders = extract_placeholders(template_bytes, ttype)
        return {
            "success": True,
            "template_name": template_name,
            "template_type": ttype,
            "source": "extracted",
            "placeholders": placeholders,
            "note": "These placeholders were extracted from the document. "
                    "All are treated as optional.",
        }

    # ----------------------------------------------------------------
    # Tool 3 – Preview / validate a document payload
    # ----------------------------------------------------------------

    @mcp.tool
    def preview_policy_document(template_name: str, field_data: str) -> Dict[str, Any]:
        """Validate field data against a template and preview the resolved payload.

        Downloads the template, extracts its placeholders, and
        cross-references them with the supplied field data.  Reports
        which fields are matched, which are missing from the data, and
        which extra fields were supplied that don't appear in the
        template.

        This does NOT generate a document — it lets the caller verify
        the data before committing to generation.

        Args:
            template_name: Blob file name of the template.
            field_data:    JSON string mapping placeholder names to values.

        Returns:
            Validation result with matched, missing, and extra fields
            plus the resolved payload.
        """
        ttype = _template_type_from_name(template_name)
        if ttype is None:
            return {"success": False, "error": f"Unsupported file type: {template_name}"}

        try:
            parsed_data = json.loads(field_data)
        except (json.JSONDecodeError, TypeError) as exc:
            return {"success": False, "error": f"Invalid JSON in field_data: {exc}"}

        # Download template and extract its placeholders
        try:
            template_bytes = download_blob_bytes(template_container, template_name)
        except Exception as exc:
            logger.error(f"Failed to download template '{template_name}': {exc}")
            return {"success": False, "error": f"Could not load template: {exc}"}

        placeholders = extract_placeholders(template_bytes, ttype)
        placeholder_set = set(placeholders)
        supplied_set = set(parsed_data.keys())

        matched = sorted(placeholder_set & supplied_set)
        missing = sorted(placeholder_set - supplied_set)
        extra = sorted(supplied_set - placeholder_set)

        merged = dict(parsed_data)
        is_valid = len(missing) == 0

        return {
            "success": True,
            "template_name": template_name,
            "template_type": ttype,
            "validation_passed": is_valid,
            "placeholders": placeholders,
            "matched_fields": matched,
            "missing_fields": missing,
            "extra_fields": extra,
            "resolved_payload": merged,
            "message": (
                "Validation passed. Call generate_policy_document to produce the file."
                if is_valid
                else f"Missing {len(missing)} required field(s): {', '.join(missing)}. "
                     "Add them to field_data or proceed with unfilled placeholders."
            ),
        }

    # ----------------------------------------------------------------
    # Tool 4 – Generate the filled document
    # ----------------------------------------------------------------

    @mcp.tool
    def generate_policy_document(
        template_name: str,
        field_data: str,
        output_name: str = None,
        category_tag: str = None,
    ) -> Dict[str, Any]:
        """Generate a filled policy document from a template.

        The template is fetched from Azure Blob Storage, placeholders
        are replaced with the supplied field values, and the result is
        stored back into blob storage.  The caller receives a
        structured result with document metadata and a download URL.

        Args:
            template_name: Blob file name of the template.
            field_data:    JSON string mapping placeholder names to values.
            output_name:   Optional custom file stem for the generated file.
            category_tag:  Optional category tag stored in result metadata.

        Returns:
            A dictionary containing document_id, download_url, and
            generation details.
        """
        ttype = _template_type_from_name(template_name)
        if ttype is None:
            return {"success": False, "error": f"Unsupported file type: {template_name}"}

        try:
            parsed_data = json.loads(field_data)
        except (json.JSONDecodeError, TypeError) as exc:
            return {"success": False, "error": f"Invalid JSON in field_data: {exc}"}

        merged = dict(parsed_data)

        # 1. Download template from blob storage
        try:
            template_bytes = download_blob_bytes(template_container, template_name)
        except Exception as exc:
            logger.error(f"Failed to download template '{template_name}': {exc}")
            return {"success": False, "error": f"Could not load template: {exc}"}

        # 2. Fill the template
        try:
            if ttype == "docx":
                filled_bytes = fill_docx(template_bytes, merged)
            elif ttype == "xlsx":
                filled_bytes = fill_xlsx(template_bytes, merged)
            else:
                return {"success": False, "error": f"Unsupported template type: {ttype}"}
        except Exception as exc:
            logger.error(f"Template fill failed: {exc}")
            return {"success": False, "error": f"Template fill failed: {exc}"}

        # 3. Determine output blob path
        document_id = uuid.uuid4().hex
        stem = PurePosixPath(template_name).stem
        file_stem = output_name or f"{stem}-{document_id[:8]}"
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%d")
        output_blob_path = f"{timestamp}/{file_stem}.{ttype}"

        # 4. Upload filled document
        content_type = _CONTENT_TYPES.get(ttype, "application/octet-stream")
        try:
            upload_blob_bytes(output_container, output_blob_path, filled_bytes, content_type)
        except Exception as exc:
            logger.error(f"Failed to upload generated document: {exc}")
            return {"success": False, "error": f"Could not store generated document: {exc}"}

        logger.info(f"Generated policy document '{output_blob_path}' (id={document_id})")

        # Store metadata so the HTTP download endpoint can serve this file
        file_name = PurePosixPath(output_blob_path).name
        _generated_documents[document_id] = {
            "container": output_container,
            "blob_path": output_blob_path,
            "content_type": content_type,
            "file_name": file_name,
        }

        download_url = f"{_get_server_base_url()}/api/download/{document_id}"

        return {
            "success": True,
            "document_id": document_id,
            "template_name": template_name,
            "output_blob_path": output_blob_path,
            "download_url": download_url,
            "content_type": content_type,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "category_tag": category_tag,
            "fields_used": merged,
            "message": f"Document generated successfully. Download it here: {download_url}",
        }


