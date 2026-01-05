"""A2A-first MultiAgentSystem wrapper.

Replaces legacy group-chat orchestration with an Agent-to-Agent (A2A) router
that delegates tasks to remote specialist agents which use MCP tools.

Public API:
- initialize() -> bool
- process_question(question, session_id=None, user_id=None, adx_token=None, authorization=None) -> str
- cleanup() -> None
"""

from typing import List
import os
import logging

from src.a2a.host_router import RoutingHost

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
        # Forward context so the router can pass headers to specialists
        return await self.host.process_user_message(
            message=question,
            session_id=session_id,
            user_id=user_id,
            adx_token=adx_token,
            authorization=authorization,
        )

    async def cleanup(self):
        return None
