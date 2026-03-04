"""
Azure Computer Vision Tools for Rude MCP Server
Tools for analysing images (captions, tags, objects, OCR) using Azure
Cognitive Services Computer Vision (Image Analysis 3.2).

Image Analysis 3.2 is used for broad sovereign / government cloud support
(4.0 is not available in all regions).

Authentication:
  - If AZURE_CV_KEY is set, key-based authentication is used.
  - Otherwise, DefaultAzureCredential is used to obtain a bearer token
    (works with Managed Identity, az login, environment creds, etc.).

Environment variables:
- AZURE_CV_KEY: Computer Vision resource key (optional – triggers key auth)
- AZURE_CV_ENDPOINT: Resource endpoint URL, e.g.
      https://<resource>.cognitiveservices.azure.us  (Gov)
      https://<resource>.cognitiveservices.azure.com (Commercial)
- AZURE_AUTHORITY_HOST: Used to auto-detect cloud environment (Gov vs Commercial)
    for the token scope when using identity auth.
"""

import base64
import json
import os
import logging
import time
from typing import Any, Dict, List, Optional

import requests
from fastmcp import FastMCP

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Configuration from environment
# ---------------------------------------------------------------------------
CV_KEY = os.getenv("AZURE_CV_KEY", "")
CV_ENDPOINT = os.getenv("AZURE_CV_ENDPOINT", "")

# Image Analysis 3.2 API version – widely available in sovereign clouds
_API_VERSION = "2022-04-01"

# Detect cloud environment from AZURE_AUTHORITY_HOST (shared pattern)
_AUTHORITY_HOST = os.getenv("AZURE_AUTHORITY_HOST", "")
_IS_GOV = ".us" in _AUTHORITY_HOST

# Token scope for identity auth – auto-detected from cloud environment
_COGNITIVE_SCOPE = os.getenv(
    "AZURE_CV_TOKEN_SCOPE",
    "https://cognitiveservices.azure.us/.default" if _IS_GOV
    else "https://cognitiveservices.azure.com/.default",
)

# ---------------------------------------------------------------------------
# Identity credential (lazy-initialised)
# ---------------------------------------------------------------------------
_credential = None


def _get_credential():
    """Return a cached DefaultAzureCredential instance (created on first call)."""
    global _credential
    if _credential is None:
        try:
            from azure.identity import DefaultAzureCredential
            _credential = DefaultAzureCredential()
            logger.info("Azure Computer Vision: using DefaultAzureCredential for identity auth")
        except Exception as e:
            logger.error(f"Failed to create DefaultAzureCredential: {e}")
            raise RuntimeError(
                "Neither AZURE_CV_KEY nor a valid Azure identity is available. "
                "Set AZURE_CV_KEY for key auth, or ensure DefaultAzureCredential "
                "can authenticate (Managed Identity, az login, environment variables, etc.)."
            ) from e
    return _credential


def _get_identity_token() -> str:
    """Obtain a bearer token from DefaultAzureCredential."""
    cred = _get_credential()
    token = cred.get_token(_COGNITIVE_SCOPE)
    return token.token


# ---------------------------------------------------------------------------
# Header helpers
# ---------------------------------------------------------------------------

def _auth_headers() -> Dict[str, str]:
    """Build auth headers – key auth when a key is present, else identity token."""
    if CV_KEY:
        return {"Ocp-Apim-Subscription-Key": CV_KEY}
    return {"Authorization": f"Bearer {_get_identity_token()}"}


def _auth_mode() -> str:
    return "key" if CV_KEY else "identity"


# ---------------------------------------------------------------------------
# URL helpers
# ---------------------------------------------------------------------------

def _base_url() -> str:
    """Return base endpoint with trailing slash stripped."""
    return CV_ENDPOINT.rstrip("/")


# ---------------------------------------------------------------------------
# Input helpers
# ---------------------------------------------------------------------------

def _resolve_image_input(image_url: Optional[str], image_base64: Optional[str]):
    """Resolve the image input into (content_type, body) for the request.

    Returns:
        Tuple of (content_type: str, body: bytes | dict)
    """
    if image_url and image_base64:
        raise ValueError("Provide either image_url or image_base64, not both.")
    if not image_url and not image_base64:
        raise ValueError("Provide either image_url or image_base64.")

    if image_url:
        return "application/json", json.dumps({"url": image_url}).encode("utf-8")

    # Decode base64 → raw bytes
    try:
        raw = base64.b64decode(image_base64)
    except Exception as e:
        raise ValueError(f"Invalid base64 image data: {e}")
    return "application/octet-stream", raw


# ---------------------------------------------------------------------------
# Config check
# ---------------------------------------------------------------------------

def _check_configured() -> Optional[Dict[str, Any]]:
    """Return an error dict if the service is not configured, else None."""
    if not CV_ENDPOINT:
        return {
            "status": "error",
            "message": (
                "Azure Computer Vision is not configured. "
                "Set AZURE_CV_ENDPOINT to your resource endpoint URL."
            ),
            "data": None,
        }
    if CV_KEY:
        return None
    try:
        _get_credential()
        return None
    except Exception as e:
        return {
            "status": "error",
            "message": (
                "Azure Computer Vision is not configured. "
                "Either set AZURE_CV_KEY for key-based auth, "
                "or ensure DefaultAzureCredential can authenticate. "
                f"Error: {e}"
            ),
            "data": None,
        }


# ===================================================================
# Tool registration
# ===================================================================

def register_computer_vision_tools(mcp: FastMCP):
    """Register all Azure Computer Vision tools with the FastMCP server."""

    # ------------------------------------------------------------------
    # analyze_image  (Image Analysis 3.2)
    # ------------------------------------------------------------------
    # Map friendly names → 3.2 visualFeatures parameter values
    _FEATURE_MAP = {
        "tags": "Tags",
        "objects": "Objects",
        "description": "Description",
        "faces": "Faces",
        "categories": "Categories",
        "color": "Color",
        "imagetype": "ImageType",
        "adult": "Adult",
    }
    _DEFAULT_FEATURES = "tags,objects,description"

    @mcp.tool
    def analyze_image(
        image_url: Optional[str] = None,
        image_base64: Optional[str] = None,
        features: Optional[str] = None,
        language: str = "en",
    ) -> Dict[str, Any]:
        """Analyse an image using Azure Computer Vision Image Analysis 3.2.

        You must provide exactly ONE of image_url or image_base64.

        Args:
            image_url: Public URL of the image to analyse.
            image_base64: Base64-encoded image data (JPEG, PNG, GIF, BMP, TIFF, or ICO).
            features: Optional comma-separated visual features (case-insensitive).
                Defaults to "tags,objects,description".
                Valid values: tags, objects, description, faces, categories, color, imagetype, adult.
                Example: "tags,objects,description,faces"
            language: Language code for results (default "en").

        Returns:
            A dict with status and the analysis results including requested features.
        """
        err = _check_configured()
        if err:
            return err

        # Use default features when caller doesn't specify
        if not features:
            features = _DEFAULT_FEATURES

        # Sanitise features: strip spaces, trailing commas, stray quotes
        feature_list = [
            f.strip().strip('"').strip("'").lower()
            for f in features.split(",")
            if f.strip().strip('"').strip("'")
        ]

        # Validate feature names
        bad = [f for f in feature_list if f not in _FEATURE_MAP]
        if bad:
            return {
                "status": "error",
                "message": f"Invalid feature(s): {', '.join(bad)}. Valid values: {', '.join(sorted(_FEATURE_MAP.keys()))}",
                "data": None,
            }

        # Map to 3.2 API names (PascalCase)
        visual_features = ",".join(_FEATURE_MAP[f] for f in feature_list)

        try:
            content_type, body = _resolve_image_input(image_url, image_base64)
        except ValueError as ve:
            return {"status": "error", "message": str(ve), "data": None}

        params: Dict[str, str] = {
            "visualFeatures": visual_features,
            "language": language,
        }

        headers = _auth_headers()
        headers["Content-Type"] = content_type

        url = f"{_base_url()}/vision/v3.2/analyze"

        try:
            resp = requests.post(url, params=params, headers=headers, data=body, timeout=30)
            resp.raise_for_status()
            result = resp.json()

            # Build a user-friendly summary alongside the raw result
            summary_parts: List[str] = []
            if "tags" in result:
                tags = [f"{t['name']} ({t['confidence']:.2f})" for t in result.get("tags", [])]
                summary_parts.append(f"Tags: {', '.join(tags)}")
            if "objects" in result:
                objs = [
                    f"{o['object']} ({o['confidence']:.2f})"
                    for o in result.get("objects", [])
                    if o.get("object")
                ]
                summary_parts.append(f"Objects: {', '.join(objs)}")
            if "description" in result:
                captions = result["description"].get("captions", [])
                if captions:
                    cap_texts = [f"{c['text']} ({c['confidence']:.2f})" for c in captions]
                    summary_parts.append(f"Description: {', '.join(cap_texts)}")
                desc_tags = result["description"].get("tags", [])
                if desc_tags:
                    summary_parts.append(f"Description tags: {', '.join(desc_tags)}")
            if "faces" in result:
                count = len(result.get("faces", []))
                summary_parts.append(f"Faces detected: {count}")
            if "categories" in result:
                cats = [f"{c['name']} ({c['score']:.2f})" for c in result.get("categories", [])]
                summary_parts.append(f"Categories: {', '.join(cats)}")
            if "color" in result:
                color = result["color"]
                summary_parts.append(
                    f"Dominant colors: {', '.join(color.get('dominantColors', []))} | "
                    f"Accent: {color.get('accentColor', 'N/A')}"
                )

            return {
                "status": "success",
                "summary": "\n".join(summary_parts) if summary_parts else "Analysis complete (no summary data available).",
                "data": result,
            }

        except requests.exceptions.HTTPError as e:
            error_body = ""
            try:
                error_body = e.response.json()
            except Exception:
                error_body = e.response.text
            return {
                "status": "error",
                "message": f"Computer Vision API error (HTTP {e.response.status_code}): {error_body}",
                "data": None,
            }
        except Exception as e:
            return {"status": "error", "message": f"Request failed: {e}", "data": None}

    # ------------------------------------------------------------------
    # read_text_from_image (OCR — 3.2 async Read API)
    # ------------------------------------------------------------------
    @mcp.tool
    def read_text_from_image(
        image_url: Optional[str] = None,
        image_base64: Optional[str] = None,
        language: str = "en",
    ) -> Dict[str, Any]:
        """Extract printed and handwritten text from an image using Azure Computer Vision OCR (Read 3.2).

        This uses the asynchronous Read API (v3.2). The tool submits the image,
        polls for completion, and returns the extracted text.
        You must provide exactly ONE of image_url or image_base64.

        Args:
            image_url: Public URL of the image to read text from.
            image_base64: Base64-encoded image data (JPEG, PNG, GIF, BMP, TIFF, or ICO).
            language: Language hint for OCR (default "en").

        Returns:
            A dict with extracted text lines and word-level details.
        """
        err = _check_configured()
        if err:
            return err

        try:
            content_type, body = _resolve_image_input(image_url, image_base64)
        except ValueError as ve:
            return {"status": "error", "message": str(ve), "data": None}

        headers = _auth_headers()
        headers["Content-Type"] = content_type

        # Step 1: Submit the read request
        submit_url = f"{_base_url()}/vision/v3.2/read/analyze"
        params: Dict[str, str] = {"language": language}

        try:
            resp = requests.post(submit_url, params=params, headers=headers, data=body, timeout=30)
            resp.raise_for_status()
        except requests.exceptions.HTTPError as e:
            error_body = ""
            try:
                error_body = e.response.json()
            except Exception:
                error_body = e.response.text
            return {
                "status": "error",
                "message": f"OCR submit error (HTTP {e.response.status_code}): {error_body}",
                "data": None,
            }
        except Exception as e:
            return {"status": "error", "message": f"OCR submit failed: {e}", "data": None}

        # Step 2: Get the operation-location URL from the 202 response header
        operation_url = resp.headers.get("Operation-Location")
        if not operation_url:
            return {
                "status": "error",
                "message": "Read API did not return an Operation-Location header.",
                "data": None,
            }

        # Step 3: Poll for results (max ~60 seconds)
        poll_headers = _auth_headers()
        max_polls = 30
        poll_interval = 2  # seconds
        result = None

        for _ in range(max_polls):
            time.sleep(poll_interval)
            try:
                poll_resp = requests.get(operation_url, headers=poll_headers, timeout=15)
                poll_resp.raise_for_status()
                result = poll_resp.json()
                status = result.get("status", "").lower()
                if status == "succeeded":
                    break
                elif status == "failed":
                    return {
                        "status": "error",
                        "message": f"OCR read operation failed: {result}",
                        "data": result,
                    }
                # status is "running" or "notStarted" – keep polling
            except Exception as e:
                return {"status": "error", "message": f"OCR poll failed: {e}", "data": None}
        else:
            return {
                "status": "error",
                "message": "OCR read operation timed out after 60 seconds.",
                "data": result,
            }

        # Step 4: Parse the results
        lines: List[Dict[str, Any]] = []
        raw_text_parts: List[str] = []
        analyze_result = result.get("analyzeResult", {})
        for page in analyze_result.get("readResults", []):
            for line in page.get("lines", []):
                text = line.get("text", "")
                raw_text_parts.append(text)
                words = []
                for word in line.get("words", []):
                    words.append({
                        "text": word.get("text", ""),
                        "confidence": word.get("confidence", 0),
                    })
                lines.append({
                    "text": text,
                    "bounding_box": line.get("boundingBox"),
                    "words": words,
                })

        return {
            "status": "success",
            "text": "\n".join(raw_text_parts),
            "line_count": len(lines),
            "lines": lines,
            "data": result,
        }

    # ------------------------------------------------------------------
    # computer_vision_health
    # ------------------------------------------------------------------
    @mcp.tool
    def computer_vision_health() -> Dict[str, Any]:
        """Check Azure Computer Vision configuration and connectivity.

        Returns:
            A dict with configuration status and connectivity check result.
        """
        config_status = {
            "endpoint_configured": bool(CV_ENDPOINT),
            "endpoint": CV_ENDPOINT or "(not set)",
            "auth_mode": _auth_mode(),
            "cloud": "Government (.us)" if _IS_GOV else "Commercial",
            "api_version": _API_VERSION,
        }

        if not CV_ENDPOINT:
            return {
                "status": "not_configured",
                "message": "AZURE_CV_ENDPOINT is not set. Please configure the Computer Vision endpoint.",
                "config": config_status,
            }

        # Lightweight connectivity check – call the API with a tiny invalid body.
        # We expect a 4xx (validation error) for successful connectivity,
        # but a connection/timeout error means the endpoint is unreachable.
        headers = _auth_headers()
        headers["Content-Type"] = "application/json"
        url = f"{_base_url()}/vision/v3.2/analyze"
        params = {"visualFeatures": "Tags"}

        try:
            resp = requests.post(
                url,
                params=params,
                headers=headers,
                data=json.dumps({"url": "https://example.com/nonexistent.jpg"}),
                timeout=10,
            )
            # A 4xx response still means we connected to the service
            if resp.status_code < 500:
                return {
                    "status": "ok",
                    "message": "Computer Vision endpoint is reachable and auth is valid.",
                    "config": config_status,
                    "probe_http_status": resp.status_code,
                }
            else:
                return {
                    "status": "degraded",
                    "message": f"Endpoint returned HTTP {resp.status_code}.",
                    "config": config_status,
                }
        except requests.exceptions.ConnectionError:
            return {
                "status": "error",
                "message": f"Cannot connect to {CV_ENDPOINT}. Check the endpoint URL.",
                "config": config_status,
            }
        except requests.exceptions.Timeout:
            return {
                "status": "error",
                "message": f"Connection to {CV_ENDPOINT} timed out.",
                "config": config_status,
            }
        except Exception as e:
            return {
                "status": "error",
                "message": f"Health check failed: {e}",
                "config": config_status,
            }
