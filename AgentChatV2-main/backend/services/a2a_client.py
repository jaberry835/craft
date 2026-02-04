"""
A2A Client Service
Handles discovery and creation of external A2A agents.
Implements the A2A protocol for consuming remote agents.
"""
from typing import Optional, Any
import httpx

from observability import get_logger, should_log_a2a
from config import get_settings

settings = get_settings()
logger = get_logger(__name__)

# A2A imports - these require agent-framework-a2a package
try:
    from agent_framework.a2a import A2AAgent
    from a2a.client import A2ACardResolver
    from a2a.types import AgentCard
    A2A_AVAILABLE = True
except ImportError:
    A2A_AVAILABLE = False
    logger.warning("A2A packages not installed. External A2A agent support disabled.")


class A2AClientService:
    """
    Service for discovering and creating external A2A agents.
    
    A2A Protocol Overview:
    - Agent Cards: JSON metadata at /.well-known/agent.json describing agent capabilities
    - Messages: HTTP POST to /v1/message:stream for sending messages
    - Tasks: For long-running operations (optional)
    """
    
    def __init__(self):
        self._http_client: Optional[httpx.AsyncClient] = None
    
    async def _get_http_client(self) -> httpx.AsyncClient:
        """Get or create HTTP client for A2A requests."""
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
        
        Raises:
            RuntimeError: If A2A packages not installed
            httpx.HTTPError: If agent card fetch fails
        """
        if not A2A_AVAILABLE:
            raise RuntimeError("A2A packages not installed. Run: pip install agent-framework-a2a a2a")
        
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
    
    def create_a2a_agent(self, config: dict) -> Any:
        """
        Create an A2AAgent instance from stored configuration.
        
        The A2AAgent follows the same AgentProtocol as ChatAgent,
        so it can be used interchangeably in orchestration patterns.
        
        Args:
            config: Agent configuration dict with a2a_url and optionally a2a_card
        
        Returns:
            A2AAgent: Agent instance that communicates via A2A protocol
        
        Raises:
            RuntimeError: If A2A packages not installed
            ValueError: If config missing required fields
        """
        if not A2A_AVAILABLE:
            raise RuntimeError("A2A packages not installed. Run: pip install agent-framework-a2a a2a")
        
        a2a_url = config.get("a2a_url")
        if not a2a_url:
            raise ValueError("a2a_url is required for A2A agents")
        
        name = config.get("name", "A2A Agent")
        description = config.get("description", "")
        
        # If we have a cached agent card, use it
        a2a_card = config.get("a2a_card")
        if a2a_card and isinstance(a2a_card, dict):
            if should_log_a2a():
                logger.debug(f"Creating A2AAgent '{name}' with cached card")
            # Note: A2AAgent can accept agent_card parameter if needed
            agent = A2AAgent(
                name=name,
                description=description or a2a_card.get("description", ""),
                url=a2a_url
            )
        else:
            if should_log_a2a():
                logger.debug(f"Creating A2AAgent '{name}' with direct URL")
            agent = A2AAgent(
                name=name,
                description=description,
                url=a2a_url
            )
        
        return agent
    
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
    
    async def call_agent_direct(
        self, 
        agent_url: str, 
        message: str, 
        user_token: Optional[str] = None
    ) -> dict:
        """
        Call an A2A agent directly via HTTP, returning full response with metadata.
        
        This bypasses the A2AAgent SDK to get access to the full JSON-RPC response,
        including metadata with chatter events (tool calls/results).
        
        Args:
            agent_url: Full URL to the A2A agent endpoint (e.g., http://localhost:5000/a2a/{agent_id})
            message: The message to send to the agent
            user_token: Optional auth token for pass-through authentication
        
        Returns:
            dict with:
                - text: The agent's text response
                - chatter_events: List of tool call/result events from the agent
                - duration_ms: Total execution time in milliseconds
                - error: Error message if failed
        """
        import uuid
        
        request_id = str(uuid.uuid4())
        
        # Build JSON-RPC request
        payload = {
            "jsonrpc": "2.0",
            "method": "message/send",
            "params": {
                "message": {
                    "kind": "message",
                    "role": "user",
                    "parts": [{"kind": "text", "text": message}]
                }
            },
            "id": request_id
        }
        
        headers = {"Content-Type": "application/json"}
        if user_token:
            headers["Authorization"] = f"Bearer {user_token}"
        
        try:
            async with httpx.AsyncClient(timeout=120.0) as client:
                response = await client.post(
                    agent_url,
                    json=payload,
                    headers=headers
                )
                response.raise_for_status()
                result = response.json()
            
            # Parse JSON-RPC response
            if "error" in result:
                return {
                    "text": "",
                    "chatter_events": [],
                    "duration_ms": None,
                    "error": result["error"].get("message", "Unknown error")
                }
            
            # Extract result
            message_result = result.get("result", {})
            parts = message_result.get("parts", [])
            metadata = message_result.get("metadata", {})
            
            # Get text from parts
            text = ""
            for part in parts:
                if part.get("kind") == "text":
                    text += part.get("text", "")
            
            # Get chatter events from metadata
            chatter_events = metadata.get("chatter_events", [])
            duration_ms = metadata.get("duration_ms")
            
            return {
                "text": text,
                "chatter_events": chatter_events,
                "duration_ms": duration_ms,
                "error": None
            }
            
        except httpx.HTTPStatusError as e:
            logger.error(f"HTTP error calling A2A agent at {agent_url}: {e.response.status_code}")
            return {
                "text": "",
                "chatter_events": [],
                "duration_ms": None,
                "error": f"HTTP {e.response.status_code}: {e.response.text[:200]}"
            }
        except Exception as e:
            logger.error(f"Error calling A2A agent at {agent_url}: {type(e).__name__}: {e}")
            return {
                "text": "",
                "chatter_events": [],
                "duration_ms": None,
                "error": str(e)
            }
    
    def create_local_a2a_agent(self, config: dict, base_url: str, user_token: Optional[str] = None) -> Any:
        """
        Create an A2AAgent that points to a local agent exposed via A2A endpoints.
        
        This allows the orchestrator to call local agents using the same A2A protocol
        that would be used for external agents, enabling:
        - Consistent protocol for all agent communication
        - Local agents to be discoverable and callable by external systems
        - Same code path for local and external agent orchestration
        
        Args:
            config: Agent configuration dict with id, name, description
            base_url: Base URL of this server (e.g., http://localhost:5000)
            user_token: User's auth token for pass-through authentication
        
        Returns:
            A2AAgent: Agent instance that communicates via local A2A endpoints
        """
        if not A2A_AVAILABLE:
            raise RuntimeError("A2A packages not installed. Run: pip install agent-framework-a2a a2a-sdk")
        
        agent_id = config.get("id")
        if not agent_id:
            raise ValueError("Agent id is required")
        
        name = config.get("name", "Agent")
        description = config.get("description", "")
        
        # Build the local A2A URL for this agent
        # Format: {base_url}/a2a/{agent_id}
        a2a_url = f"{base_url.rstrip('/')}/a2a/{agent_id}"
        
        if should_log_a2a():
            logger.debug(f"Creating local A2AAgent '{name}' at {a2a_url} (has_token={user_token is not None})")
        
        # Create HTTP client with auth headers if token provided
        http_client = None
        if user_token:
            if should_log_a2a():
                logger.info(f"Creating A2AAgent with auth header for '{name}'")
            http_client = httpx.AsyncClient(
                timeout=60.0,
                headers={"Authorization": f"Bearer {user_token}"}
            )
        else:
            if should_log_a2a():
                logger.warning(f"Creating A2AAgent WITHOUT auth header for '{name}' - no user_token provided")
        
        agent = A2AAgent(
            name=name.replace(" ", "_"),  # Sanitize for API compatibility
            description=description,
            url=a2a_url,
            http_client=http_client
        )
        
        return agent


# Singleton instance
a2a_client = A2AClientService()
