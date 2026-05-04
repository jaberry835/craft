"""
Assist API Routes (Browser Extension surface)

Additive endpoints that let a browser extension lean on the existing
Security Package orchestrator agent (and its MCP tools / policy grounding)
without going through the chat UI.

Three endpoints:
  - POST /api/assist/explain-page    -> plain-language explanation of a wizard page
  - POST /api/assist/suggest-field   -> per-field value + rationale + citations
  - POST /api/assist/build-package   -> final security package as { json, html }

All three are thin wrappers that build a focused user message and run the
configured orchestrator agent via agent_manager.execute_single, aggregating
the streamed text into a single response. The HTML preview block emitted by
the agent (```html_preview ... ```) is extracted and returned as `html`.

Nothing in the existing chat / admin flow is modified.
"""
from __future__ import annotations

import json
import re
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from auth.middleware import get_current_user, get_user_token
from observability import get_logger
from services.agent_manager import agent_manager, ChatterEvent, OrchestrationPattern
from services.cosmos_service import cosmos_service
from services.orchestration import AgentResponse

router = APIRouter(prefix="/api/assist", tags=["assist"])
logger = get_logger(__name__)

# Same fence the chat path uses; reused so build-package can return rendered HTML.
_HTML_PREVIEW_RE = re.compile(r"```html_preview\s*\n(.*?)```", re.DOTALL)
_JSON_FENCE_RE = re.compile(r"```json\s*\n(.*?)```", re.DOTALL)


# =============================================================================
# Request / Response models
# =============================================================================

class PageField(BaseModel):
    """A single form field extracted from the active wizard page."""
    model_config = {"extra": "allow"}  # accept _step and other extension-side annotations
    label: str = Field(..., description="Visible label or aria-label")
    name: Optional[str] = Field(default=None, description="Input name/id")
    type: Optional[str] = Field(default=None, description="Input type (text, select, checkbox, ...)")
    value: Optional[Any] = Field(default=None, description="Current value, if any")
    options: Optional[list[str]] = Field(default=None, description="Choices for select/radio")
    required: Optional[bool] = None
    help_text: Optional[str] = None
    validation_message: Optional[str] = None


class PageContext(BaseModel):
    """Lightweight description of the page the user is on."""
    url: Optional[str] = None
    page_title: Optional[str] = None
    section: Optional[str] = Field(default=None, description="Wizard step / section name")
    summary: Optional[str] = Field(default=None, description="Short text the user highlighted or page intro")


class WizardContext(BaseModel):
    """Accumulated state across all wizard steps the user has visited.

    Sent on every assist call so the agent can suggest values that are
    consistent with what was entered on prior steps.
    """
    key: Optional[str] = Field(default=None, description="Stable wizard id (origin+pathname)")
    steps: list[str] = Field(default_factory=list, description="Step labels visited so far")
    fields: list[PageField] = Field(
        default_factory=list,
        description="Every field seen across the wizard, latest value wins",
    )


class AssistExplainRequest(BaseModel):
    agent_id: str = Field(..., description="Security Package orchestrator agent id")
    specialist_agent_ids: list[str] = Field(
        default_factory=list,
        description="Optional specialist agents the primary agent may consult via A2A.",
    )
    page: PageContext
    fields: list[PageField] = Field(default_factory=list)
    wizard: Optional[WizardContext] = None


class AssistSuggestFieldRequest(BaseModel):
    agent_id: str
    specialist_agent_ids: list[str] = Field(default_factory=list)
    page: PageContext
    field: PageField
    app_metadata: Optional[dict[str, Any]] = Field(
        default=None,
        description="Anything the extension already knows about the application being filed",
    )
    wizard: Optional[WizardContext] = None


class AssistBuildPackageRequest(BaseModel):
    agent_id: str
    specialist_agent_ids: list[str] = Field(default_factory=list)
    app_metadata: Optional[dict[str, Any]] = None
    collected_fields: list[PageField] = Field(
        default_factory=list,
        description="Field values the user has filled in so far across the wizard",
    )
    page: Optional[PageContext] = None
    wizard: Optional[WizardContext] = None


class AssistAskRequest(BaseModel):
    """Free-form question, optionally with current-page context."""
    agent_id: str
    specialist_agent_ids: list[str] = Field(default_factory=list)
    question: str = Field(..., min_length=1)
    page: Optional[PageContext] = None
    fields: list[PageField] = Field(default_factory=list)
    wizard: Optional[WizardContext] = None


class AssistDeployRequest(BaseModel):
    """Deploy a previously-approved HTML preview to the static site."""
    agent_id: str
    specialist_agent_ids: list[str] = Field(default_factory=list)
    html_content: str = Field(..., min_length=1, description="Approved html_preview content")
    project_name: str = Field(..., min_length=1, description="URL-safe slug")
    display_name: Optional[str] = None
    description: Optional[str] = None
    owner: Optional[str] = None
    wizard: Optional[WizardContext] = None


class AssistResponse(BaseModel):
    text: str = Field(..., description="Cleaned assistant text (html_preview blocks stripped)")
    html: Optional[str] = Field(default=None, description="Last html_preview block, if present")
    json_data: Optional[Any] = Field(
        default=None,
        description="Parsed JSON payload extracted from a ```json fenced block, if present",
    )
    agent_id: str
    agent_name: Optional[str] = None


# =============================================================================
# Helpers
# =============================================================================

def _extract_blocks(text: str) -> tuple[str, Optional[str], Optional[Any]]:
    """Strip html_preview / json fenced blocks. Return (cleaned_text, html, json_data).

    Both the html_preview and json fences are removed from `cleaned` so the
    side-panel chat shows only the human-readable prose. Structured data is
    still returned to the caller via `html` and `json_data` for the Preview
    / JSON tabs and for any UI that needs it (e.g. the "Insert suggestion"
    button uses `json_data.suggestion`).
    """
    html_blocks = _HTML_PREVIEW_RE.findall(text)
    cleaned = _HTML_PREVIEW_RE.sub("", text)

    json_data: Optional[Any] = None
    json_blocks = _JSON_FENCE_RE.findall(cleaned)
    if json_blocks:
        try:
            json_data = json.loads(json_blocks[0])
        except json.JSONDecodeError:
            json_data = None
    # Always strip the json fence from the chat text — the parsed object is
    # surfaced separately via json_data, and the raw fenced JSON is noise in
    # a narrow side panel.
    cleaned = _JSON_FENCE_RE.sub("", cleaned).strip()
    # Collapse any leftover triple-blank lines created by the strips.
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)

    html = html_blocks[-1].strip() if html_blocks else None
    return cleaned, html, json_data


async def _resolve_agent_name(agent_id: str) -> Optional[str]:
    try:
        cfg = await cosmos_service.get_agent(agent_id)
        return cfg.get("name") if cfg else None
    except Exception:  # pragma: no cover - non-fatal
        return None


async def _run_agent(agent_id: str, user_message: str, user_token: Optional[str]) -> str:
    """Run the agent once and aggregate streamed text into a single string."""
    chunks: list[str] = []
    try:
        async for piece in agent_manager.execute_single(
            agent_id=agent_id,
            messages=[{"role": "user", "content": user_message}],
            user_token=user_token,
            include_chatter=False,
        ):
            if isinstance(piece, ChatterEvent):
                continue
            if isinstance(piece, str):
                chunks.append(piece)
    except ValueError as e:
        # Agent not found / not configured
        raise HTTPException(status_code=404, detail=str(e))
    except HTTPException:
        raise
    except BaseException as e:  # noqa: BLE001 - catch ExceptionGroups too
        # anyio TaskGroup wraps real errors in ExceptionGroup; unwrap for log clarity.
        inner = e
        try:
            from builtins import BaseExceptionGroup  # py3.11+
            if isinstance(e, BaseExceptionGroup) and e.exceptions:
                inner = e.exceptions[0]
        except Exception:
            pass
        logger.error(
            f"assist: agent {agent_id} execution failed: {type(inner).__name__}: {inner}",
            exc_info=True,
        )
        raise HTTPException(
            status_code=500,
            detail=f"Agent execution failed: {type(inner).__name__}: {inner}",
        )
    text = "".join(chunks)
    if not text.strip():
        # Agent produced no visible text (e.g., only tool calls, then no final
        # message). Surface a clear error rather than returning an empty 200.
        logger.warning(
            f"assist: agent {agent_id} produced no text (chunks={len(chunks)})"
        )
        raise HTTPException(
            status_code=502,
            detail="Agent returned no text. Check the agent's prompt and tools.",
        )
    return text


async def _run_with_specialists(
    primary_agent_id: str,
    specialist_agent_ids: list[str],
    user_message: str,
    user_token: Optional[str],
    request: Request,
) -> str:
    """Run the primary agent as an orchestrator that may consult specialists.

    Uses the same two-phase analysis/execute/synthesis pipeline the chat UI
    uses. Aggregates the final synthesized response into a single string so
    the existing assist response shape (`text` + extracted html/json blocks)
    keeps working unchanged.
    """
    # Use the authenticated user's oid (or sub) as the user_id and a stable
    # per-extension session id so context providers (history, RAG) behave
    # sanely without conflicting with chat-UI sessions.
    user = get_current_user(request) or {}
    user_id = user.get("oid") or user.get("sub") or "extension-user"
    session_id = f"extension:{user_id}:{primary_agent_id}"

    agent_ids = [primary_agent_id, *[s for s in specialist_agent_ids if s and s != primary_agent_id]]

    chunks: list[str] = []
    try:
        async for event in agent_manager.execute_orchestration(
            pattern=OrchestrationPattern.MAGENTIC,
            agent_ids=agent_ids,
            user_message=user_message,
            session_id=session_id,
            user_id=user_id,
            user_token=user_token,
        ):
            # The pipeline yields a mix of ChatterEvent (progress/delegation/
            # html_preview/etc.) and one-or-more AgentResponse objects with
            # the final synthesized content. We only need the AgentResponse
            # text — chatter events are visible-only sugar that the chat UI
            # streams over SSE; the assist endpoints aggregate to a single
            # JSON response so we drop them here.
            if isinstance(event, AgentResponse):
                if event.content:
                    chunks.append(event.content)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except HTTPException:
        raise
    except BaseException as e:  # noqa: BLE001
        inner = e
        try:
            from builtins import BaseExceptionGroup  # py3.11+
            if isinstance(e, BaseExceptionGroup) and e.exceptions:
                inner = e.exceptions[0]
        except Exception:
            pass
        logger.error(
            f"assist: orchestration {primary_agent_id} (+{len(specialist_agent_ids)} specialists) failed: "
            f"{type(inner).__name__}: {inner}",
            exc_info=True,
        )
        raise HTTPException(
            status_code=500,
            detail=f"Agent orchestration failed: {type(inner).__name__}: {inner}",
        )

    text = "\n\n".join(c for c in chunks if c).strip()
    if not text:
        logger.warning(
            f"assist: orchestration {primary_agent_id} produced no text "
            f"(specialists={specialist_agent_ids})"
        )
        raise HTTPException(
            status_code=502,
            detail="Agent orchestration returned no text. Check the orchestrator prompt and the selected specialists.",
        )
    return text


async def _dispatch(
    primary_agent_id: str,
    specialist_agent_ids: list[str],
    user_message: str,
    user_token: Optional[str],
    request: Request,
) -> str:
    """Pick the right execution path: single-agent if no specialists, else
    orchestration. Keeps the per-endpoint code paths identical."""
    if specialist_agent_ids:
        return await _run_with_specialists(
            primary_agent_id, specialist_agent_ids, user_message, user_token, request,
        )
    return await _run_agent(primary_agent_id, user_message, user_token)


def _format_fields(fields: list[PageField]) -> str:
    if not fields:
        return "(no fields provided)"
    lines: list[str] = []
    for f in fields:
        bits = [f"- {f.label}"]
        if f.type:
            bits.append(f"(type={f.type})")
        if f.required:
            bits.append("[required]")
        if f.value not in (None, ""):
            bits.append(f"value={f.value!r}")
        if f.options:
            bits.append(f"options={f.options}")
        if f.help_text:
            bits.append(f"help={f.help_text!r}")
        if f.validation_message:
            bits.append(f"validation={f.validation_message!r}")
        lines.append(" ".join(bits))
    return "\n".join(lines)


def _format_page(page: Optional[PageContext]) -> str:
    if not page:
        return "(no page context)"
    parts = []
    if page.page_title:
        parts.append(f"Title: {page.page_title}")
    if page.section:
        parts.append(f"Section: {page.section}")
    if page.url:
        parts.append(f"URL: {page.url}")
    if page.summary:
        parts.append(f"Summary: {page.summary}")
    return "\n".join(parts) if parts else "(no page context)"


def _format_wizard(wiz: Optional[WizardContext], current_step: Optional[str] = None) -> str:
    """Render accumulated wizard state for the agent, excluding the current step."""
    if not wiz or not wiz.fields:
        return "(no prior wizard data)"
    # Filter out fields tagged with the current step so the agent doesn't get
    # them twice (they're already in FIELDS / FIELD / COLLECTED FIELDS).
    def _step_of(f: PageField) -> Optional[str]:
        extras = getattr(f, "model_extra", None) or {}
        return extras.get("_step")
    prior = [f for f in wiz.fields if not (current_step and _step_of(f) == current_step)]
    if not prior:
        prior = wiz.fields  # caller didn't tag _step; fall back to all
    lines: list[str] = []
    if wiz.steps:
        lines.append(f"Steps visited: {', '.join(wiz.steps)}")
    lines.append(f"Fields entered so far ({len(prior)}):")
    for f in prior:
        v = f.value
        if v is None or v == "":
            v_str = "(empty)"
        elif isinstance(v, bool):
            v_str = "yes" if v else "no"
        else:
            v_str = repr(v)
        bits = [f"  - {f.label}: {v_str}"]
        if f.required and (v is None or v == ""):
            bits.append("[required, empty]")
        lines.append(" ".join(bits))
    return "\n".join(lines)


def _require_user(request: Request) -> None:
    user = get_current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")


# =============================================================================
# Endpoints
# =============================================================================

@router.post("/explain-page", response_model=AssistResponse)
async def explain_page(request: Request, body: AssistExplainRequest) -> AssistResponse:
    """Explain the current wizard page in plain language, grounded in policy docs."""
    _require_user(request)
    token = get_user_token(request)

    user_message = (
        "You are helping a user complete a security package wizard in another web app.\n"
        "Explain the CURRENT PAGE in plain language: what it is asking for, why it matters, "
        "and any policy considerations the user should be aware of. Cite the policy sources "
        "you used. Keep the answer concise (a short paragraph plus a brief bullet list of the "
        "fields with one-line guidance each). Do NOT generate an HTML preview for this request.\n\n"
        f"PAGE CONTEXT:\n{_format_page(body.page)}\n\n"
        f"FIELDS ON THIS PAGE:\n{_format_fields(body.fields)}\n\n"
        f"WIZARD CONTEXT (values entered on earlier steps):\n{_format_wizard(body.wizard, body.page.section if body.page else None)}\n"
    )

    raw = await _dispatch(body.agent_id, body.specialist_agent_ids, user_message, token, request)
    cleaned, html, json_data = _extract_blocks(raw)
    return AssistResponse(
        text=cleaned or raw,
        html=html,
        json_data=json_data,
        agent_id=body.agent_id,
        agent_name=await _resolve_agent_name(body.agent_id),
    )


@router.post("/suggest-field", response_model=AssistResponse)
async def suggest_field(request: Request, body: AssistSuggestFieldRequest) -> AssistResponse:
    """Suggest a value for a single field with rationale and citations."""
    _require_user(request)
    token = get_user_token(request)

    app_meta = json.dumps(body.app_metadata or {}, indent=2)
    user_message = (
        "You are helping a user fill ONE field in a security package wizard.\n"
        "Use the WIZARD CONTEXT below (values the user already entered on earlier steps) "
        "to make a suggestion that is consistent with those answers. For example, if the "
        "user already said the data classification is 'Restricted', do not suggest a public "
        "identity provider.\n"
        "Return a recommended value for the field, a short rationale, and any policy citations.\n"
        "Respond as a JSON fenced block named `json` with this shape:\n"
        "```json\n"
        '{ "suggestion": "...", "rationale": "...", "citations": ["..."], "confidence": "low|medium|high" }\n'
        "```\n"
        "Then a one-sentence human-readable summary after the JSON block. Do NOT generate an HTML preview.\n\n"
        f"PAGE CONTEXT:\n{_format_page(body.page)}\n\n"
        f"FIELD:\n{_format_fields([body.field])}\n\n"
        f"WIZARD CONTEXT (values entered on earlier steps):\n{_format_wizard(body.wizard, body.page.section if body.page else None)}\n\n"
        f"APP METADATA:\n{app_meta}\n"
    )

    raw = await _dispatch(body.agent_id, body.specialist_agent_ids, user_message, token, request)
    cleaned, html, json_data = _extract_blocks(raw)
    return AssistResponse(
        text=cleaned or raw,
        html=html,
        json_data=json_data,
        agent_id=body.agent_id,
        agent_name=await _resolve_agent_name(body.agent_id),
    )


@router.post("/build-package", response_model=AssistResponse)
async def build_package(request: Request, body: AssistBuildPackageRequest) -> AssistResponse:
    """Build the final security package: returns both structured JSON and rendered HTML."""
    _require_user(request)
    token = get_user_token(request)

    app_meta = json.dumps(body.app_metadata or {}, indent=2)
    user_message = (
        "You are finalizing a Security Package from values the user collected while filling a "
        "wizard in another app. Produce TWO outputs in your reply, in this order:\n\n"
        "1) A JSON fenced block named `json` containing the structured security package "
        "(use whatever schema you would normally produce via the get_security_page_fields tool, "
        "filled with the user's collected values).\n"
        "2) A complete HTML page in a fenced block named `html_preview` rendering the same "
        "package for review.\n\n"
        "Do not deploy. This is preview-only.\n\n"
        f"APP METADATA:\n{app_meta}\n\n"
        f"COLLECTED FIELDS:\n{_format_fields(body.collected_fields)}\n\n"
        f"PAGE CONTEXT (optional):\n{_format_page(body.page)}\n"
    )

    raw = await _dispatch(body.agent_id, body.specialist_agent_ids, user_message, token, request)
    cleaned, html, json_data = _extract_blocks(raw)
    return AssistResponse(
        text=cleaned or raw,
        html=html,
        json_data=json_data,
        agent_id=body.agent_id,
        agent_name=await _resolve_agent_name(body.agent_id),
    )


@router.post("/ask", response_model=AssistResponse)
async def ask(request: Request, body: AssistAskRequest) -> AssistResponse:
    """Free-form chat. Optionally includes the current page context for grounding."""
    _require_user(request)
    token = get_user_token(request)

    parts = [body.question.strip()]
    if body.page or body.fields or body.wizard:
        parts.append("")
        parts.append("--- For context, the user is currently viewing this page ---")
        parts.append(f"PAGE CONTEXT:\n{_format_page(body.page)}")
        if body.fields:
            parts.append(f"FIELDS ON THIS PAGE:\n{_format_fields(body.fields)}")
        if body.wizard and body.wizard.fields:
            parts.append(
                f"WIZARD CONTEXT (values entered on earlier steps):\n"
                f"{_format_wizard(body.wizard, body.page.section if body.page else None)}"
            )
        parts.append("--- End context. Answer the user's question. ---")

    user_message = "\n".join(parts)

    raw = await _dispatch(body.agent_id, body.specialist_agent_ids, user_message, token, request)
    cleaned, html, json_data = _extract_blocks(raw)
    return AssistResponse(
        text=cleaned or raw,
        html=html,
        json_data=json_data,
        agent_id=body.agent_id,
        agent_name=await _resolve_agent_name(body.agent_id),
    )


@router.post("/deploy", response_model=AssistResponse)
async def deploy(request: Request, body: AssistDeployRequest) -> AssistResponse:
    """Deploy the approved HTML preview via the agent's deploy_security_page tool."""
    _require_user(request)
    token = get_user_token(request)

    metadata = {
        "project_name": body.project_name,
        "display_name": body.display_name or body.project_name,
        "description": body.description or "",
        "owner": body.owner or "",
    }

    user_message = (
        "DEPLOY THE APPROVED SECURITY PACKAGE\n\n"
        "The user has reviewed and approved the preview below. Call the\n"
        "`deploy_security_page` MCP tool now per Mode 5 in your prompt and\n"
        "report the result as a `json` fenced block.\n\n"
        f"PROJECT METADATA:\n{json.dumps(metadata, indent=2)}\n\n"
        "APPROVED HTML:\n"
        "```html\n"
        f"{body.html_content}\n"
        "```\n"
    )

    raw = await _dispatch(body.agent_id, body.specialist_agent_ids, user_message, token, request)
    cleaned, html, json_data = _extract_blocks(raw)
    return AssistResponse(
        text=cleaned or raw,
        html=html,
        json_data=json_data,
        agent_id=body.agent_id,
        agent_name=await _resolve_agent_name(body.agent_id),
    )
