"""Message management service for Azure Cosmos DB."""

from typing import Dict, Any, Optional, Tuple, List
from datetime import datetime, timezone
from azure.cosmos.exceptions import CosmosHttpResponseError

from src.utils.logging import get_logger
from .cosmos_client import cosmos_client
from .session_service import session_service

logger = get_logger(__name__)


class MessageService:
    """Service for managing chat messages in Azure Cosmos DB."""
    
    def __init__(self):
        self.client = cosmos_client
        self.session_service = session_service
    
    async def save_message(self, session_id: str, user_id: str, message_id: str, role: str, content: str, metadata: Optional[Dict] = None) -> Dict[str, Any]:
        """Save a message to a session."""
        if not self.client.is_available():
            raise Exception("Cosmos DB not available")
        
        now = datetime.now(timezone.utc)
        
        message = {
            "id": message_id,
            "content": content,
            "role": role,
            "timestamp": now.isoformat(),
            "sessionId": session_id,
            "userId": user_id,
            "_partitionKey": user_id,
            "metadata": metadata or {
                "sources": [],
                "toolCalls": [],
                "model": "multi-agent-system",
                "finish_reason": "stop"
            }
        }
        
        try:
            # Save message
            created_message = self.client.messages_container.create_item(message)
            
            # Update session's lastMessageAt and messageCount
            session = await self.session_service.get_session(session_id, user_id)
            if session:
                updates = {
                    "lastMessageAt": now.isoformat(),
                    "messageCount": session.get("messageCount", 0) + 1
                }
                await self.session_service.update_session(session_id, user_id, updates)
            
            logger.info(f"Saved message {message_id} to session {session_id}")
            return created_message
            
        except CosmosHttpResponseError as e:
            logger.error(f"Error saving message: {str(e)}")
            raise
    
    async def get_session_messages(self, session_id: str, user_id: str, page_size: int = 20, continuation_token: Optional[str] = None) -> Tuple[List[Dict[str, Any]], Optional[str], bool]:
        """Get messages for a session with pagination."""
        if not self.client.is_available():
            raise Exception("Cosmos DB not available")
        
        try:
            query = "SELECT * FROM c WHERE c.sessionId = @session_id AND c.userId = @user_id ORDER BY c.timestamp ASC"
            parameters = [
                {"name": "@session_id", "value": session_id},
                {"name": "@user_id", "value": user_id}
            ]
            
            # Create query options
            query_options = {
                "max_item_count": page_size,
                "partition_key": user_id
            }
            
            if continuation_token:
                query_options["continuation"] = continuation_token
            
            # Execute query
            query_iterable = self.client.messages_container.query_items(
                query=query,
                parameters=parameters,
                **query_options
            )
            
            messages = []
            response_headers = {}
            
            # Get the first page
            for item in query_iterable:
                messages.append(item)
                if len(messages) >= page_size:
                    break
            
            # Get continuation token from response headers
            try:
                response_headers = query_iterable.response_headers
                next_continuation_token = response_headers.get("x-ms-continuation")
            except:
                next_continuation_token = None
            
            has_more = next_continuation_token is not None
            
            logger.info(f"Retrieved {len(messages)} messages for session {session_id}")
            return messages, next_continuation_token, has_more
            
        except CosmosHttpResponseError as e:
            logger.error(f"Error getting session messages: {str(e)}")
            raise
    
    async def get_message(self, message_id: str, user_id: str) -> Optional[Dict[str, Any]]:
        """Get a specific message."""
        if not self.client.is_available():
            raise Exception("Cosmos DB not available")
        
        try:
            message = self.client.messages_container.read_item(
                item=message_id,
                partition_key=user_id
            )
            return message
        except Exception:
            return None
    
    async def update_message(self, message_id: str, user_id: str, updates: Dict[str, Any]) -> Dict[str, Any]:
        """Update a message."""
        if not self.client.is_available():
            raise Exception("Cosmos DB not available")
        
        try:
            # Get existing message
            message = await self.get_message(message_id, user_id)
            if not message:
                raise Exception(f"Message {message_id} not found")
            
            # Apply updates
            message.update(updates)
            message["updatedAt"] = datetime.now(timezone.utc).isoformat()
            
            # Save updated message
            updated_message = self.client.messages_container.replace_item(
                item=message_id,
                body=message
            )
            
            logger.info(f"Updated message {message_id}")
            return updated_message
            
        except CosmosHttpResponseError as e:
            logger.error(f"Error updating message {message_id}: {str(e)}")
            raise
    
    async def delete_session_messages(self, session_id: str, user_id: str):
        """Delete all messages for a session."""
        if not self.client.is_available():
            raise Exception("Cosmos DB not available")
        
        try:
            # Get all messages for the session
            query = "SELECT c.id FROM c WHERE c.sessionId = @session_id AND c.userId = @user_id"
            parameters = [
                {"name": "@session_id", "value": session_id},
                {"name": "@user_id", "value": user_id}
            ]
            
            messages = list(self.client.messages_container.query_items(
                query=query,
                parameters=parameters,
                partition_key=user_id
            ))
            
            # Delete each message
            for message in messages:
                self.client.messages_container.delete_item(
                    item=message["id"],
                    partition_key=user_id
                )
            
            logger.info(f"Deleted {len(messages)} messages for session {session_id}")
            
        except CosmosHttpResponseError as e:
            logger.error(f"Error deleting session messages: {str(e)}")
            raise
    
    async def search_messages(self, user_id: str, search_term: str, page_size: int = 20, continuation_token: Optional[str] = None) -> Tuple[List[Dict[str, Any]], Optional[str], bool]:
        """Search messages by content."""
        if not self.client.is_available():
            raise Exception("Cosmos DB not available")
        
        try:
            query = "SELECT * FROM c WHERE c.userId = @user_id AND CONTAINS(LOWER(c.content), LOWER(@search_term)) ORDER BY c.timestamp DESC"
            parameters = [
                {"name": "@user_id", "value": user_id},
                {"name": "@search_term", "value": search_term}
            ]
            
            # Create query options
            query_options = {
                "max_item_count": page_size,
                "partition_key": user_id
            }
            
            if continuation_token:
                query_options["continuation"] = continuation_token
            
            # Execute query
            query_iterable = self.client.messages_container.query_items(
                query=query,
                parameters=parameters,
                **query_options
            )
            
            messages = []
            
            # Get the first page
            for item in query_iterable:
                messages.append(item)
                if len(messages) >= page_size:
                    break
            
            # Get continuation token from response headers
            try:
                response_headers = query_iterable.response_headers
                next_continuation_token = response_headers.get("x-ms-continuation")
            except:
                next_continuation_token = None
            
            has_more = next_continuation_token is not None
            
            logger.info(f"Found {len(messages)} messages matching '{search_term}' for user {user_id}")
            return messages, next_continuation_token, has_more
            
        except CosmosHttpResponseError as e:
            logger.error(f"Error searching messages: {str(e)}")
            raise


# Global service instance
message_service = MessageService()
