"""A2A-first MultiAgentSystem wrapper.

Replaces legacy group-chat orchestration with an Agent-to-Agent (A2A) router
that delegates tasks to remote specialist agents which use MCP tools.

Public API:
- initialize() -> bool
- process_question(question, session_id=None, user_id=None, adx_token=None, authorization=None) -> str
- cleanup() -> None
"""

from typing import List, Optional
import os
import logging

from src.a2a.host_router import RoutingHost
from semantic_kernel.contents import ChatHistory

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)


class MultiAgentSystem:
    """Thin facade over the A2A RoutingHost."""

    def __init__(self, azure_openai_api_key: str, azure_openai_endpoint: str, azure_openai_deployment: str):
        self.host = RoutingHost(
            azure_api_key=azure_openai_api_key,
            azure_endpoint=azure_openai_endpoint,
            azure_deployment=azure_openai_deployment,
        )
        # Use local routes instead of separate ports - all agents now run on same app
        base_url = os.getenv("API_BASE_URL", "http://localhost:8000")
        self.specialist_urls: List[str] = [
            f"{base_url}/agents/document",
            f"{base_url}/agents/adx",
            f"{base_url}/agents/investigator",
            f"{base_url}/agents/fictionalcompanies",
        ]

    async def initialize(self) -> bool:
        await self.host.discover_agents([u for u in self.specialist_urls if u])
        await self.host.initialize()
        return True

    async def process_question(self, question: str, session_id: str = None, user_id: str = None, adx_token: str = None, authorization: str = None) -> str:
        # Load chat history from memory service if session_id is provided
        chat_history: Optional[ChatHistory] = None
        if session_id:
            try:
                from src.services.cosmos_service import cosmos_service
                # Load chat history from memory service
                await cosmos_service.memory_service.load_chat_history(session_id, user_id)
                chat_history = cosmos_service.memory_service.get_chat_history(session_id)
                if chat_history:
                    logger.info(f"Loaded chat history for session {session_id} with {len(chat_history.messages)} messages")
                else:
                    logger.info(f"No existing chat history found for session {session_id}, will create new one")
            except Exception as e:
                logger.warning(f"Could not load chat history for session {session_id}: {e}")
                chat_history = None
        
        # Forward context so the router can pass headers to specialists
        return await self.host.process_user_message(
            message=question,
            session_id=session_id,
            user_id=user_id,
            adx_token=adx_token,
            authorization=authorization,
            chat_history=chat_history,
        )

    async def cleanup(self):
        return None
