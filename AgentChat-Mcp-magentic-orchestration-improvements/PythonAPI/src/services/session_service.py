"""Session management service for Azure Cosmos DB."""

import uuid
from typing import Dict, Any, Optional, Tuple, List
from datetime import datetime, timezone
from azure.cosmos.exceptions import CosmosResourceNotFoundError, CosmosHttpResponseError

from src.utils.logging import get_logger
from .cosmos_client import cosmos_client

logger = get_logger(__name__)


class SessionService:
    """Service for managing chat sessions in Azure Cosmos DB."""
    
    def __init__(self):
        self.client = cosmos_client
    
    async def create_session(self, user_id: str, title: str) -> Dict[str, Any]:
        """Create a new chat session."""
        if not self.client.is_available():
            raise Exception("Cosmos DB not available")
        
        session_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc)
        
        session = {
            "id": session_id,
            "title": title,
            "createdAt": now.isoformat(),
            "lastMessageAt": now.isoformat(),
            "updatedAt": now.isoformat(),
            "userId": user_id,
            "_partitionKey": user_id,
            "messageCount": 0,
            "isArchived": False,
            "documents": []
        }
        
        try:
            created_session = self.client.sessions_container.create_item(session)
            logger.info(f"Created session {session_id} for user {user_id}")
            return created_session
        except CosmosHttpResponseError as e:
            logger.error(f"Error creating session: {str(e)}")
            raise
    
    async def get_user_sessions(self, user_id: str, page_size: int = 20, continuation_token: Optional[str] = None) -> Tuple[List[Dict[str, Any]], Optional[str], bool]:
        """Get sessions for a user with pagination."""
        if not self.client.is_available():
            raise Exception("Cosmos DB not available")
        
        try:
            query = "SELECT * FROM c WHERE c.userId = @user_id AND (c.isArchived = false OR NOT IS_DEFINED(c.isArchived)) ORDER BY c.lastMessageAt DESC"
            parameters = [{"name": "@user_id", "value": user_id}]
            
            # Create query options
            query_options = {
                "max_item_count": page_size,
                "partition_key": user_id
            }
            
            if continuation_token:
                query_options["continuation"] = continuation_token
            
            # Execute query
            query_iterable = self.client.sessions_container.query_items(
                query=query,
                parameters=parameters,
                **query_options
            )
            
            sessions = []
            response_headers = {}
            
            # Get the first page
            for item in query_iterable:
                sessions.append(item)
                if len(sessions) >= page_size:
                    break
            
            # Get continuation token from response headers
            try:
                response_headers = query_iterable.response_headers
                next_continuation_token = response_headers.get("x-ms-continuation")
            except:
                next_continuation_token = None
            
            has_more = next_continuation_token is not None
            
            logger.info(f"Retrieved {len(sessions)} sessions for user {user_id}")
            return sessions, next_continuation_token, has_more
            
        except CosmosHttpResponseError as e:
            logger.error(f"Error getting user sessions: {str(e)}")
            raise
    
    async def get_session(self, session_id: str, user_id: str) -> Optional[Dict[str, Any]]:
        """Get a specific session."""
        if not self.client.is_available():
            raise Exception("Cosmos DB not available")
        
        try:
            session = self.client.sessions_container.read_item(
                item=session_id,
                partition_key=user_id
            )
            return session
        except CosmosResourceNotFoundError:
            return None
        except CosmosHttpResponseError as e:
            logger.error(f"Error getting session {session_id}: {str(e)}")
            raise
    
    async def update_session(self, session_id: str, user_id: str, updates: Dict[str, Any]) -> Dict[str, Any]:
        """Update a session."""
        if not self.client.is_available():
            raise Exception("Cosmos DB not available")
        
        try:
            # Get existing session
            session = await self.get_session(session_id, user_id)
            if not session:
                raise CosmosResourceNotFoundError(f"Session {session_id} not found")
            
            # Apply updates
            session.update(updates)
            session["updatedAt"] = datetime.now(timezone.utc).isoformat()
            
            # Save updated session
            updated_session = self.client.sessions_container.replace_item(
                item=session_id,
                body=session
            )
            
            logger.info(f"Updated session {session_id}")
            return updated_session
            
        except CosmosHttpResponseError as e:
            logger.error(f"Error updating session {session_id}: {str(e)}")
            raise
    
    async def delete_session(self, session_id: str, user_id: str):
        """Delete a session."""
        if not self.client.is_available():
            raise Exception("Cosmos DB not available")
        
        try:
            # Delete the session
            self.client.sessions_container.delete_item(
                item=session_id,
                partition_key=user_id
            )
            
            logger.info(f"Deleted session {session_id}")
            
        except CosmosHttpResponseError as e:
            logger.error(f"Error deleting session {session_id}: {str(e)}")
            raise
    
    async def archive_session(self, session_id: str, user_id: str) -> Dict[str, Any]:
        """Archive a session instead of deleting it."""
        updates = {
            "isArchived": True,
            "archivedAt": datetime.now(timezone.utc).isoformat()
        }
        return await self.update_session(session_id, user_id, updates)
    
    async def add_document_to_session(self, session_id: str, user_id: str, document_info: Dict[str, Any]) -> Dict[str, Any]:
        """Add a document to a session's documents list."""
        if not self.client.is_available():
            raise Exception("Cosmos DB not available")
        
        try:
            # Get the current session
            session = await self.get_session(session_id, user_id)
            if not session:
                raise Exception(f"Session {session_id} not found")
            
            # Get current documents list (or initialize if doesn't exist)
            documents = session.get("documents", [])
            
            # Add the new document to the list
            documents.append(document_info)
            
            # Update the session with the new documents list
            updates = {
                "documents": documents,
                "updatedAt": datetime.now(timezone.utc).isoformat()
            }
            
            updated_session = await self.update_session(session_id, user_id, updates)
            logger.info(f"Added document {document_info.get('id')} to session {session_id}")
            return updated_session
            
        except CosmosHttpResponseError as e:
            logger.error(f"Error adding document to session {session_id}: {str(e)}")
            raise
    
    async def remove_document_from_session(self, session_id: str, user_id: str, document_id: str) -> Dict[str, Any]:
        """Remove a document from a session's documents list."""
        if not self.client.is_available():
            raise Exception("Cosmos DB not available")
        
        try:
            # Get the current session
            session = await self.get_session(session_id, user_id)
            if not session:
                raise Exception(f"Session {session_id} not found")
            
            # Get current documents list
            documents = session.get("documents", [])
            
            # Remove the document with the matching ID
            documents = [doc for doc in documents if doc.get("id") != document_id]
            
            # Update the session with the filtered documents list
            updates = {
                "documents": documents,
                "updatedAt": datetime.now(timezone.utc).isoformat()
            }
            
            updated_session = await self.update_session(session_id, user_id, updates)
            logger.info(f"Removed document {document_id} from session {session_id}")
            return updated_session
            
        except CosmosHttpResponseError as e:
            logger.error(f"Error removing document from session {session_id}: {str(e)}")
            raise


# Global service instance
session_service = SessionService()
