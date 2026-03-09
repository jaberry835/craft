"""Chat service – local function-calling agent (Chat Completions API).

Uses OpenAI tool/function calling on GPT-4o / GPT-5.2 via Azure OpenAI.
No Foundry agents, no Responses API – just the standard Chat Completions
endpoint with ``tools`` parameter.
"""

from __future__ import annotations

import json
from typing import Any

import structlog
from openai import AzureOpenAI

from ..config import Settings, get_openai_token_provider
from ..models import (
    ChatRequest, ChatResponse, ChatImageReference,
    ChatAction, SearchRequest,
)
from .search_service import SearchService
from .face_match_service import FaceMatchService, get_face_match_service

logger = structlog.get_logger()

# ---------------------------------------------------------------------------
# System prompt
# ---------------------------------------------------------------------------
SYSTEM_PROMPT = """\
You are **SnapSeek**, an intelligent image-search assistant.

You have access to these tools — prefer calling them over guessing:

• **find_person_images** – find images that contain a named person.
  Accepts an optional similarity `threshold` (0–100 %).
• **search_images** – general keyword / semantic image search.
• **prepare_zip_download** – bundle a set of images into ZIP file(s)
  for download (optionally split by date).

### Conversation rules
1. When the user asks for images of a person, call `find_person_images`.
2. After returning person results, **proactively offer** to create a ZIP
   download.  Say something like:
   "Would you like me to bundle these into a ZIP file for download?
    I can also split them by date if you prefer."
3. If the user mentions a threshold (e.g. "at least 80 %"), pass
   `threshold=80` to `find_person_images`.
4. When the user confirms a zip download, call `prepare_zip_download`
   with the `image_ids` array from the `find_person_images` result —
   these are hash strings like `22b2f2c7c7748cbead2c79466a78b2e1`.
   **Never use filenames as IDs.**  If they want it grouped by date,
   set `group_by_date=true`.
5. Be concise but friendly.  Always mention how many images you found.
6. If no images are found, suggest alternative searches.
"""

# ---------------------------------------------------------------------------
# Tool definitions (OpenAI Chat Completions function-calling format)
# ---------------------------------------------------------------------------
TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "find_person_images",
            "description": (
                "Search for images containing a specific person by name. "
                "Uses the face-similarity index to find matching images."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "person_name": {
                        "type": "string",
                        "description": "Name (or partial name) of the person.",
                    },
                    "threshold": {
                        "type": "number",
                        "description": (
                            "Minimum similarity as a percentage 0–100. "
                            "Default 70."
                        ),
                    },
                    "top": {
                        "type": "integer",
                        "description": "Max images to return (default 20).",
                    },
                },
                "required": ["person_name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_images",
            "description": "General keyword / semantic image search.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Search query text.",
                    },
                    "top": {
                        "type": "integer",
                        "description": "Max results (default 10).",
                    },
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "prepare_zip_download",
            "description": (
                "Bundle the images from previous search results into a ZIP "
                "file for download. Optionally group into sub-folders by date. "
                "You do NOT need to pass image_ids — all images from previous "
                "tool calls will be included automatically."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "group_by_date": {
                        "type": "boolean",
                        "description": "Group images into date sub-folders. Default false.",
                    },
                },
                "required": [],
            },
        },
    },
]


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------

class ChatService:
    """Local agent using OpenAI Chat Completions with tool calling."""

    def __init__(self, settings: Settings, search_service: SearchService):
        self.settings = settings
        self.search_service = search_service
        self.face_match_service: FaceMatchService = get_face_match_service(settings)

        # Azure OpenAI client (Chat Completions API only)
        if settings.azure_openai_key:
            self.client = AzureOpenAI(
                azure_endpoint=settings.azure_openai_endpoint,
                api_key=settings.azure_openai_key,
                api_version=settings.azure_openai_api_version,
            )
        else:
            token_provider = get_openai_token_provider(settings.azure_credential_scope)
            if not token_provider:
                raise ValueError("No valid credential for Azure OpenAI")
            self.client = AzureOpenAI(
                azure_endpoint=settings.azure_openai_endpoint,
                azure_ad_token_provider=token_provider,
                api_version=settings.azure_openai_api_version,
            )

        self.logger = logger.bind(component="chat_agent")

    # ------------------------------------------------------------------
    # Tool implementations
    # ------------------------------------------------------------------

    async def _tool_find_person_images(
        self,
        person_name: str,
        threshold: float = 70,
        top: int = 20,
    ) -> dict[str, Any]:
        """Find images by person name via faces index → vector similarity."""
        threshold_frac = max(0.0, min(1.0, threshold / 100.0))

        # 1. Search faces index by person_name
        face_hits = self.face_match_service.search_faces_by_name(
            person_name, top=200
        )
        if not face_hits:
            return {"images": [], "message": f"No person named '{person_name}' found."}

        # 2. Pick rep face doc, run vector similarity search
        rep_face_id = face_hits[0]["id"]
        similar = self.face_match_service.find_similar_by_face_doc_id(
            rep_face_id, top=top * 3, threshold=threshold_frac,
        )

        # 3. Collect unique image_ids with scores
        image_ids: list[str] = []
        seen: set[str] = set()
        scores: dict[str, float] = {}
        for m in similar:
            img_id = m.get("image_id")
            if img_id and img_id not in seen:
                seen.add(img_id)
                image_ids.append(img_id)
                scores[img_id] = round(m.get("score", 0) * 100, 1)

        # 4. Fetch image metadata from the main index
        images: list[dict[str, Any]] = []
        for img_id in image_ids[:top]:
            try:
                detail = await self.search_service.get_image(img_id)
                if detail:
                    images.append({
                        "id": detail.id,
                        "filename": detail.filename,
                        "file_url": detail.file_url,
                        "caption": detail.caption,
                        "score": scores.get(img_id, 0),
                        "indexed_at": (
                            detail.indexed_at.isoformat()
                            if detail.indexed_at else None
                        ),
                    })
            except Exception:
                pass

        return {
            "person_name": person_name,
            "threshold": threshold,
            "total_found": len(images),
            "image_ids": [img["id"] for img in images],
            "images": images,
        }

    async def _tool_search_images(
        self, query: str, top: int = 10
    ) -> dict[str, Any]:
        """General image search."""
        request = SearchRequest(
            query=query,
            top=min(top, 50),
            use_vector_search=True,
            use_semantic_search=self.settings.enable_semantic_search,
        )
        result = await self.search_service.search(request)
        images = [
            {
                "id": img.id,
                "filename": img.filename,
                "file_url": img.file_url,
                "caption": img.caption,
                "score": round((img.score or 0) * 100, 1),
            }
            for img in result.results
        ]
        return {"query": query, "total_found": len(images), "images": images}

    async def _tool_prepare_zip_download(
        self,
        image_ids: list[str] | None = None,
        group_by_date: bool = False,
    ) -> dict[str, Any]:
        """Return a payload the frontend uses to trigger the ZIP endpoint.

        ``image_ids`` is intentionally ignored — the agent loop injects the
        real collected IDs so the model can never hallucinate them.
        """
        # Actual IDs are injected by _execute_tool; this is just a stub.
        return {
            "download_action": True,
            "group_by_date": group_by_date,
        }

    # ------------------------------------------------------------------
    # Tool dispatch
    # ------------------------------------------------------------------

    async def _execute_tool(
        self, name: str, arguments: str
    ) -> tuple[str, list[dict], list[dict]]:
        """Run a tool and return (result_json, images, actions)."""
        args: dict[str, Any] = json.loads(arguments)
        images: list[dict] = []
        actions: list[dict] = []

        if name == "find_person_images":
            result = await self._tool_find_person_images(**args)
            images = result.get("images", [])
        elif name == "search_images":
            result = await self._tool_search_images(**args)
            images = result.get("images", [])
        elif name == "prepare_zip_download":
            # Ignore model-supplied image_ids — use the real collected IDs
            group_by_date = args.get("group_by_date", False)
            result = await self._tool_prepare_zip_download(
                group_by_date=group_by_date,
            )
            # Inject the real IDs
            real_ids = self._collected_image_ids
            result["image_ids"] = real_ids
            result["total_images"] = len(real_ids)
            actions.append({
                "type": "zip_download",
                "image_ids": real_ids,
                "group_by_date": result["group_by_date"],
                "label": (
                    f"Download {len(real_ids)} images"
                    + (" (by date)" if result["group_by_date"] else "")
                ),
            })
        else:
            result = {"error": f"Unknown tool: {name}"}

        return json.dumps(result, default=str), images, actions

    # ------------------------------------------------------------------
    # Agent loop (Chat Completions + tool calling)
    # ------------------------------------------------------------------

    async def chat(self, request: ChatRequest) -> ChatResponse:
        """Run the agent loop: model → tool calls → model → … → final text."""
        self.logger.info("Agent chat", message=request.message[:120])

        messages: list[dict[str, Any]] = [
            {"role": "system", "content": SYSTEM_PROMPT},
        ]
        for msg in request.history:
            messages.append({"role": msg.role, "content": msg.content})
        messages.append({"role": "user", "content": request.message})

        all_images: list[dict] = []
        all_actions: list[dict] = []
        # Seed with IDs the frontend carried over from previous turns
        collected_image_ids: list[str] = list(request.image_context or [])
        max_turns = 6  # safety cap

        # Newer models (o-series, gpt-5.x) require max_completion_tokens
        # and may reject the legacy max_tokens parameter with a 400 error.
        deployment = self.settings.azure_openai_chat_deployment
        uses_new_api = any(
            deployment.startswith(p) for p in ("o1", "o3", "o4", "gpt-5")
        )
        extra_params: dict = (
            {"max_completion_tokens": 800}
            if uses_new_api
            else {"max_tokens": 800, "temperature": 0.4}
        )

        for _turn in range(max_turns):
            completion = self.client.chat.completions.create(
                model=deployment,
                messages=messages,
                tools=TOOLS,
                tool_choice="auto",
                **extra_params,
            )

            choice = completion.choices[0]

            # --- If the model wants to call tool(s) ----------------------
            if choice.message.tool_calls:
                # Append the assistant message (contains tool_calls list)
                messages.append(choice.message.model_dump())

                for tc in choice.message.tool_calls:
                    self.logger.info(
                        "Tool call",
                        tool=tc.function.name,
                        args=tc.function.arguments[:300],
                    )
                    # Make collected IDs available to _execute_tool
                    self._collected_image_ids = collected_image_ids

                    result_json, imgs, acts = await self._execute_tool(
                        tc.function.name, tc.function.arguments,
                    )
                    all_images.extend(imgs)
                    all_actions.extend(acts)

                    # Accumulate real image IDs from tool results
                    for img in imgs:
                        if img.get("id") and img["id"] not in collected_image_ids:
                            collected_image_ids.append(img["id"])

                    messages.append({
                        "role": "tool",
                        "tool_call_id": tc.id,
                        "content": result_json,
                    })

                continue  # let the model see tool results

            # --- Final assistant text ------------------------------------
            assistant_text = choice.message.content or ""
            break
        else:
            assistant_text = "Sorry, I wasn't able to complete the request."

        # Build ChatImageReference list
        chat_images = [
            ChatImageReference(
                id=img["id"],
                filename=img.get("filename", ""),
                file_url=img.get("file_url"),
                caption=img.get("caption"),
                relevance_reason=(
                    f"{img['score']}% match" if img.get("score") else None
                ),
            )
            for img in all_images
        ]

        # Build ChatAction list
        chat_actions = [
            ChatAction(
                type=a["type"],
                label=a.get("label", "Download"),
                payload=a,
            )
            for a in all_actions
        ]

        return ChatResponse(
            message=assistant_text,
            images=chat_images,
            actions=chat_actions,
            search_query=request.message,
        )
