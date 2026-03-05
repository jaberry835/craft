"""
A2A Client Service
Handles discovery, creation, and communication with A2A agents.
Uses the agent-framework-a2a SDK for all A2A protocol operations.

Key SDK features used:
- A2AAgent: Wraps any remote A2A endpoint, handles protocol details
- A2ACardResolver: Discovers agent capabilities via agent cards
- ClientCallInterceptor: Handles authentication for secured endpoints
- Streaming: Real-time updates via Server-Sent Events

Authentication:
- Same app registration: passes the user's token through directly
- Different app registration: uses OBO (On-Behalf-Of) to exchange the token
"""
from typing import Optional, Any, AsyncIterator
import httpx

from observability import get_logger, should_log_a2a
from config import get_settings

settings = get_settings()
logger = get_logger(__name__)

# A2A imports - require agent-framework-a2a package
try:
    from agent_framework.a2a import A2AAgent
    from a2a.client import A2ACardResolver
    from a2a.client.middleware import ClientCallInterceptor
    from a2a.types import AgentCard
    A2A_AVAILABLE = True
except ImportError:
    A2A_AVAILABLE = False
    ClientCallInterceptor = object  # Fallback base class when A2A not installed
    logger.warning("A2A packages not installed. External A2A agent support disabled.")


class BearerAuthInterceptor(ClientCallInterceptor):
    """Auth interceptor that adds a Bearer token to A2A requests.
    
    Implements the SDK's ClientCallInterceptor interface to inject
    authentication into outgoing A2A HTTP requests.
    
    Supports two modes:
    - Same app registration: passes the user's token through directly
    - Different app registration: uses OBO to exchange for a token
      with the target app's audience before sending
    """
    
    def __init__(self, token: str, target_client_id: Optional[str] = None):
        self.token = token
        self.target_client_id = target_client_id
        self._exchanged_token: Optional[str] = None
    
    async def intercept(
        self,
        method_name: str,
        request_payload: dict[str, Any],
        http_kwargs: dict[str, Any],
        agent_card: Any = None,
        context: Any = None,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        token_to_use = await self._get_token()
        headers = http_kwargs.get("headers", {})
        headers["Authorization"] = f"Bearer {token_to_use}"
        http_kwargs["headers"] = headers
        return request_payload, http_kwargs
    
    async def _get_token(self) -> str:
        """Return the appropriate token — OBO-exchanged if needed, else original."""
        if not self._needs_obo():
            return self.token
        
        # Lazy import to avoid circular dependency at module level
        from services.obo_token_service import obo_token_service
        
        if not obo_token_service.is_available:
            if should_log_a2a():
                logger.warning(
                    f"OBO required for target {self.target_client_id} but credentials "
                    "not configured — falling back to direct token pass-through"
                )
            return self.token
        
        try:
            self._exchanged_token = await obo_token_service.exchange_token(
                user_token=self.token,
                target_client_id=self.target_client_id,  # type: ignore[arg-type]
            )
            return self._exchanged_token
        except Exception as e:
            logger.error(f"OBO exchange failed for target {self.target_client_id}: {e}")
            # Fall back to direct token — the remote might still accept it
            return self.token
    
    def _needs_obo(self) -> bool:
        """Check whether an OBO exchange is needed."""
        if not self.target_client_id:
            return False
        # If the target is our own app registration, no exchange needed
        return self.target_client_id != settings.azure_client_id


class A2AClientService:
    """
    Service for discovering and communicating with A2A agents.
    
    Uses the agent-framework-a2a SDK for all protocol operations:
    - Discovery via A2ACardResolver
    - Communication via A2AAgent (supports both sync and streaming)
    - Authentication via BearerAuthInterceptor
    """
    
    def __init__(self):
        self._http_client: Optional[httpx.AsyncClient] = None
    
    async def _get_http_client(self) -> httpx.AsyncClient:
        """Get or create HTTP client for A2A discovery requests."""
        if self._http_client is None or self._http_client.is_closed:
            self._http_client = httpx.AsyncClient(timeout=60.0)
        return self._http_client
    
    async def discover_agent(self, base_url: str, card_path: str = "/.well-known/agent.json") -> dict:
        """
        Discover an external A2A agent by fetching its agent card.
        
        Args:
            base_url: Base URL of the A2A agent (e.g., https://example.com/a2a/weather)
            card_path: Path to the agent card (defaults to well-known location)
        
        Returns:
            dict: Agent card data including name, description, skills, capabilities
        """
        if not A2A_AVAILABLE:
            raise RuntimeError("A2A packages not installed. Run: pip install agent-framework-a2a a2a-sdk")
        
        if should_log_a2a():
            logger.info(f"Discovering A2A agent at {base_url}")
        
        try:
            http_client = await self._get_http_client()
            resolver = A2ACardResolver(httpx_client=http_client, base_url=base_url)
            agent_card: AgentCard = await resolver.get_agent_card(relative_card_path=card_path)
            
            # Convert to dict for storage
            card_data = {
                "name": agent_card.name,
                "description": agent_card.description,
                "url": str(agent_card.url) if agent_card.url else base_url,
                "version": agent_card.version,
                "protocol_version": getattr(agent_card, 'protocol_version', None),
                "skills": [],
                "capabilities": {},
                "default_input_modes": getattr(agent_card, 'default_input_modes', []),
                "default_output_modes": getattr(agent_card, 'default_output_modes', []),
            }
            
            # Extract skills
            if hasattr(agent_card, 'skills') and agent_card.skills:
                for skill in agent_card.skills:
                    card_data["skills"].append({
                        "id": skill.id,
                        "name": skill.name,
                        "description": getattr(skill, 'description', None),
                        "tags": getattr(skill, 'tags', []),
                        "examples": getattr(skill, 'examples', []),
                    })
            
            # Extract capabilities
            if hasattr(agent_card, 'capabilities') and agent_card.capabilities:
                caps = agent_card.capabilities
                card_data["capabilities"] = {
                    "streaming": getattr(caps, 'streaming', False),
                    "push_notifications": getattr(caps, 'push_notifications', False),
                    "state_transition_history": getattr(caps, 'state_transition_history', False),
                }
            
            if should_log_a2a():
                logger.info(f"Discovered A2A agent: {card_data['name']} with {len(card_data['skills'])} skills")
            return card_data
            
        except httpx.HTTPStatusError as e:
            logger.error(f"HTTP error discovering A2A agent at {base_url}: {e.response.status_code}")
            raise
        except Exception as e:
            logger.error(f"Error discovering A2A agent at {base_url}: {type(e).__name__}: {e}")
            raise
    
    def build_a2a_url(self, config: dict) -> str:
        """
        Build the A2A URL for an agent based on its type.
        
        - External A2A agents: uses the configured a2a_url
        - Local agents: builds URL from backend_url + agent ID
        """
        agent_type = config.get("agent_type", "local")
        if agent_type == "a2a":
            url = config.get("a2a_url")
            if not url:
                raise ValueError("a2a_url is required for external A2A agents")
            return url
        else:
            agent_id = config.get("id")
            if not agent_id:
                raise ValueError("Agent id is required for local A2A agents")
            return f"{settings.backend_url.rstrip('/')}/a2a/{agent_id}"
    
    def create_a2a_agent(
        self, 
        config: dict, 
        user_token: Optional[str] = None
    ) -> "A2AAgent":
        """
        Create an A2AAgent instance from configuration.
        
        Handles both external A2A agents and local agents exposed via A2A endpoints.
        Uses the SDK's auth_interceptor for secured endpoints instead of custom HTTP clients.
        
        For external agents with a different app registration (a2a_client_id set),
        the interceptor will automatically perform an OBO token exchange so the
        remote agent receives a token with the correct audience.
        
        The returned agent can be used as a context manager for proper lifecycle:
            async with a2a_client.create_a2a_agent(config, token) as agent:
                response = await agent.run("Hello")
        
        Or used directly for tool creation:
            agent = a2a_client.create_a2a_agent(config, token)
            tool = agent.as_tool(name="...", description="...")
        
        Args:
            config: Agent configuration dict (works for both local and a2a agent types)
            user_token: Optional auth token for pass-through authentication
        
        Returns:
            A2AAgent: Agent instance that communicates via A2A protocol
        """
        if not A2A_AVAILABLE:
            raise RuntimeError("A2A packages not installed. Run: pip install agent-framework-a2a a2a-sdk")
        
        url = self.build_a2a_url(config)
        name = config.get("name", "Agent").replace(" ", "_")
        description = config.get("description", "")
        
        # Determine target client_id for OBO (None = same app reg = direct pass-through)
        target_client_id = config.get("a2a_client_id") or None
        
        # Use SDK's auth_interceptor for token pass-through (with optional OBO)
        auth = BearerAuthInterceptor(user_token, target_client_id) if user_token else None
        
        if should_log_a2a():
            obo_indicator = f", obo_target={target_client_id}" if target_client_id else ""
            logger.debug(f"Creating A2AAgent '{name}' at {url} (has_token={user_token is not None}{obo_indicator})")
        
        return A2AAgent(
            name=name,
            description=description,
            url=url,
            auth_interceptor=auth,
        )
    
    async def call_agent(
        self, 
        config: dict, 
        message: str, 
        user_token: Optional[str] = None
    ) -> dict:
        """
        Call an A2A agent using the SDK and get the full response.
        
        Uses A2AAgent.run() which handles all protocol details including
        agent card resolution, message formatting, and response parsing.
        
        Args:
            config: Agent configuration dict
            message: The message to send
            user_token: Optional auth token for secured endpoints
        
        Returns:
            dict with 'text' and 'error' keys
        """
        agent_name = config.get("name", "Agent")
        try:
            async with self.create_a2a_agent(config, user_token) as agent:
                response = await agent.run(message)
                text_parts = []
                for msg in response.messages:
                    if hasattr(msg, 'text') and msg.text:
                        text_parts.append(msg.text)
                
                final_text = "\n".join(text_parts) if text_parts else ""
                if should_log_a2a():
                    logger.info(f"A2A call to '{agent_name}' returned {len(final_text)} chars")
                return {"text": final_text, "error": None}
                
        except Exception as e:
            logger.error(f"Error calling A2A agent '{agent_name}': {type(e).__name__}: {e}")
            return {"text": "", "error": str(e)}
    
    async def call_agent_stream(
        self,
        config: dict,
        message: str,
        user_token: Optional[str] = None
    ) -> AsyncIterator[str]:
        """
        Call an A2A agent with streaming via the SDK.
        
        Uses A2AAgent.run(stream=True) which provides real-time updates
        via Server-Sent Events as the remote agent works.
        
        Args:
            config: Agent configuration dict
            message: The message to send
            user_token: Optional auth token for secured endpoints
        
        Yields:
            str: Text content chunks as they arrive
        """
        agent_name = config.get("name", "Agent")
        try:
            async with self.create_a2a_agent(config, user_token) as agent:
                # ResponseStream is an AsyncIterable but does NOT support
                # `async with` — iterate directly per the Agent Framework pattern.
                stream = agent.run(message, stream=True)
                async for update in stream:
                    for content in update.contents:
                        if hasattr(content, 'text') and content.text:
                            yield content.text
        except Exception as e:
            logger.error(f"Error streaming from A2A agent '{agent_name}': {type(e).__name__}: {e}")
            raise
    
    async def test_connection(self, base_url: str) -> dict:
        """
        Test connection to an A2A agent by fetching its agent card.
        
        Args:
            base_url: Base URL of the A2A agent
        
        Returns:
            dict: Status including success, agent name, and any error
        """
        try:
            card = await self.discover_agent(base_url)
            return {
                "success": True,
                "agent_name": card.get("name"),
                "description": card.get("description"),
                "skills_count": len(card.get("skills", [])),
                "error": None
            }
        except Exception as e:
            return {
                "success": False,
                "agent_name": None,
                "description": None,
                "skills_count": 0,
                "error": str(e)
            }
    
    async def close(self):
        """Close HTTP client."""
        if self._http_client and not self._http_client.is_closed:
            await self._http_client.aclose()
            self._http_client = None


# Singleton instance
a2a_client = A2AClientService()
