"""
Cosmos DB Service
Handles sessions, messages, and agent configurations with continuation token pagination.
Uses connection string for local dev, DefaultAzureCredential for production.
"""
from typing import Any, Optional
from datetime import datetime, timezone
import uuid
import time

from azure.cosmos import CosmosClient, PartitionKey
from azure.cosmos.exceptions import CosmosResourceNotFoundError

from config import get_settings, get_azure_credential
from observability import get_logger, PerformanceTracker, should_log_performance, log_performance_summary, MetricType

settings = get_settings()
logger = get_logger(__name__)


class CosmosDBService:
    """Service for CosmosDB operations with pagination support."""
    
    def __init__(self):
        self.client: Optional[CosmosClient] = None
        self.database = None
        self.agents_container = None
        self.sessions_container = None
        self.messages_container = None
    
    async def initialize(self) -> None:
        """Initialize Cosmos DB client - uses managed identity (DefaultAzureCredential) by default."""
        try:
            # Prefer managed identity / Azure CLI credentials (works with AAD-only Cosmos DB)
            if settings.cosmos_endpoint:
                # Use centralized credential helper (AzureCliCredential for dev, ManagedIdentityCredential for prod)
                credential = get_azure_credential()
                env_mode = "dev" if settings.environment == "development" else "prod"
                logger.info(f"Using Cosmos DB with {type(credential).__name__} ({env_mode} mode)")
                self.client = CosmosClient(settings.cosmos_endpoint, credential)
            elif settings.cosmos_connection_string:
                # Fallback to connection string if endpoint not set (requires local auth enabled)
                logger.info("Using Cosmos DB connection string")
                self.client = CosmosClient.from_connection_string(settings.cosmos_connection_string)
            else:
                raise ValueError("Either AZURE_COSMOS_DB_ENDPOINT or AZURE_COSMOS_DB_CONNECTION_STRING must be set")
            
            # Create database if it doesn't exist
            self.database = self.client.create_database_if_not_exists(id=settings.cosmos_database)
            
            # Create containers if they don't exist
            self.agents_container = self.database.create_container_if_not_exists(
                id=settings.cosmos_agents_container,
                partition_key=PartitionKey(path="/id")
            )
            self.sessions_container = self.database.create_container_if_not_exists(
                id=settings.cosmos_sessions_container,
                partition_key=PartitionKey(path="/userId")
            )
            self.messages_container = self.database.create_container_if_not_exists(
                id=settings.cosmos_messages_container,
                partition_key=PartitionKey(path="/sessionId")
            )
            
            logger.info("Cosmos DB initialized successfully")
        except Exception as e:
            logger.error(f"Cosmos DB initialization failed: {e}")
            raise
    
    # =========================================================================
    # Agent Configuration (Admin)
    # =========================================================================
    
    async def list_agents(self) -> list[dict]:
        """Get all configured agents with performance tracking."""
        query = "SELECT * FROM c WHERE c.type = 'agent' ORDER BY c.name"
        
        start_time = time.perf_counter()
        items = list(self.agents_container.query_items(query, enable_cross_partition_query=True))
        duration_ms = (time.perf_counter() - start_time) * 1000
        
        if should_log_performance():
            log_performance_summary(logger, "cosmos_list_agents", {
                "duration_ms": round(duration_ms, 2),
                "item_count": len(items),
                "container": settings.cosmos_agents_container,
                "operation": "query"
            })
        
        return items
    
    async def get_agent(self, agent_id: str) -> Optional[dict]:
        """Get a single agent configuration with performance tracking."""
        try:
            start_time = time.perf_counter()
            result = self.agents_container.read_item(item=agent_id, partition_key=agent_id)
            duration_ms = (time.perf_counter() - start_time) * 1000
            
            if should_log_performance():
                log_performance_summary(logger, "cosmos_get_agent", {
                    "duration_ms": round(duration_ms, 2),
                    "agent_id": agent_id,
                    "container": settings.cosmos_agents_container,
                    "operation": "read"
                })
            
            return result
        except CosmosResourceNotFoundError:
            return None
    
    async def save_agent(self, agent_config: dict) -> dict:
        """Create or update an agent configuration with performance tracking."""
        if "id" not in agent_config:
            agent_config["id"] = str(uuid.uuid4())
        
        agent_config["type"] = "agent"
        agent_config["updatedAt"] = datetime.now(timezone.utc).isoformat()
        
        if "createdAt" not in agent_config:
            agent_config["createdAt"] = agent_config["updatedAt"]
        
        start_time = time.perf_counter()
        result = self.agents_container.upsert_item(agent_config)
        duration_ms = (time.perf_counter() - start_time) * 1000
        
        if should_log_performance():
            log_performance_summary(logger, "cosmos_save_agent", {
                "duration_ms": round(duration_ms, 2),
                "agent_id": agent_config["id"],
                "container": settings.cosmos_agents_container,
                "operation": "upsert"
            })
        
        return result
    
    async def delete_agent(self, agent_id: str) -> bool:
        """Delete an agent configuration with performance tracking."""
        try:
            start_time = time.perf_counter()
            self.agents_container.delete_item(item=agent_id, partition_key=agent_id)
            duration_ms = (time.perf_counter() - start_time) * 1000
            
            if should_log_performance():
                log_performance_summary(logger, "cosmos_delete_agent", {
                    "duration_ms": round(duration_ms, 2),
                    "agent_id": agent_id,
                    "container": settings.cosmos_agents_container,
                    "operation": "delete"
                })
            
            return True
        except CosmosResourceNotFoundError:
            return False
    
    # =========================================================================
    # MCP Servers
    # =========================================================================
    
    async def list_mcp_servers(self) -> list[dict]:
        """Get all registered MCP servers."""
        query = "SELECT * FROM c WHERE c.type = 'mcp_server' ORDER BY c.name"
        items = list(self.agents_container.query_items(query, enable_cross_partition_query=True))
        return items
    
    async def get_mcp_server(self, server_id: str) -> Optional[dict]:
        """Get a single MCP server configuration."""
        try:
            item = self.agents_container.read_item(item=server_id, partition_key=server_id)
            if item.get("type") == "mcp_server":
                return item
            return None
        except CosmosResourceNotFoundError:
            return None
    
    async def save_mcp_server(self, server_config: dict) -> dict:
        """Create or update an MCP server configuration."""
        if "id" not in server_config:
            server_config["id"] = str(uuid.uuid4())
        
        server_config["type"] = "mcp_server"
        server_config["updatedAt"] = datetime.now(timezone.utc).isoformat()
        
        if "createdAt" not in server_config:
            server_config["createdAt"] = server_config["updatedAt"]
        
        return self.agents_container.upsert_item(server_config)
    
    async def delete_mcp_server(self, server_id: str) -> bool:
        """Delete an MCP server registration."""
        try:
            self.agents_container.delete_item(item=server_id, partition_key=server_id)
            return True
        except CosmosResourceNotFoundError:
            return False
    
    # =========================================================================
    # Sessions
    # =========================================================================
    
    async def get_user_sessions(
        self,
        user_id: str,
        page_size: int = 20,
        continuation_token: Optional[str] = None
    ) -> tuple[list[dict], Optional[str], bool]:
        """
        Get sessions for a user with pagination and performance tracking.
        Returns: (sessions, next_continuation_token, has_more)
        """
        query = """
            SELECT c.id, c.title, c.createdAt, c.lastMessageAt, c.messageCount,
                   c.orchestrationType, c.selectedAgents
            FROM c 
            WHERE c.userId = @user_id 
            ORDER BY c.lastMessageAt DESC
        """
        
        params = [{"name": "@user_id", "value": user_id}]
        
        start_time = time.perf_counter()
        response = self.sessions_container.query_items(
            query=query,
            parameters=params,
            partition_key=user_id,
            max_item_count=page_size,
            continuation=continuation_token if continuation_token else None
        )
        
        items = list(response)
        next_token = response.continuation_token if hasattr(response, 'continuation_token') else None
        has_more = next_token is not None
        
        duration_ms = (time.perf_counter() - start_time) * 1000
        
        # Transform camelCase to snake_case for Pydantic
        transformed_items = []
        for item in items:
            transformed_items.append({
                "id": item.get("id"),
                "user_id": item.get("userId"),
                "title": item.get("title"),
                "orchestration_type": item.get("orchestrationType", "sequential"),
                "selected_agents": item.get("selectedAgents", []),
                "created_at": item.get("createdAt"),
                "last_message_at": item.get("lastMessageAt"),
                "message_count": item.get("messageCount", 0)
            })
        
        if should_log_performance():
            log_performance_summary(logger, "cosmos_get_user_sessions", {
                "duration_ms": round(duration_ms, 2),
                "item_count": len(transformed_items),
                "page_size": page_size,
                "has_more": has_more,
                "container": settings.cosmos_sessions_container,
                "operation": "query"
            })
        
        return transformed_items, next_token, has_more
    
    async def create_session(
        self,
        user_id: str,
        title: str,
        orchestration_type: str = "sequential",
        selected_agents: list[str] = None
    ) -> dict:
        """Create a new chat session with performance tracking."""
        session_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc).isoformat()
        
        session = {
            "id": session_id,
            "userId": user_id,
            "title": title,
            "orchestrationType": orchestration_type,
            "selectedAgents": selected_agents or [],
            "createdAt": now,
            "lastMessageAt": now,
            "messageCount": 0
        }
        
        start_time = time.perf_counter()
        self.sessions_container.create_item(session)
        duration_ms = (time.perf_counter() - start_time) * 1000
        
        if should_log_performance():
            log_performance_summary(logger, "cosmos_create_session", {
                "duration_ms": round(duration_ms, 2),
                "session_id": session_id,
                "container": settings.cosmos_sessions_container,
                "operation": "create"
            })
        
        logger.info(f"Created session {session_id} for user {user_id}")
        return session
    
    async def get_session(self, session_id: str, user_id: str) -> Optional[dict]:
        """Get a session by ID with performance tracking."""
        try:
            start_time = time.perf_counter()
            result = self.sessions_container.read_item(item=session_id, partition_key=user_id)
            duration_ms = (time.perf_counter() - start_time) * 1000
            
            if should_log_performance():
                log_performance_summary(logger, "cosmos_get_session", {
                    "duration_ms": round(duration_ms, 2),
                    "session_id": session_id,
                    "container": settings.cosmos_sessions_container,
                    "operation": "read"
                })
            
            # Transform camelCase to snake_case for Pydantic
            return {
                "id": result.get("id"),
                "user_id": result.get("userId"),
                "title": result.get("title"),
                "orchestration_type": result.get("orchestrationType", "sequential"),
                "selected_agents": result.get("selectedAgents", []),
                "documents": result.get("documents", []),
                "created_at": result.get("createdAt"),
                "last_message_at": result.get("lastMessageAt"),
                "message_count": result.get("messageCount", 0)
            }
        except CosmosResourceNotFoundError:
            return None
    
    async def get_session_raw(self, session_id: str, user_id: str) -> dict | None:
        """Get raw session data from CosmosDB without transformation."""
        try:
            result = self.sessions_container.read_item(item=session_id, partition_key=user_id)
            return result
        except CosmosResourceNotFoundError:
            return None
    
    async def update_session(self, session_id: str, user_id: str, updates: dict) -> dict:
        """Update a session with performance tracking."""
        # Get raw session to preserve CosmosDB format
        session = await self.get_session_raw(session_id, user_id)
        if not session:
            raise ValueError(f"Session {session_id} not found")
        
        session.update(updates)
        session["lastMessageAt"] = datetime.now(timezone.utc).isoformat()
        
        start_time = time.perf_counter()
        result = self.sessions_container.replace_item(item=session_id, body=session)
        duration_ms = (time.perf_counter() - start_time) * 1000
        
        if should_log_performance():
            log_performance_summary(logger, "cosmos_update_session", {
                "duration_ms": round(duration_ms, 2),
                "session_id": session_id,
                "container": settings.cosmos_sessions_container,
                "operation": "replace"
            })
        
        return result
    
    async def delete_session(self, session_id: str, user_id: str) -> bool:
        """Delete a session and its messages with performance tracking."""
        try:
            start_time = time.perf_counter()
            # Delete messages first
            await self.delete_session_messages(session_id, user_id)
            # Delete session
            self.sessions_container.delete_item(item=session_id, partition_key=user_id)
            duration_ms = (time.perf_counter() - start_time) * 1000
            
            if should_log_performance():
                log_performance_summary(logger, "cosmos_delete_session", {
                    "duration_ms": round(duration_ms, 2),
                    "session_id": session_id,
                    "container": settings.cosmos_sessions_container,
                    "operation": "delete"
                })
            
            return True
        except CosmosResourceNotFoundError:
            return False
    
    # =========================================================================
    # Messages
    # =========================================================================
    
    async def get_session_messages(
        self,
        session_id: str,
        user_id: str,
        page_size: int = 50,
        continuation_token: Optional[str] = None,
        oldest_first: bool = False
    ) -> tuple[list[dict], Optional[str], bool]:
        """
        Get messages for a session with pagination.
        Returns: (messages, next_continuation_token, has_more)
        """
        order = "ASC" if oldest_first else "DESC"
        query = f"""
            SELECT * FROM c 
            WHERE c.sessionId = @session_id AND c.userId = @user_id
            ORDER BY c.timestamp {order}
        """
        
        params = [
            {"name": "@session_id", "value": session_id},
            {"name": "@user_id", "value": user_id}
        ]
        
        with PerformanceTracker("cosmos_get_messages", logger) as tracker:
            response = self.messages_container.query_items(
                query=query,
                parameters=params,
                partition_key=session_id,  # Partition key is sessionId, not userId
                max_item_count=page_size,
                continuation=continuation_token if continuation_token else None
            )
            
            items = list(response)
            next_token = response.continuation_token if hasattr(response, 'continuation_token') else None
            has_more = next_token is not None
            
            tracker.add_metric("count", len(items))
        
        return items, next_token, has_more
    
    async def save_message(
        self,
        session_id: str,
        user_id: str,
        role: str,
        content: str,
        metadata: Optional[dict] = None
    ) -> dict:
        """Save a chat message."""
        message_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc).isoformat()
        
        message = {
            "id": message_id,
            "sessionId": session_id,
            "userId": user_id,
            "role": role,
            "content": content,
            "timestamp": now,
            "metadata": metadata or {}
        }
        
        self.messages_container.create_item(message)
        
        # Update session message count and timestamp
        try:
            session = await self.get_session(session_id, user_id)
            if session:
                await self.update_session(session_id, user_id, {
                    "messageCount": session.get("messageCount", 0) + 1
                })
        except Exception as e:
            logger.warning(f"Failed to update session stats: {e}")
        
        return message
    
    async def delete_session_messages(self, session_id: str, user_id: str) -> None:
        """Delete all messages for a session."""
        query = "SELECT c.id FROM c WHERE c.sessionId = @session_id"
        params = [{"name": "@session_id", "value": session_id}]
        
        items = list(self.messages_container.query_items(
            query=query,
            parameters=params,
            partition_key=session_id  # Partition key is sessionId
        ))
        
        for item in items:
            self.messages_container.delete_item(item=item["id"], partition_key=session_id)


# Global service instance
cosmos_service = CosmosDBService()
