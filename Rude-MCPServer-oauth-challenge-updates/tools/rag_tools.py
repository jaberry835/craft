"""
RAG RAG Tools for Rude MCP Server
Lightweight Retrieval-Augmented Generation over an Azure AI Search index
configured specifically for RAG-related data.

Environment variables (all optional except index):
- RAG_SEARCH_ENDPOINT: Azure AI Search endpoint (fallback to AZURE_SEARCH_ENDPOINT)
- RAG_SEARCH_KEY: Azure AI Search admin/query key (fallback to AZURE_SEARCH_KEY)
- RAG_SEARCH_INDEX_NAME: Index name for RAG data (required for retrieval)
- RAG_CONTENT_FIELD: Name of the text content field (default: content)
- RAG_VECTOR_FIELD: Name of the vector field for embeddings (default: contentVector)

For RAG answers (optional):
- AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY
- AZURE_OPENAI_EMBEDDING_DEPLOYMENT (for hybrid/vector search)
- AZURE_OPENAI_CHAT_DEPLOYMENT (for generating answers)
"""

from typing import Dict, Any, List, Optional
import logging
import os
import base64
import re
from urllib.parse import quote
import requests

from fastmcp import FastMCP
from context import current_user_token

logger = logging.getLogger(__name__)

# Optional Azure dependencies
try:
    from azure.search.documents import SearchClient
    from azure.search.documents.models import VectorizedQuery
    from azure.core.credentials import AzureKeyCredential
    from openai import AzureOpenAI
    AZURE_AVAILABLE = True
except Exception as e:
    AZURE_AVAILABLE = False
    logger.warning(f"Azure SDK packages not fully available for RAG tools: {e}")


def _env(name: str, default: Optional[str] = None) -> Optional[str]:
    v = os.getenv(name)
    return v if v is not None else default


def _extract_content(doc: Dict[str, Any], content_field: str) -> str:
    # Try configured field first, then common fallbacks
    for key in [content_field, "content", "text", "page_content", "chunk", "body"]:
        if isinstance(doc, dict) and key in doc and isinstance(doc[key], str) and doc[key].strip():
            return doc[key]
    # Last resort: stringify
    return str(doc)[:2000]


def _safe_b64_decode(value: str) -> Optional[str]:
    """Decode base64 strings with optional padding; return None on failure."""
    try:
        if not value:
            return None
        padding = '=' * (-len(value) % 4)
        decoded = base64.b64decode(value + padding, validate=False)
        return decoded.decode('utf-8', errors='ignore')
    except Exception:
        return None


def _strip_trailing_chunk_suffix(url: str) -> str:
    """Strip numeric suffix right after a known extension (e.g., .pdf5 -> .pdf)."""
    try:
        return re.sub(r'(\.(pdf|docx?|txt|html?))\d+$', r'\1', url, flags=re.IGNORECASE)
    except Exception:
        return url


def _infer_source_url(doc: Dict[str, Any]) -> Optional[str]:
    """
    Infer a stable blob URL for the source doc:
    1) If parent_id is base64 URL or direct URL, decode/return it (normalized)
    2) Else, construct from storage env + RAG container + title (best-effort)
    """
    parent_id = doc.get("parent_id")
    title = (doc.get("title") or "").strip()

    if isinstance(parent_id, str) and parent_id:
        if parent_id.startswith("http"):
            return _strip_trailing_chunk_suffix(parent_id)
        decoded = _safe_b64_decode(parent_id)
        if decoded and decoded.startswith("http"):
            return _strip_trailing_chunk_suffix(decoded)

    account = os.getenv("AZURE_STORAGE_ACCOUNT_NAME")
    suffix = os.getenv("AZURE_STORAGE_ENDPOINT_SUFFIX", "core.windows.net")
    container = os.getenv("RAG_STORAGE_CONTAINER_NAME", "fema")
    if account and title:
        return f"https://{account}.blob.{suffix}/{container}/{quote(title)}"
    return None


def register_rag_tools(mcp: FastMCP):
    """Register RAG retrieval and RAG tools."""

    search_client = None
    openai_client: Optional[AzureOpenAI] = None

    content_field = _env("RAG_CONTENT_FIELD", "content")
    vector_field = _env("RAG_VECTOR_FIELD", "contentVector")
    allowed_principals_field = _env("RAG_ALLOWED_PRINCIPALS_FIELD", "allowedPrincipals")
    access_check_url = _env("USER_ACCESS_CHECK_URL")

    if AZURE_AVAILABLE:
        # Build Search client
        endpoint = _env("RAG_SEARCH_ENDPOINT", _env("AZURE_SEARCH_ENDPOINT"))
        api_key = _env("RAG_SEARCH_KEY", _env("AZURE_SEARCH_KEY"))
        index_name = _env("RAG_SEARCH_INDEX_NAME") or _env("AZURE_SEARCH_INDEX_NAME") or _env("AZURE_SEARCH_INDEX")

        if endpoint and api_key and index_name:
            try:
                search_client = SearchClient(endpoint, index_name, AzureKeyCredential(api_key))
                logger.info(f"✅ RAG Search client ready (index={index_name})")
            except Exception as e:
                logger.error(f"❌ Failed to init RAG Search client: {e}")
        else:
            logger.info("RAG Search not fully configured (need endpoint, key, index)")

        # Build Azure OpenAI client if configured
        aoai_endpoint = _env("AZURE_OPENAI_ENDPOINT")
        aoai_key = _env("AZURE_OPENAI_API_KEY")
        if aoai_endpoint and aoai_key:
            try:
                openai_client = AzureOpenAI(azure_endpoint=aoai_endpoint, api_key=aoai_key, api_version="2024-02-01")
                logger.info("✅ Azure OpenAI client initialized for RAG tools")
            except Exception as e:
                logger.error(f"❌ Failed to init Azure OpenAI client: {e}")

    async def _embed(text: str) -> Optional[List[float]]:
        if not openai_client:
            return None
        try:
            deployment = _env("AZURE_OPENAI_EMBEDDING_DEPLOYMENT", "text-embedding-ada-002")
            resp = openai_client.embeddings.create(input=text, model=deployment)
            return resp.data[0].embedding
        except Exception as e:
            logger.debug(f"Embedding failed, falling back to text-only search: {e}")
            return None

    async def _rag_retrieve_core(query: str, top_k: int) -> Dict[str, Any]:
        """Internal retrieval function to avoid calling decorated tools from tools."""
        if not search_client:
            return {"success": False, "error": "RAG search not configured", "results": []}

        top_k = max(1, min(int(top_k), 20))

        # Try to get an embedding for hybrid search
        vector = await _embed(query)

        kwargs: Dict[str, Any] = {
            "search_text": query,
            "top": top_k,
            "select": [content_field, "title", "parent_id"],
            "highlight_fields": content_field,
        }

        # Security trimming via caller principals
        try:
            if access_check_url:
                token = current_user_token.get()
                if token:
                    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json, text/plain"}
                    resp = requests.get(access_check_url, headers=headers, timeout=5)
                    if resp.ok:
                        raw = resp.text.strip()
                        groups: List[str] = []
                        # Try JSON first
                        try:
                            data = resp.json()
                            if isinstance(data, str):
                                raw = data
                            elif isinstance(data, dict):
                                if isinstance(data.get("groups"), list):
                                    groups = [str(g).strip() for g in data.get("groups") if str(g).strip()]
                                elif isinstance(data.get("allowedPrincipals"), list):
                                    groups = [str(g).strip() for g in data.get("allowedPrincipals") if str(g).strip()]
                                elif data.get("group"):
                                    groups = [str(data.get("group")).strip()]
                                elif data.get("access"):
                                    raw = str(data.get("access")).strip()
                        except ValueError:
                            # Not JSON; treat as plain text
                            pass

                        if not groups and raw:
                            # Split CSV or semicolon list
                            sep = "," if "," in raw else ";" if ";" in raw else None
                            groups = [raw.strip()] if not sep else [p.strip() for p in raw.split(sep)]

                        # Build filter expression if we have any identifiers
                        groups = [g for g in groups if g]
                        # Log the access-check outcome for visibility
                        try:
                            raw_preview = raw if raw is not None and len(raw) <= 500 else (raw[:500] + "...") if raw else ""
                            logger.info(
                                f"RAG access-check: url={access_check_url} status=OK principals_raw='{raw_preview}' parsed_groups={groups}"
                            )
                        except Exception:
                            pass
                        if groups:
                            parts = [f"search.in({allowed_principals_field}, '{gid}', ',')" for gid in groups]
                            filter_expr = " or ".join(parts)
                            kwargs["filter"] = filter_expr
                            logger.info(f"RAG retrieve: applied access filter with {len(groups)} principal(s)")
                        else:
                            logger.warning("RAG retrieve: access check returned no principals; denying access")
                            return {"success": False, "error": "Access denied: no valid principals found", "results": []}
                    else:
                        logger.warning(f"RAG retrieve: access check failed HTTP {resp.status_code}; denying access")
                        return {"success": False, "error": f"Access denied: authentication service unavailable (HTTP {resp.status_code})", "results": []}
                else:
                    logger.warning("RAG retrieve: no user token present; denying access")
                    return {"success": False, "error": "Access denied: no authentication token provided", "results": []}
        except Exception as e:
            logger.warning(f"RAG retrieve: access filter setup error: {e}; denying access")
            return {"success": False, "error": f"Access denied: authentication error ({str(e)})", "results": []}

        # Optional semantic configuration support
        semantic_config = _env("RAG_SEMANTIC_CONFIGURATION")
        if semantic_config:
            kwargs["query_type"] = "semantic"
            kwargs["semantic_configuration_name"] = semantic_config

        if vector is not None:
            try:
                kwargs["vector_queries"] = [VectorizedQuery(vector=vector, k_nearest_neighbors=top_k, fields=vector_field)]
                logger.info("RAG retrieve: using hybrid search")
            except Exception as e:
                logger.debug(f"Could not add vector query: {e}")

        results: List[Dict[str, Any]] = []
        for r in search_client.search(**kwargs):
            doc = dict(r)
            content = _extract_content(doc, content_field)
            score = getattr(r, "@search.score", None)
            source_url = _infer_source_url(doc)
            file_name = (doc.get("title") or "").strip() or None
            results.append({
                "content": content,
                "score": score,
                "source_url": source_url,
                "file_name": file_name,
                "metadata": {k: v for k, v in doc.items() if k not in [content_field, "content", "text", "page_content"]}
            })

        return {"success": True, "query": query, "count": len(results), "results": results}

    @mcp.tool
    async def rag_retrieve(query: str, top_k: int = 5) -> Dict[str, Any]:
        """Retrieve top passages from the RAG search index.

        Args:
            query: Natural language query about RAG data
            top_k: Number of passages to return (default 5)
        """
        try:
            return await _rag_retrieve_core(query, top_k)
        except Exception as e:
            logger.error(f"RAG retrieve error: {e}")
            return {"success": False, "error": str(e), "results": []}

    @mcp.tool
    async def rag_rag_answer(question: str, top_k: int = 5, temperature: float = 0.2, max_tokens: int = 700) -> Dict[str, Any]:
        """Answer a RAG question using RAG over the RAG index.

        Requires Azure OpenAI for generation; if not configured, returns retrieved contexts only.
        """
        try:
            # First retrieve contexts (call internal helper, not the decorated tool)
            retrieval = await _rag_retrieve_core(question, top_k)
            if not retrieval.get("success"):
                return retrieval

            contexts: List[Dict[str, Any]] = retrieval.get("results", [])
            if not contexts:
                return {"success": False, "error": "No relevant context found", "answer": "", "contexts": []}

            # Build sources aligned to [Doc N]
            sources = []
            for i, c in enumerate(contexts, start=1):
                sources.append({
                    "doc": i,
                    "title": c.get("file_name"),
                    "url": c.get("source_url"),
                })

            # If no OpenAI client, return contexts only
            if not openai_client:
                joined = "\n\n".join([c["content"] for c in contexts])
                summary = (joined[:1000] + "...") if len(joined) > 1000 else joined
                return {
                    "success": True,
                    "answer": "Generation not configured. Returning relevant excerpts only.",
                    "contexts": contexts,
                    "sources": sources,
                    "context_preview": summary
                }

            chat_deployment = _env("AZURE_OPENAI_CHAT_DEPLOYMENT", "gpt-4o-mini")

            # Build messages with concise but useful context
            context_blocks = []
            for i, c in enumerate(contexts, start=1):
                content = c.get("content", "")
                if len(content) > 1500:
                    content = content[:1500] + "..."
                context_blocks.append(f"[Doc {i}]\n{content}")
            context_text = "\n\n".join(context_blocks)

            system_prompt = (
                "You are a helpful assistant answering questions using RAG-related documents. "
                "Use only the provided context to answer accurately and concisely. "
                "If the answer is not in the context, say you don't have enough information. "
                "Cite sources by [Doc N] when relevant."
            )

            user_prompt = (
                f"Question: {question}\n\n"
                f"Context:\n{context_text}\n\n"
                "Answer:"
            )

            resp = openai_client.chat.completions.create(
                model=chat_deployment,
                temperature=float(temperature),
                max_tokens=int(max_tokens),
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
            )

            answer = resp.choices[0].message.content if resp and resp.choices else ""

            return {
                "success": True,
                "answer": answer,
                "contexts": contexts,
                "sources": sources,
                "model": chat_deployment,
            }
        except Exception as e:
            logger.error(f"RAG RAG answer error: {e}")
            return {"success": False, "error": str(e)}

    @mcp.tool
    def rag_health() -> Dict[str, Any]:
        """Report RAG tools configuration status."""
        endpoint = _env("RAG_SEARCH_ENDPOINT", _env("AZURE_SEARCH_ENDPOINT"))
        index_name = _env("RAG_SEARCH_INDEX_NAME") or _env("AZURE_SEARCH_INDEX_NAME") or _env("AZURE_SEARCH_INDEX")
        aoai = bool(_env("AZURE_OPENAI_ENDPOINT") and _env("AZURE_OPENAI_API_KEY"))
        return {
            "search_configured": bool(search_client is not None),
            "endpoint": endpoint or "not_set",
            "index": index_name or "not_set",
            "content_field": content_field,
            "vector_field": vector_field,
            "generation_enabled": aoai,
            "access_filter_configured": bool(access_check_url),
            "allowed_principals_field": allowed_principals_field,
        }

    logger.info("📚 RAG tools registered: rag_retrieve, rag_rag_answer, rag_health")
