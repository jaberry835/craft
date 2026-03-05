"""
Azure Translator Tools for Rude MCP Server
Tools for translating text, detecting languages, transliterating text,
and performing dictionary lookups using Azure Cognitive Services Translator.

Authentication:
  - If AZURE_TRANSLATOR_KEY is set, key-based authentication is used.
  - Otherwise, DefaultAzureCredential is used to obtain a bearer token
    (works with Managed Identity, az login, environment creds, etc.).

Environment variables:
- AZURE_TRANSLATOR_KEY: Translator resource key (optional – triggers key auth)
- AZURE_TRANSLATOR_ENDPOINT: Translator endpoint (auto-detected from cloud if not set)
    Commercial: https://api.cognitive.microsofttranslator.com/
    Government: https://api.cognitive.microsofttranslator.us/
- AZURE_TRANSLATOR_REGION: Azure region for the Translator resource (required for key auth)
- AZURE_TRANSLATOR_TOKEN_SCOPE: Token scope for identity auth (auto-detected from cloud if not set)
    Commercial: https://cognitiveservices.azure.com/.default
    Government: https://cognitiveservices.azure.us/.default
- AZURE_AUTHORITY_HOST: Used to auto-detect cloud environment when endpoint/scope are not explicitly set
"""

import json
import os
import uuid
import logging
from typing import Dict, Any, List, Optional

import requests
from fastmcp import FastMCP

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Configuration from environment
# ---------------------------------------------------------------------------
TRANSLATOR_KEY = os.getenv("AZURE_TRANSLATOR_KEY", "")
TRANSLATOR_REGION = os.getenv("AZURE_TRANSLATOR_REGION", "")

API_VERSION = "3.0"

# Detect cloud environment from AZURE_AUTHORITY_HOST (used across the project)
_AUTHORITY_HOST = os.getenv("AZURE_AUTHORITY_HOST", "")
_IS_GOV = ".us" in _AUTHORITY_HOST  # e.g. https://login.microsoftonline.us

# Derive cloud-appropriate defaults; explicit env vars always win.
TRANSLATOR_ENDPOINT = os.getenv(
    "AZURE_TRANSLATOR_ENDPOINT",
    "https://api.cognitive.microsofttranslator.us" if _IS_GOV
    else "https://api.cognitive.microsofttranslator.com",
)

# The token scope required when using identity-based auth with Translator.
_COGNITIVE_SCOPE = os.getenv(
    "AZURE_TRANSLATOR_TOKEN_SCOPE",
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
            logger.info("Azure Translator: using DefaultAzureCredential for identity auth")
        except Exception as e:
            logger.error(f"Failed to create DefaultAzureCredential: {e}")
            raise RuntimeError(
                "Neither AZURE_TRANSLATOR_KEY nor a valid Azure identity is available. "
                "Set AZURE_TRANSLATOR_KEY for key auth, or ensure DefaultAzureCredential "
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

def _headers() -> Dict[str, str]:
    """Build request headers – uses key auth when a key is present, else identity token."""
    hdrs: Dict[str, str] = {
        "Content-Type": "application/json",
        "X-ClientTraceId": str(uuid.uuid4()),
    }

    if TRANSLATOR_KEY:
        # Key-based authentication
        hdrs["Ocp-Apim-Subscription-Key"] = TRANSLATOR_KEY
        if TRANSLATOR_REGION:
            hdrs["Ocp-Apim-Subscription-Region"] = TRANSLATOR_REGION
    else:
        # Identity-based (bearer token) authentication
        hdrs["Authorization"] = f"Bearer {_get_identity_token()}"

    return hdrs


def _auth_mode() -> str:
    """Return a human-readable string describing the current auth mode."""
    return "key" if TRANSLATOR_KEY else "identity"


def _is_custom_domain() -> bool:
    """Return True when TRANSLATOR_ENDPOINT is a resource-specific custom domain.

    Global endpoints contain 'microsofttranslator' in the hostname:
        https://api.cognitive.microsofttranslator.com
        https://api.cognitive.microsofttranslator.us
    Resource-specific (custom domain) endpoints look like:
        https://<resource>.cognitiveservices.azure.com
        https://<resource>.cognitiveservices.azure.us
    Custom-domain endpoints require a /translator/text/v3.0 path prefix.
    """
    return "microsofttranslator" not in TRANSLATOR_ENDPOINT.lower()


def _url(path: str) -> str:
    """Build the full request URL for a Translator API path.

    Args:
        path: The API path, e.g. '/translate', '/detect', '/languages'.
              Must start with '/'.

    Returns:
        Full URL with the correct prefix for global vs custom-domain endpoints.
    """
    base = TRANSLATOR_ENDPOINT.rstrip("/")
    if _is_custom_domain():
        # Custom domain requires the explicit service + version prefix
        return f"{base}/translator/text/v3.0{path}"
    # Global endpoint uses flat paths
    return f"{base}{path}"


def _check_configured() -> Optional[Dict[str, Any]]:
    """Return an error dict if the translator service is not configured, else None."""
    if TRANSLATOR_KEY:
        # Key auth – good to go
        return None
    # Try identity auth – verify we can create a credential
    try:
        _get_credential()
        return None
    except Exception as e:
        return {
            "status": "error",
            "message": (
                "Azure Translator is not configured. "
                "Either set AZURE_TRANSLATOR_KEY for key-based auth, "
                "or ensure DefaultAzureCredential can authenticate "
                f"(Managed Identity, az login, etc.). Error: {e}"
            ),
            "data": None,
        }


def register_translation_tools(mcp: FastMCP):
    """Register all Azure Translator tools with the FastMCP server."""

    # ------------------------------------------------------------------
    # translate_text
    # ------------------------------------------------------------------
    @mcp.tool
    def translate_text(
        text: str,
        target_language: str,
        source_language: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Translate text to a target language using Azure Translator.

        Args:
            text: The text to translate.
            target_language: BCP-47 language code to translate into, e.g. "fr" (French), "de" (German), "ja" (Japanese), "es" (Spanish), "zh-Hans" (Chinese Simplified). Do NOT pass full language names.
            source_language: Optional BCP-47 source language code, e.g. "en" (English). Auto-detected when omitted.

        Returns:
            A dict with status, translated text, detected source language, and metadata.
        """
        err = _check_configured()
        if err:
            return err

        try:
            params: Dict[str, str] = {
                "api-version": API_VERSION,
                "to": target_language,
            }
            if source_language:
                params["from"] = source_language

            body = [{"text": text}]
            url = _url("/translate")

            response = requests.post(url, params=params, headers=_headers(), json=body, timeout=30)
            response.raise_for_status()
            result = response.json()

            translations = result[0].get("translations", [])
            detected = result[0].get("detectedLanguage", {})

            return {
                "status": "success",
                "data": {
                    "translations": [
                        {"language": t["to"], "text": t["text"]}
                        for t in translations
                    ],
                    "detected_language": detected.get("language"),
                    "detected_score": detected.get("score"),
                },
                "message": f"Translated text to {target_language}",
            }

        except requests.exceptions.RequestException as e:
            logger.error(f"Translation API error: {e}")
            return {"status": "error", "message": f"Translation failed: {e}", "data": None}
        except Exception as e:
            logger.error(f"Unexpected translation error: {e}")
            return {"status": "error", "message": f"Unexpected error: {e}", "data": None}

    # ------------------------------------------------------------------
    # translate_text_multiple_languages
    # ------------------------------------------------------------------
    @mcp.tool
    def translate_text_multiple_languages(
        text: str,
        target_languages: List[str],
        source_language: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Translate text to multiple target languages in a single request.

        Args:
            text: The text to translate.
            target_languages: List of BCP-47 language codes, e.g. ["fr", "de", "ja"]. Do NOT pass full language names.
            source_language: Optional BCP-47 source language code, e.g. "en". Auto-detected when omitted.

        Returns:
            A dict with status and a list of translations for each target language.
        """
        err = _check_configured()
        if err:
            return err

        try:
            params: Dict[str, Any] = {"api-version": API_VERSION}
            # The Translator API accepts multiple 'to' query params
            param_pairs = [("to", lang) for lang in target_languages]
            if source_language:
                param_pairs.append(("from", source_language))
            param_pairs.append(("api-version", API_VERSION))

            body = [{"text": text}]
            url = _url("/translate")

            response = requests.post(
                url, params=param_pairs, headers=_headers(), json=body, timeout=30
            )
            response.raise_for_status()
            result = response.json()

            translations = result[0].get("translations", [])
            detected = result[0].get("detectedLanguage", {})

            return {
                "status": "success",
                "data": {
                    "translations": [
                        {"language": t["to"], "text": t["text"]}
                        for t in translations
                    ],
                    "detected_language": detected.get("language"),
                    "detected_score": detected.get("score"),
                },
                "message": f"Translated text to {len(target_languages)} languages",
            }

        except requests.exceptions.RequestException as e:
            logger.error(f"Multi-language translation API error: {e}")
            return {"status": "error", "message": f"Translation failed: {e}", "data": None}
        except Exception as e:
            logger.error(f"Unexpected translation error: {e}")
            return {"status": "error", "message": f"Unexpected error: {e}", "data": None}

    # ------------------------------------------------------------------
    # detect_language
    # ------------------------------------------------------------------
    @mcp.tool
    def detect_language(text: str) -> Dict[str, Any]:
        """Detect the language of a given text using Azure Translator.

        Args:
            text: The text whose language should be detected.

        Returns:
            A dict with the detected language code, name, confidence score,
            and whether translation/transliteration are supported.
        """
        err = _check_configured()
        if err:
            return err

        try:
            url = _url("/detect")
            params = {"api-version": API_VERSION}
            body = [{"text": text}]

            response = requests.post(url, params=params, headers=_headers(), json=body, timeout=30)
            response.raise_for_status()
            result = response.json()

            detection = result[0] if result else {}
            alternatives = detection.get("alternatives", [])

            return {
                "status": "success",
                "data": {
                    "language": detection.get("language"),
                    "score": detection.get("score"),
                    "is_translation_supported": detection.get("isTranslationSupported"),
                    "is_transliteration_supported": detection.get("isTransliterationSupported"),
                    "alternatives": [
                        {
                            "language": alt.get("language"),
                            "score": alt.get("score"),
                        }
                        for alt in alternatives
                    ],
                },
                "message": f"Detected language: {detection.get('language')} "
                           f"(confidence: {detection.get('score', 0):.0%})",
            }

        except requests.exceptions.RequestException as e:
            logger.error(f"Language detection API error: {e}")
            return {"status": "error", "message": f"Language detection failed: {e}", "data": None}
        except Exception as e:
            logger.error(f"Unexpected detection error: {e}")
            return {"status": "error", "message": f"Unexpected error: {e}", "data": None}

    # ------------------------------------------------------------------
    # get_supported_languages
    # ------------------------------------------------------------------
    @mcp.tool
    def get_supported_languages(
        scope: Optional[str] = None,
    ) -> Dict[str, Any]:
        """List languages supported by Azure Translator.

        Args:
            scope: Optional comma-separated scopes to return.
                   Valid values: "translation", "transliteration", "dictionary".
                   Defaults to all three when omitted.

        Returns:
            A dict mapping each scope to its supported languages with names and native names.
        """
        err = _check_configured()
        if err:
            return err

        try:
            url = _url("/languages")
            params: Dict[str, str] = {"api-version": API_VERSION}
            if scope:
                params["scope"] = scope

            # Custom-domain endpoints require auth; global ones don't but
            # sending headers anyway is harmless.
            response = requests.get(url, params=params, headers=_headers(), timeout=30)
            response.raise_for_status()
            result = response.json()

            summary: Dict[str, Any] = {}
            for section in ("translation", "transliteration", "dictionary"):
                langs = result.get(section, {})
                if langs:
                    summary[section] = {
                        "count": len(langs),
                        "languages": {
                            code: {
                                "name": info.get("name"),
                                "native_name": info.get("nativeName"),
                            }
                            for code, info in langs.items()
                        },
                    }

            return {
                "status": "success",
                "data": summary,
                "message": f"Retrieved supported languages for {list(summary.keys())}",
            }

        except requests.exceptions.RequestException as e:
            logger.error(f"Supported languages API error: {e}")
            return {"status": "error", "message": f"Failed to get supported languages: {e}", "data": None}
        except Exception as e:
            logger.error(f"Unexpected error: {e}")
            return {"status": "error", "message": f"Unexpected error: {e}", "data": None}

    # ------------------------------------------------------------------
    # transliterate_text
    # ------------------------------------------------------------------
    @mcp.tool
    def transliterate_text(
        text: str,
        language: str,
        from_script: str,
        to_script: str,
    ) -> Dict[str, Any]:
        """Convert text from one script to another (e.g. Japanese Kanji to Latin).

        Args:
            text:        The text to transliterate.
            language:    BCP-47 language code (e.g. "ja", "hi", "ar").
            from_script: Source script code (e.g. "Jpan", "Deva", "Arab").
            to_script:   Target script code (e.g. "Latn").

        Returns:
            A dict with the transliterated text and script metadata.
        """
        err = _check_configured()
        if err:
            return err

        try:
            url = _url("/transliterate")
            params = {
                "api-version": API_VERSION,
                "language": language,
                "fromScript": from_script,
                "toScript": to_script,
            }
            body = [{"text": text}]

            response = requests.post(url, params=params, headers=_headers(), json=body, timeout=30)
            response.raise_for_status()
            result = response.json()

            output = result[0] if result else {}

            return {
                "status": "success",
                "data": {
                    "text": output.get("text"),
                    "script": output.get("script"),
                },
                "message": f"Transliterated from {from_script} to {to_script}",
            }

        except requests.exceptions.RequestException as e:
            logger.error(f"Transliteration API error: {e}")
            return {"status": "error", "message": f"Transliteration failed: {e}", "data": None}
        except Exception as e:
            logger.error(f"Unexpected transliteration error: {e}")
            return {"status": "error", "message": f"Unexpected error: {e}", "data": None}

    # ------------------------------------------------------------------
    # dictionary_lookup
    # ------------------------------------------------------------------
    @mcp.tool
    def dictionary_lookup(
        text: str,
        from_language: str,
        to_language: str,
    ) -> Dict[str, Any]:
        """Look up alternative translations for a word or short phrase.

        Args:
            text:          The word or phrase to look up.
            from_language: BCP-47 source language code (e.g. "en").
            to_language:   BCP-47 target language code (e.g. "es").

        Returns:
            A dict with dictionary entries including back-translations and confidence.
        """
        err = _check_configured()
        if err:
            return err

        try:
            url = _url("/dictionary/lookup")
            params = {
                "api-version": API_VERSION,
                "from": from_language,
                "to": to_language,
            }
            body = [{"text": text}]

            response = requests.post(url, params=params, headers=_headers(), json=body, timeout=30)
            response.raise_for_status()
            result = response.json()

            entry = result[0] if result else {}
            translations = entry.get("translations", [])

            return {
                "status": "success",
                "data": {
                    "normalized_source": entry.get("normalizedSource"),
                    "display_source": entry.get("displaySource"),
                    "translations": [
                        {
                            "normalized_target": t.get("normalizedTarget"),
                            "display_target": t.get("displayTarget"),
                            "pos_tag": t.get("posTag"),
                            "confidence": t.get("confidence"),
                            "prefix_word": t.get("prefixWord"),
                            "back_translations": [
                                {
                                    "normalized_text": bt.get("normalizedText"),
                                    "display_text": bt.get("displayText"),
                                    "frequency_count": bt.get("frequencyCount"),
                                }
                                for bt in t.get("backTranslations", [])
                            ],
                        }
                        for t in translations
                    ],
                },
                "message": f"Found {len(translations)} translation(s) for '{text}' "
                           f"({from_language} → {to_language})",
            }

        except requests.exceptions.RequestException as e:
            logger.error(f"Dictionary lookup API error: {e}")
            return {"status": "error", "message": f"Dictionary lookup failed: {e}", "data": None}
        except Exception as e:
            logger.error(f"Unexpected dictionary error: {e}")
            return {"status": "error", "message": f"Unexpected error: {e}", "data": None}

    # ------------------------------------------------------------------
    # dictionary_examples
    # ------------------------------------------------------------------
    @mcp.tool
    def dictionary_examples(
        text: str,
        translation: str,
        from_language: str,
        to_language: str,
    ) -> Dict[str, Any]:
        """Get example sentences showing a word used in context with its translation.

        Args:
            text:          The source word/phrase (e.g. "fly").
            translation:   A target translation from dictionary_lookup (e.g. "volar").
            from_language: BCP-47 source language code (e.g. "en").
            to_language:   BCP-47 target language code (e.g. "es").

        Returns:
            A dict with bilingual example sentences.
        """
        err = _check_configured()
        if err:
            return err

        try:
            url = _url("/dictionary/examples")
            params = {
                "api-version": API_VERSION,
                "from": from_language,
                "to": to_language,
            }
            body = [{"text": text, "translation": translation}]

            response = requests.post(url, params=params, headers=_headers(), json=body, timeout=30)
            response.raise_for_status()
            result = response.json()

            entry = result[0] if result else {}
            examples = entry.get("examples", [])

            return {
                "status": "success",
                "data": {
                    "normalized_source": entry.get("normalizedSource"),
                    "normalized_target": entry.get("normalizedTarget"),
                    "examples": [
                        {
                            "source_prefix": ex.get("sourcePrefix"),
                            "source_term": ex.get("sourceTerm"),
                            "source_suffix": ex.get("sourceSuffix"),
                            "target_prefix": ex.get("targetPrefix"),
                            "target_term": ex.get("targetTerm"),
                            "target_suffix": ex.get("targetSuffix"),
                        }
                        for ex in examples
                    ],
                },
                "message": f"Found {len(examples)} example(s) for '{text}' → '{translation}'",
            }

        except requests.exceptions.RequestException as e:
            logger.error(f"Dictionary examples API error: {e}")
            return {"status": "error", "message": f"Dictionary examples failed: {e}", "data": None}
        except Exception as e:
            logger.error(f"Unexpected dictionary examples error: {e}")
            return {"status": "error", "message": f"Unexpected error: {e}", "data": None}

    # ------------------------------------------------------------------
    # translator_health
    # ------------------------------------------------------------------
    @mcp.tool
    def translator_health() -> Dict[str, Any]:
        """Check connectivity and configuration of the Azure Translator service.

        Returns:
            A dict with configuration status and whether the service is reachable.
        """
        config_ok = _check_configured() is None
        auth_mode = _auth_mode()
        reachable = False
        languages_count = 0

        if config_ok:
            try:
                url = _url("/languages")
                resp = requests.get(url, params={"api-version": API_VERSION}, headers=_headers(), timeout=10)
                resp.raise_for_status()
                data = resp.json()
                languages_count = len(data.get("translation", {}))
                reachable = True
            except Exception as e:
                logger.warning(f"Translator health check failed: {e}")

        return {
            "status": "success" if config_ok and reachable else "degraded",
            "data": {
                "configured": config_ok,
                "auth_mode": auth_mode,
                "endpoint": TRANSLATOR_ENDPOINT,
                "region": TRANSLATOR_REGION or "not set",
                "reachable": reachable,
                "supported_languages_count": languages_count,
            },
            "message": (
                f"Azure Translator is operational (auth: {auth_mode})"
                if config_ok and reachable
                else "Azure Translator is not fully configured or unreachable"
            ),
        }
