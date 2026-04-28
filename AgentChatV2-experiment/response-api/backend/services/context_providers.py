"""
Agent Framework Context Providers

Implements CosmosHistoryProvider and DocumentRAGProvider for proper integration
with the Agent Framework's built-in memory and conversation system.

- CosmosHistoryProvider: Loads/saves conversation history from Cosmos DB
  via BaseHistoryProvider (load in before_run, save in after_run).
- DocumentRAGProvider: Injects relevant document context via BaseContextProvider
  (in before_run, before the agent processes the request).

See:
  https://learn.microsoft.com/en-us/agent-framework/agents/conversations/context-providers
  https://learn.microsoft.com/en-us/agent-framework/agents/conversations/storage
"""
from typing import Any, Sequence

from agent_framework import (
    HistoryProvider,
    ContextProvider,
    Message,
    Content,
    AgentSession,
    SessionContext,
)

from observability import get_logger, should_log_agent

logger = get_logger(__name__)


# =============================================================================
# History Provider — Cosmos DB
# =============================================================================

class CosmosHistoryProvider(HistoryProvider):
    """
    History provider backed by Cosmos DB.

    Loads conversation history from Cosmos DB via ``get_messages`` and
    optionally saves new messages via ``save_messages``.  Saving is disabled
    by default (``store_inputs=False``, ``store_outputs=False``) because
    ``chat_routes.py`` handles message persistence manually.  Set these to
    ``True`` when you want the framework to manage saves automatically.

    Provider state keys (set on ``session.state["<source_id>"]``):
        session_id    — Cosmos DB session/conversation ID
        user_id       — Cosmos DB user ID (partition key)
        current_query — the current user message (used to de-duplicate the
                        just-saved message from the history the framework will
                        also pass as input)

    Example::

        provider = CosmosHistoryProvider(cosmos_service)
        agent = chat_client.as_agent(
            name="MyAgent",
            instructions="...",
            context_providers=[provider],
        )
        session = agent.create_session()
        session.state["cosmos-history"] = {
            "session_id": "abc-123",
            "user_id": "user@example.com",
            "current_query": "What is the weather?",
        }
        result = await agent.run("What is the weather?", session=session)
    """

    DEFAULT_PAGE_SIZE = 50

    def __init__(
        self,
        cosmos_service,
        source_id: str = "cosmos-history",
        *,
        load_messages: bool = True,
        store_inputs: bool = False,
        store_outputs: bool = False,
        default_session_id: str | None = None,
        default_user_id: str | None = None,
        default_query: str | None = None,
    ) -> None:
        super().__init__(
            source_id,
            load_messages=load_messages,
            store_inputs=store_inputs,
            store_outputs=store_outputs,
        )
        self._cosmos = cosmos_service
        self._default_session_id = default_session_id
        self._default_user_id = default_user_id
        self._default_query = default_query

    # --------------------------------------------------------------------- #
    # BaseHistoryProvider abstract methods
    # --------------------------------------------------------------------- #

    async def get_messages(
        self,
        session_id: str | None,
        *,
        state: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> list[Message]:
        """Load conversation history from Cosmos DB.

        ``state`` is the **provider-scoped** dict
        (``session.state[self.source_id]``).
        """
        if state is None:
            state = {}

        # Auto-populate state from defaults when the caller (e.g. a Workflow)
        # did not pass an explicit session with pre-set state.
        if not state.get("session_id") and self._default_session_id:
            state["session_id"] = self._default_session_id
        if not state.get("user_id") and self._default_user_id:
            state["user_id"] = self._default_user_id
        if not state.get("current_query") and self._default_query:
            state["current_query"] = self._default_query

        cosmos_session_id = state.get("session_id")
        cosmos_user_id = state.get("user_id")
        current_query = state.get("current_query")

        if not cosmos_session_id or not cosmos_user_id:
            logger.warning(
                "CosmosHistoryProvider: missing session_id or user_id in state"
            )
            return []

        raw_messages, _, _ = await self._cosmos.get_session_messages(
            session_id=cosmos_session_id,
            user_id=cosmos_user_id,
            page_size=self.DEFAULT_PAGE_SIZE,
            oldest_first=True,
        )

        messages = []
        for m in raw_messages:
            role = m.get("role", "user")
            text = m.get("content", "")
            metadata = m.get("metadata", {})
            img = metadata.get("image_attachment") if metadata else None

            if img and img.get("base64") and img.get("content_type"):
                # Build a multimodal message with text + image content
                contents: list[Content | str] = []
                if text:
                    contents.append(text)
                data_uri = f"data:{img['content_type']};base64,{img['base64']}"
                contents.append(
                    Content.from_uri(data_uri, media_type=img["content_type"])
                )
                messages.append(Message(role, contents))
            else:
                contents = [text] if text else []
                messages.append(Message(role, contents))

        # The user message was already saved to Cosmos *before* agent.run()
        # (for durability).  The framework will also add it as the current
        # input, so strip the duplicate from the tail of history.
        if (
            current_query
            and messages
            and messages[-1].role == "user"
            and messages[-1].text == current_query
        ):
            messages = messages[:-1]

        if should_log_agent():
            logger.info(
                f"CosmosHistoryProvider: loaded {len(messages)} messages "
                f"for session {cosmos_session_id}"
            )

        return messages

    async def save_messages(
        self,
        session_id: str | None,
        messages: Sequence[Message],
        *,
        state: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> None:
        """Persist messages to Cosmos DB.

        Only called by the framework when ``store_inputs`` or
        ``store_outputs`` is ``True``.
        """
        if not messages or state is None:
            return

        cosmos_session_id = state.get("session_id")
        cosmos_user_id = state.get("user_id")

        if not cosmos_session_id or not cosmos_user_id:
            logger.warning(
                "CosmosHistoryProvider: cannot save — missing session_id or user_id"
            )
            return

        for msg in messages:
            role = msg.role if hasattr(msg, "role") else "user"
            text = msg.text if hasattr(msg, "text") else str(msg)
            await self._cosmos.save_message(
                session_id=cosmos_session_id,
                user_id=cosmos_user_id,
                role=str(role),
                content=text,
            )

        if should_log_agent():
            logger.info(
                f"CosmosHistoryProvider: saved {len(list(messages))} messages "
                f"for session {cosmos_session_id}"
            )


# =============================================================================
# Context Provider — Document RAG
# =============================================================================

class DocumentRAGProvider(ContextProvider):
    """
    Context provider that injects relevant document context for RAG.

    Before each agent run, it generates an embedding for the user query,
    searches for matching document chunks, and injects them as additional
    instructions via ``context.extend_instructions``.

    Provider state keys (set on ``session.state["<source_id>"]``):
        session_id — Cosmos DB session ID (scopes the document search)
        user_id    — Cosmos DB user ID
        user_query — the current user message to embed & search against

    Example::

        provider = DocumentRAGProvider(embedding_service, search_service)
        agent = chat_client.as_agent(
            name="RagAgent",
            instructions="...",
            context_providers=[provider],
        )
        session = agent.create_session()
        session.state["document-rag"] = {
            "session_id": "abc-123",
            "user_id": "user@example.com",
            "user_query": "What does the dress code policy say?",
        }
        result = await agent.run("What does the dress code policy say?", session=session)
    """

    def __init__(
        self,
        embedding_service,
        search_service,
        source_id: str = "document-rag",
        *,
        top_k: int = 3,
        default_session_id: str | None = None,
        default_user_id: str | None = None,
        default_query: str | None = None,
    ) -> None:
        super().__init__(source_id)
        self._embedding = embedding_service
        self._search = search_service
        self._top_k = top_k
        self._default_session_id = default_session_id
        self._default_user_id = default_user_id
        self._default_query = default_query

    async def before_run(
        self,
        *,
        agent: Any,
        session: AgentSession,
        context: SessionContext,
        state: dict[str, Any],
    ) -> None:
        """Retrieve and inject relevant document context before the agent runs."""
        # Auto-populate state from defaults when used inside a Workflow
        # that doesn't pass an explicit session with pre-set state.
        if not state.get("session_id") and self._default_session_id:
            state["session_id"] = self._default_session_id
        if not state.get("user_id") and self._default_user_id:
            state["user_id"] = self._default_user_id
        if not state.get("user_query") and self._default_query:
            state["user_query"] = self._default_query

        cosmos_session_id = state.get("session_id")
        cosmos_user_id = state.get("user_id")
        user_query = state.get("user_query", "")

        if not user_query or not cosmos_session_id or not cosmos_user_id:
            return

        try:
            # Generate embedding for the query
            query_embedding = await self._embedding.generate_embedding(user_query)
            if not query_embedding:
                return

            # Search for relevant documents scoped to this session/user
            documents = await self._search.search_documents(
                query_embedding=query_embedding,
                session_id=cosmos_session_id,
                user_id=cosmos_user_id,
                top_k=self._top_k,
            )

            if not documents:
                return

            # Format and inject context via the framework's instruction extension
            context_parts = [
                "Here are relevant excerpts from uploaded documents:\n"
            ]
            for doc in documents:
                context_parts.append(f"--- From: {doc['title']} ---")
                context_parts.append(doc["content"])
                context_parts.append("")

            rag_text = "\n".join(context_parts)
            context.extend_instructions(
                self.source_id,
                "Use the following document context to help answer the "
                f"user's question:\n\n{rag_text}",
            )

            if should_log_agent():
                logger.info(
                    f"DocumentRAGProvider: injected {len(documents)} document chunks"
                )

        except Exception as e:
            logger.warning(f"DocumentRAGProvider: failed to retrieve context: {e}")
