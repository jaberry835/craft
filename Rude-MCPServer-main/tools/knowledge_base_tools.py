"""
Knowledge Base Tools for Rude MCP Server
Agentic Retrieval via Azure AI Search Knowledge Bases (2025-11-01-preview)

Uses the new Knowledge Base retrieve API which provides:
- LLM-powered query decomposition into focused subqueries
- Parallel subquery execution with semantic reranking
- Chat history awareness for multi-turn conversations
- Optional answer synthesis

Environment variables:
- KB_SEARCH_ENDPOINT: Azure AI Search endpoint (fallback to AZURE_SEARCH_ENDPOINT)
- KB_SEARCH_KEY: Azure AI Search admin/query key (fallback to AZURE_SEARCH_KEY)
- KB_NAME: Name of the knowledge base on the search service
- KB_KNOWLEDGE_SOURCE_NAME: Name of the knowledge source within the KB
- KB_REASONING_EFFORT: minimal | low | medium (default: low)
- KB_OUTPUT_MODE: extractiveData | answerSynthesis (default: extractiveData)

Security trimming (reuses RAG pattern):
- USER_ACCESS_CHECK_URL: URL to fetch user security tokens
- KB_ALLOWED_PRINCIPALS_FIELD: Field name for security tokens (default: ss_tokens)
"""

from typing import Dict, Any, List, Optional
import logging
import os
import json
import httpx

from fastmcp import FastMCP
from context import current_user_token

logger = logging.getLogger(__name__)


def _env(name: str, default: Optional[str] = None) -> Optional[str]:
    v = os.getenv(name)
    return v if v is not None else default


def register_knowledge_base_tools(mcp: FastMCP):
    """Register Knowledge Base (agentic retrieval) tools."""

    endpoint = _env("KB_SEARCH_ENDPOINT", _env("AZURE_SEARCH_ENDPOINT"))
    api_key = _env("KB_SEARCH_KEY", _env("AZURE_SEARCH_KEY"))
    kb_name = _env("KB_NAME")
    ks_name = _env("KB_KNOWLEDGE_SOURCE_NAME")
    reasoning_effort = _env("KB_REASONING_EFFORT", "low")
    output_mode = _env("KB_OUTPUT_MODE", "extractiveData")
    access_check_url = _env("USER_ACCESS_CHECK_URL")
    allowed_principals_field = _env("KB_ALLOWED_PRINCIPALS_FIELD", "ss_tokens")

    configured = bool(endpoint and api_key and kb_name)
    if not configured:
        logger.info("Knowledge Base tools not fully configured (need KB_SEARCH_ENDPOINT, KB_SEARCH_KEY, KB_NAME)")

    api_version = "2025-11-01-preview"

    async def _resolve_security_filter() -> Optional[str]:
        """Resolve user security tokens into an OData filterAddOn string.
        Returns None if no access check is configured, or raises on denial."""
        if not access_check_url:
            return None

        token = current_user_token.get()
        if not token:
            raise PermissionError("Access denied: no authentication token provided")

        headers = {"Authorization": f"Bearer {token}", "Accept": "application/json, text/plain"}
        async with httpx.AsyncClient(timeout=httpx.Timeout(connect=5, read=25, write=5, pool=5)) as client:
            resp = await client.get(access_check_url, headers=headers)

        if not resp.is_success:
            raise PermissionError(f"Access denied: authentication service unavailable (HTTP {resp.status_code})")

        tokens: List[str] = []
        try:
            data = resp.json()
            if isinstance(data, list):
                tokens = [str(t).strip() for t in data if str(t).strip()]
            elif isinstance(data, str) and data.strip():
                tokens = [data.strip()]
        except ValueError:
            raw = resp.text.strip()
            if raw:
                tokens = [raw]

        if not tokens:
            raise PermissionError("Access denied: no valid security tokens found")

        token_csv = ",".join(tokens)
        filter_expr = f"search.in({allowed_principals_field}, '{token_csv}', ',')"
        logger.info(f"KB retrieve: applied access filter with {len(tokens)} security token(s)")
        return filter_expr

    async def _kb_retrieve_core(
        messages: List[Dict[str, Any]],
        include_activity: bool = False,
        include_references: bool = True,
        override_reasoning: Optional[str] = None,
        override_output_mode: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Core retrieval against the Knowledge Base API."""
        if not configured:
            return {"success": False, "error": "Knowledge Base not configured (set KB_SEARCH_ENDPOINT, KB_SEARCH_KEY, KB_NAME)"}

        # Resolve security filter
        try:
            filter_add_on = await _resolve_security_filter()
        except PermissionError as e:
            return {"success": False, "error": str(e)}

        # Build request body
        effort = override_reasoning or reasoning_effort
        mode = override_output_mode or output_mode

        body: Dict[str, Any] = {
            "messages": messages,
            "retrievalReasoningEffort": {"kind": effort},
            "includeActivity": include_activity,
        }

        # Only set outputMode for non-minimal efforts (minimal doesn't support answerSynthesis)
        if effort != "minimal":
            body["outputMode"] = mode if mode == "answerSynthesis" else "extractiveData"

        # Add knowledge source params with optional security filter
        if ks_name:
            ks_params: Dict[str, Any] = {
                "knowledgeSourceName": ks_name,
                "kind": "searchIndex",
                "includeReferences": include_references,
                "includeReferenceSourceData": include_references,
            }
            if filter_add_on:
                ks_params["filterAddOn"] = filter_add_on
            body["knowledgeSourceParams"] = [ks_params]

        url = f"{endpoint.rstrip('/')}/knowledgebases('{kb_name}')/retrieve"
        headers = {
            "api-key": api_key,
            "Content-Type": "application/json",
            "Accept": "application/json;odata.metadata=minimal",
        }
        params = {"api-version": api_version}

        async with httpx.AsyncClient(timeout=httpx.Timeout(connect=10, read=60, write=10, pool=10)) as client:
            resp = await client.post(url, json=body, headers=headers, params=params)

        if resp.status_code not in (200, 206):
            error_text = resp.text[:500]
            logger.error(f"KB retrieve failed HTTP {resp.status_code}: {error_text}")
            return {"success": False, "error": f"HTTP {resp.status_code}: {error_text}"}

        result = resp.json()
        partial = resp.status_code == 206

        # Extract the response text
        response_text = ""
        if result.get("response"):
            for msg in result["response"]:
                for content in msg.get("content", []):
                    if content.get("type") == "text":
                        response_text += content.get("text", "")

        # Extract references
        references = []
        for ref in result.get("references", []):
            references.append({
                "type": ref.get("type"),
                "id": ref.get("id"),
                "doc_key": ref.get("docKey"),
                "reranker_score": ref.get("rerankerScore"),
                "source_data": ref.get("sourceData"),
            })

        # Extract activity summary
        activity_summary = []
        if include_activity:
            for act in result.get("activity", []):
                activity_summary.append({
                    "type": act.get("type"),
                    "id": act.get("id"),
                    "elapsed_ms": act.get("elapsedMs"),
                    "input_tokens": act.get("inputTokens"),
                    "output_tokens": act.get("outputTokens"),
                    "reasoning_tokens": act.get("reasoningTokens"),
                    "search_args": act.get("searchIndexArguments"),
                    "error": act.get("error"),
                })

        return {
            "success": True,
            "partial": partial,
            "response_text": response_text,
            "reference_count": len(references),
            "references": references,
            "activity": activity_summary if include_activity else None,
        }

    @mcp.tool
    async def kb_retrieve(query: str, include_activity: bool = False) -> Dict[str, Any]:
        """Retrieve relevant content from the Knowledge Base using agentic retrieval.

        The Knowledge Base uses an LLM to decompose complex queries into focused
        subqueries, runs them in parallel with semantic reranking, and returns
        unified results. This is best for complex, multi-part questions.

        Args:
            query: Natural language query
            include_activity: If True, includes the query plan and execution details
        """
        messages = [
            {"role": "user", "content": [{"type": "text", "text": query}]}
        ]
        return await _kb_retrieve_core(messages, include_activity=include_activity)

    @mcp.tool
    async def kb_answer(question: str, system_instructions: str = "", include_activity: bool = False) -> Dict[str, Any]:
        """Get an LLM-synthesized answer from the Knowledge Base using agentic retrieval.

        Uses answer synthesis mode — the Knowledge Base LLM formulates a complete
        answer with citations from the retrieved content.

        Args:
            question: Natural language question
            system_instructions: Optional instructions for how the answer should be formulated
            include_activity: If True, includes the query plan and execution details
        """
        messages = []
        if system_instructions:
            messages.append({
                "role": "assistant",
                "content": [{"type": "text", "text": system_instructions}]
            })
        messages.append({
            "role": "user",
            "content": [{"type": "text", "text": question}]
        })
        return await _kb_retrieve_core(
            messages,
            include_activity=include_activity,
            override_output_mode="answerSynthesis",
            override_reasoning="low",  # answer synthesis requires low or medium
        )

    @mcp.tool
    async def kb_chat_retrieve(
        messages: List[Dict[str, str]],
        include_activity: bool = False,
    ) -> Dict[str, Any]:
        """Multi-turn conversational retrieval from the Knowledge Base.

        Accepts a conversation history so the Knowledge Base LLM can use prior
        context to formulate better subqueries. Each message should have 'role'
        (user/assistant) and 'text' keys.

        Args:
            messages: List of conversation messages, each with 'role' and 'text'
            include_activity: If True, includes the query plan and execution details
        """
        formatted = []
        for msg in messages:
            role = msg.get("role", "user")
            text = msg.get("text", "")
            formatted.append({
                "role": role,
                "content": [{"type": "text", "text": text}]
            })
        if not formatted:
            return {"success": False, "error": "No messages provided"}
        return await _kb_retrieve_core(formatted, include_activity=include_activity)

    @mcp.tool
    def kb_health() -> Dict[str, Any]:
        """Report Knowledge Base tools configuration status."""
        return {
            "configured": configured,
            "endpoint": endpoint or "not_set",
            "knowledge_base": kb_name or "not_set",
            "knowledge_source": ks_name or "not_set",
            "reasoning_effort": reasoning_effort,
            "output_mode": output_mode,
            "api_version": api_version,
            "access_filter_configured": bool(access_check_url),
            "allowed_principals_field": allowed_principals_field,
        }

    logger.info("🧠 Knowledge Base tools registered: kb_retrieve, kb_answer, kb_chat_retrieve, kb_health")
