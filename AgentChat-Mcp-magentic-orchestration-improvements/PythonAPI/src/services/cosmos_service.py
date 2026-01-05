"""Azure Cosmos DB service for chat sessions and messages."""

from typing import List, Dict, Any, Optional, Tuple

try:
    from ..utils.logging import get_logger
except ImportError:
    from src.utils.logging import get_logger

from .cosmos_client import cosmos_client
from .session_service import session_service
from .message_service import message_service

logger = get_logger(__name__)


class CosmosDBService:
    """Main service for managing chat sessions and messages in Azure Cosmos DB.
    
    This service acts as a facade that delegates to specialized services:
    - SessionService: Handles session operations
    - MessageService: Handles message operations
    - CosmosDBClient: Handles connection and configuration
    - MemoryService: Handles chat history and context management
    """
    
    def __init__(self):
        self.client = cosmos_client
        self.sessions = session_service
        self.messages = message_service
        # Import memory service to avoid circular imports
        self._memory_service = None
    
    @property
    def memory_service(self):
        """Lazy load memory service to avoid circular imports."""
        if self._memory_service is None:
            from .memory_service import memory_service
            self._memory_service = memory_service
            # Set the cosmos service reference for persistence
            self._memory_service.cosmos_service = self
        return self._memory_service
    
    def is_available(self) -> bool:
        """Check if Cosmos DB is available."""
        return self.client.is_available()
    
    def get_config(self) -> dict:
        """Get current Cosmos DB configuration."""
        return self.client.get_config()
    
    def reconnect(self):
        """Reconnect to Cosmos DB (useful for error recovery)."""
        self.client.reconnect()
    
    # Session management methods (delegate to session_service)
    
    async def create_session(self, user_id: str, title: str) -> Dict[str, Any]:
        """Create a new chat session with memory initialization."""
        session = await self.sessions.create_session(user_id, title)
        
        # Initialize chat history for the new session
        session_id = session.get('id')
        if session_id:
            self.memory_service.create_chat_history(session_id)
            logger.info(f"Initialized memory for new session {session_id}")
        
        return session
    
    async def get_user_sessions(self, user_id: str, page_size: int = 20, continuation_token: Optional[str] = None) -> Tuple[List[Dict[str, Any]], Optional[str], bool]:
        """Get sessions for a user with pagination."""
        return await self.sessions.get_user_sessions(user_id, page_size, continuation_token)
    
    async def get_session(self, session_id: str, user_id: str) -> Optional[Dict[str, Any]]:
        """Get a specific session."""
        return await self.sessions.get_session(session_id, user_id)
    
    async def update_session(self, session_id: str, user_id: str, updates: Dict[str, Any]) -> Dict[str, Any]:
        """Update a session."""
        return await self.sessions.update_session(session_id, user_id, updates)
    
    async def delete_session(self, session_id: str, user_id: str):
        """Delete a session and all its messages."""
        # Clear memory first
        self.memory_service.clear_session_history(session_id)
        
        # Delete messages first
        await self.messages.delete_session_messages(session_id, user_id)
        # Then delete the session
        await self.sessions.delete_session(session_id, user_id)
    
    async def archive_session(self, session_id: str, user_id: str) -> Dict[str, Any]:
        """Archive a session instead of deleting it."""
        # Save current memory state before archiving
        await self.memory_service.save_chat_history(session_id, user_id)
        
        # Clear from active memory
        self.memory_service.clear_session_history(session_id)
        
        return await self.sessions.archive_session(session_id, user_id)
    
    async def add_document_to_session(self, session_id: str, user_id: str, document_info: Dict[str, Any]) -> Dict[str, Any]:
        """Add a document to a session's documents list."""
        return await self.sessions.add_document_to_session(session_id, user_id, document_info)
    
    async def remove_document_from_session(self, session_id: str, user_id: str, document_id: str) -> Dict[str, Any]:
        """Remove a document from a session's documents list."""
        return await self.sessions.remove_document_from_session(session_id, user_id, document_id)
    
    # Message management methods (delegate to message_service)
    
    async def save_message(self, session_id: str, user_id: str, message_id: str, role: str, content: str, metadata: Optional[Dict] = None) -> Dict[str, Any]:
        """Save a message to a session and update memory."""
        # Save to CosmosDB
        result = await self.messages.save_message(session_id, user_id, message_id, role, content, metadata)
        
        # CRITICAL: Load existing chat history from database first to preserve any system messages
        # (e.g., document upload notifications) that may have been added
        await self.memory_service.load_chat_history(session_id, user_id)
        
        # Update chat history in memory
        if role == 'user':
            self.memory_service.add_user_message(session_id, content)
        elif role == 'assistant':
            # Extract agent name from metadata if available
            agent_name = None
            if metadata and 'agent_name' in metadata:
                agent_name = metadata['agent_name']
            self.memory_service.add_assistant_message(session_id, content, agent_name)
        
        # Periodically save memory to persistent storage
        await self.memory_service.save_chat_history(session_id, user_id)
        
        return result
    
    async def get_session_messages(self, session_id: str, user_id: str, page_size: int = 20, continuation_token: Optional[str] = None) -> Tuple[List[Dict[str, Any]], Optional[str], bool]:
        """Get messages for a session with pagination."""
        return await self.messages.get_session_messages(session_id, user_id, page_size, continuation_token)
    
    async def get_message(self, message_id: str, user_id: str) -> Optional[Dict[str, Any]]:
        """Get a specific message."""
        return await self.messages.get_message(message_id, user_id)
    
    async def update_message(self, message_id: str, user_id: str, updates: Dict[str, Any]) -> Dict[str, Any]:
        """Update a message."""
        return await self.messages.update_message(message_id, user_id, updates)
    
    async def delete_session_messages(self, session_id: str, user_id: str):
        """Delete all messages for a session."""
        return await self.messages.delete_session_messages(session_id, user_id)
    
    # Memory-specific methods
    
    async def load_session_memory(self, session_id: str, user_id: str):
        """Load chat history from storage into memory for a session."""
        await self.memory_service.load_chat_history(session_id, user_id)
    
    async def save_session_memory(self, session_id: str, user_id: str):
        """Save current chat history from memory to storage."""
        await self.memory_service.save_chat_history(session_id, user_id)
    
    def get_session_context(self, session_id: str, max_chars: int = 1000) -> str:
        """Get a summary of the conversation context for a session."""
        return self.memory_service.get_context_summary(session_id, max_chars)
    
    async def reduce_session_memory(self, session_id: str, target_count: int = 30) -> bool:
        """Reduce session memory by truncating old messages."""
        was_reduced = await self.memory_service.reduce_chat_history(session_id, target_count)
        if was_reduced:
            # Save the reduced history
            await self.memory_service.save_chat_history(session_id, "system")  # Use system as fallback user_id
        return was_reduced


# Global service instance
cosmos_service = CosmosDBService()
