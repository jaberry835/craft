"""Memory service for managing chat history and context in chat sessions."""

import json
import pickle
import base64
import asyncio
from typing import Dict, Any, Optional, List
from datetime import datetime, timezone

try:
    from ..utils.logging import get_logger
    from .token_management import token_manager
except ImportError:
    from src.utils.logging import get_logger
    from services.token_management import token_manager

from semantic_kernel.contents import ChatHistory, ChatMessageContent, AuthorRole, TextContent, ImageContent

logger = get_logger(__name__)


class MemoryService:
    """Service for managing chat history and memory in chat sessions using Semantic Kernel."""
    
    def __init__(self, cosmos_service=None):
        """Initialize the memory service.
        
        Args:
            cosmos_service: CosmosDB service for persistence
        """
        self.cosmos_service = cosmos_service
        self._session_histories: Dict[str, ChatHistory] = {}
        
    def create_chat_history(self, session_id: str, max_messages: int = 50) -> ChatHistory:
        """Create a new ChatHistory for a session with manual truncation management.
        
        Args:
            session_id: The session ID
            max_messages: Maximum number of messages to keep (default: 50)
            
        Returns:
            ChatHistory: New chat history instance
        """
        # Create standard chat history (we'll manage truncation manually)
        chat_history = ChatHistory()
        
        # Add system message for context
        chat_history.add_system_message(
            "You are a helpful AI assistant with access to specialized agents and tools. "
            "You can maintain context across the conversation and provide comprehensive assistance."
        )
        
        self._session_histories[session_id] = chat_history
        logger.info(f"Created new ChatHistory for session {session_id} with max {max_messages} messages")
        
        # Store the max messages limit for later truncation
        self._max_messages = max_messages
        
        return chat_history
    
    def _truncate_if_needed(self, session_id: str) -> bool:
        """Truncate chat history if it exceeds the maximum message count.
        
        Args:
            session_id: The session ID
            
        Returns:
            bool: True if truncation was performed
        """
        chat_history = self._session_histories.get(session_id)
        if not chat_history:
            return False
        
        max_messages = getattr(self, '_max_messages', 50)
        
        if len(chat_history.messages) > max_messages + 10:  # Allow some buffer
            # Keep system messages and recent messages
            system_messages = [msg for msg in chat_history.messages if msg.role == AuthorRole.SYSTEM]
            other_messages = [msg for msg in chat_history.messages if msg.role != AuthorRole.SYSTEM]
            
            # Keep the most recent messages
            keep_count = max_messages - len(system_messages)
            if keep_count > 0:
                kept_messages = other_messages[-keep_count:]
            else:
                kept_messages = other_messages[-5:]  # Always keep at least 5 messages
            
            # Rebuild chat history
            new_history = ChatHistory()
            for msg in system_messages + kept_messages:
                new_history.add_message(msg)
            
            self._session_histories[session_id] = new_history
            logger.info(f"Auto-truncated ChatHistory for session {session_id}: {len(chat_history.messages)} → {len(new_history.messages)} messages")
            return True
        
        return False
    
    def get_chat_history(self, session_id: str) -> Optional[ChatHistory]:
        """Get the ChatHistory for a session.
        
        Args:
            session_id: The session ID
            
        Returns:
            ChatHistory or None if not found
        """
        return self._session_histories.get(session_id)
    
    def add_user_message(self, session_id: str, content: str, user_name: Optional[str] = None) -> ChatHistory:
        """Add a user message to the chat history.
        
        Args:
            session_id: The session ID
            content: Message content
            user_name: Optional user name
            
        Returns:
            ChatHistory: Updated chat history
        """
        chat_history = self._session_histories.get(session_id)
        if not chat_history:
            chat_history = self.create_chat_history(session_id)
        
        if user_name:
            # Add message with user name
            message = ChatMessageContent(
                role=AuthorRole.USER,
                name=user_name,
                content=content
            )
            chat_history.add_message(message)
        else:
            chat_history.add_user_message(content)
        
        # Auto-truncate if needed
        self._truncate_if_needed(session_id)
        
        logger.debug(f"Added user message to session {session_id}: {len(content)} characters")
        return chat_history
    
    def add_assistant_message(self, session_id: str, content: str, agent_name: Optional[str] = None) -> ChatHistory:
        """Add an assistant message to the chat history.
        
        Args:
            session_id: The session ID
            content: Message content
            agent_name: Optional agent name that generated the response
            
        Returns:
            ChatHistory: Updated chat history
        """
        chat_history = self._session_histories.get(session_id)
        if not chat_history:
            chat_history = self.create_chat_history(session_id)
        
        if agent_name:
            # Add message with agent name
            message = ChatMessageContent(
                role=AuthorRole.ASSISTANT,
                name=agent_name,
                content=content
            )
            chat_history.add_message(message)
        else:
            chat_history.add_assistant_message(content)
        
        # Auto-truncate if needed
        self._truncate_if_needed(session_id)
        
        logger.debug(f"Added assistant message to session {session_id}: {len(content)} characters")
        return chat_history
    
    def add_tool_message(self, session_id: str, tool_name: str, tool_id: str, result: str) -> ChatHistory:
        """Add a tool result message to the chat history.
        
        Args:
            session_id: The session ID
            tool_name: Name of the tool that was called
            tool_id: Tool call ID
            result: Tool execution result
            
        Returns:
            ChatHistory: Updated chat history
        """
        from semantic_kernel.contents import FunctionResultContent
        
        chat_history = self._session_histories.get(session_id)
        if not chat_history:
            chat_history = self.create_chat_history(session_id)
        
        # Add tool result
        message = ChatMessageContent(
            role=AuthorRole.TOOL,
            items=[
                FunctionResultContent(
                    name=tool_name,
                    id=tool_id,
                    result=result
                )
            ]
        )
        chat_history.add_message(message)
        
        logger.debug(f"Added tool result to session {session_id}: {tool_name}")
        return chat_history
    
    def simulate_function_call(self, session_id: str, function_name: str, call_id: str, arguments: Dict[str, Any]) -> ChatHistory:
        """Simulate a function call for providing context.
        
        Args:
            session_id: The session ID
            function_name: Name of the function
            call_id: Call ID
            arguments: Function arguments
            
        Returns:
            ChatHistory: Updated chat history
        """
        from semantic_kernel.contents import FunctionCallContent
        
        chat_history = self._session_histories.get(session_id)
        if not chat_history:
            chat_history = self.create_chat_history(session_id)
        
        # Add simulated function call
        message = ChatMessageContent(
            role=AuthorRole.ASSISTANT,
            items=[
                FunctionCallContent(
                    name=function_name,
                    id=call_id,
                    arguments=json.dumps(arguments)
                )
            ]
        )
        chat_history.add_message(message)
        
        logger.debug(f"Added simulated function call to session {session_id}: {function_name}")
        return chat_history
    
    def serialize_chat_history(self, chat_history: ChatHistory) -> str:
        """Serialize ChatHistory to a string for storage.
        
        Args:
            chat_history: The ChatHistory to serialize
            
        Returns:
            str: Serialized chat history
        """
        try:
            # Convert ChatHistory to a serializable format
            messages_data = []
            for message in chat_history.messages:
                message_dict = {
                    'role': message.role.value if hasattr(message.role, 'value') else str(message.role),
                    'content': str(message.content) if message.content else '',
                    'name': getattr(message, 'name', None),
                    'timestamp': datetime.now(timezone.utc).isoformat()
                }
                
                # Handle items (for tool calls, function results, etc.)
                if hasattr(message, 'items') and message.items:
                    message_dict['items'] = []
                    for item in message.items:
                        item_dict = {
                            'type': type(item).__name__,
                            'content': str(item) if hasattr(item, '__str__') else ''
                        }
                        
                        # Add specific properties for different item types
                        if hasattr(item, 'name'):
                            item_dict['name'] = item.name
                        if hasattr(item, 'id'):
                            item_dict['id'] = item.id
                        if hasattr(item, 'arguments'):
                            item_dict['arguments'] = item.arguments
                        if hasattr(item, 'result'):
                            item_dict['result'] = item.result
                        
                        message_dict['items'].append(item_dict)
                
                messages_data.append(message_dict)
            
            # Create the serializable structure
            history_data = {
                'messages': messages_data,
                'metadata': {
                    'created_at': datetime.now(timezone.utc).isoformat(),
                    'version': '1.0'
                }
            }
            
            # Serialize to JSON
            serialized = json.dumps(history_data, ensure_ascii=False, indent=None)
            logger.debug(f"Serialized ChatHistory with {len(messages_data)} messages")
            return serialized
            
        except Exception as e:
            logger.error(f"Error serializing ChatHistory: {str(e)}")
            raise
    
    def deserialize_chat_history(self, serialized_data: str, session_id: str) -> ChatHistory:
        """Deserialize a ChatHistory from stored data.
        
        Args:
            serialized_data: The serialized chat history data
            session_id: The session ID
            
        Returns:
            ChatHistory: Reconstructed chat history
        """
        try:
            data = json.loads(serialized_data)
            
            # Create new ChatHistory (we'll manage truncation manually)
            chat_history = ChatHistory()
            
            # Reconstruct messages
            for msg_data in data.get('messages', []):
                role_str = msg_data.get('role', 'user')
                content = msg_data.get('content', '')
                name = msg_data.get('name')
                
                # Map role string to AuthorRole
                if role_str.lower() in ['user', 'USER']:
                    role = AuthorRole.USER
                elif role_str.lower() in ['assistant', 'ASSISTANT']:
                    role = AuthorRole.ASSISTANT
                elif role_str.lower() in ['system', 'SYSTEM']:
                    role = AuthorRole.SYSTEM
                elif role_str.lower() in ['tool', 'TOOL']:
                    role = AuthorRole.TOOL
                else:
                    role = AuthorRole.USER  # Default fallback
                
                # Create basic message
                if role == AuthorRole.SYSTEM:
                    chat_history.add_system_message(content)
                elif role == AuthorRole.USER:
                    if name:
                        message = ChatMessageContent(role=role, name=name, content=content)
                        chat_history.add_message(message)
                    else:
                        chat_history.add_user_message(content)
                elif role == AuthorRole.ASSISTANT:
                    if name:
                        message = ChatMessageContent(role=role, name=name, content=content)
                        chat_history.add_message(message)
                    else:
                        chat_history.add_assistant_message(content)
                else:
                    # Handle tool messages and other complex types
                    message = ChatMessageContent(role=role, content=content)
                    if name:
                        message.name = name
                    chat_history.add_message(message)
            
            self._session_histories[session_id] = chat_history
            logger.info(f"Deserialized ChatHistory for session {session_id} with {len(chat_history.messages)} messages")
            return chat_history
            
        except Exception as e:
            logger.error(f"Error deserializing ChatHistory: {str(e)}")
            # Return empty chat history as fallback
            return self.create_chat_history(session_id)
    
    async def save_chat_history(self, session_id: str, user_id: str) -> bool:
        """Save the current ChatHistory to CosmosDB.
        
        Args:
            session_id: The session ID
            user_id: The user ID
            
        Returns:
            bool: True if successful, False otherwise
        """
        if not self.cosmos_service or not self.cosmos_service.is_available():
            logger.warning("CosmosDB not available for chat history persistence")
            return False
        
        chat_history = self._session_histories.get(session_id)
        if not chat_history:
            logger.warning(f"No chat history found for session {session_id}")
            return False
        
        try:
            # Serialize the chat history
            serialized_history = self.serialize_chat_history(chat_history)
            
            # Save to CosmosDB as session metadata
            await self.cosmos_service.update_session(session_id, user_id, {
                'chatHistory': serialized_history,
                'chatHistoryUpdatedAt': datetime.now(timezone.utc).isoformat()
            })
            
            logger.info(f"Saved ChatHistory for session {session_id}")
            return True
            
        except Exception as e:
            logger.error(f"Error saving ChatHistory for session {session_id}: {str(e)}")
            return False
    
    async def load_chat_history(self, session_id: str, user_id: str) -> Optional[ChatHistory]:
        """Load ChatHistory from CosmosDB.
        
        Args:
            session_id: The session ID
            user_id: The user ID
            
        Returns:
            ChatHistory or None if not found
        """
        if not self.cosmos_service or not self.cosmos_service.is_available():
            logger.warning("CosmosDB not available for chat history loading")
            return None
        
        try:
            # Get session data
            session = await self.cosmos_service.get_session(session_id, user_id)
            if not session:
                logger.warning(f"Session {session_id} not found")
                return None
            
            # Check if we have stored chat history
            serialized_history = session.get('chatHistory')
            if not serialized_history:
                logger.info(f"No stored ChatHistory found for session {session_id}, creating new one")
                return self.create_chat_history(session_id)
            
            # Deserialize and return
            chat_history = self.deserialize_chat_history(serialized_history, session_id)
            logger.info(f"Loaded ChatHistory for session {session_id}")
            return chat_history
            
        except Exception as e:
            logger.error(f"Error loading ChatHistory for session {session_id}: {str(e)}")
            return None
    
    async def reduce_chat_history(self, session_id: str, target_count: int = 30) -> bool:
        """Reduce chat history size by truncating old messages.
        
        Args:
            session_id: The session ID
            target_count: Target number of messages to keep
            
        Returns:
            bool: True if reduction was performed
        """
        chat_history = self._session_histories.get(session_id)
        if not chat_history:
            return False
        
        try:
            # If it's a ChatHistoryTruncationReducer, use its reduce method
            if hasattr(chat_history, 'reduce'):
                was_reduced = await chat_history.reduce()
                if was_reduced:
                    logger.info(f"Reduced ChatHistory for session {session_id} to {len(chat_history.messages)} messages")
                return was_reduced
            else:
                # Manual truncation for regular ChatHistory
                if len(chat_history.messages) > target_count:
                    # Keep system messages and truncate from the oldest user/assistant messages
                    system_messages = [msg for msg in chat_history.messages if msg.role == AuthorRole.SYSTEM]
                    other_messages = [msg for msg in chat_history.messages if msg.role != AuthorRole.SYSTEM]
                    
                    # Keep the most recent messages
                    keep_count = target_count - len(system_messages)
                    if keep_count > 0:
                        kept_messages = other_messages[-keep_count:]
                    else:
                        kept_messages = []
                    
                    # Rebuild chat history
                    new_history = ChatHistory()
                    for msg in system_messages + kept_messages:
                        new_history.add_message(msg)
                    
                    self._session_histories[session_id] = new_history
                    logger.info(f"Manually reduced ChatHistory for session {session_id} to {len(new_history.messages)} messages")
                    return True
                
            return False
            
        except Exception as e:
            logger.error(f"Error reducing ChatHistory for session {session_id}: {str(e)}")
            return False
    
    def clear_session_history(self, session_id: str):
        """Clear the chat history for a session from memory.
        
        Args:
            session_id: The session ID
        """
        if session_id in self._session_histories:
            del self._session_histories[session_id]
            logger.info(f"Cleared ChatHistory for session {session_id} from memory")
    
    def get_context_summary(self, session_id: str, max_chars: int = 1000) -> str:
        """Get a summary of the conversation context.
        
        Args:
            session_id: The session ID
            max_chars: Maximum characters in the summary
            
        Returns:
            str: Context summary
        """
        chat_history = self._session_histories.get(session_id)
        if not chat_history or not chat_history.messages:
            return "No conversation history available."
        
        try:
            # Get recent messages for context
            recent_messages = chat_history.messages[-10:]  # Last 10 messages
            
            summary_parts = []
            for msg in recent_messages:
                if msg.role == AuthorRole.USER:
                    summary_parts.append(f"User: {str(msg.content)[:100]}...")
                elif msg.role == AuthorRole.ASSISTANT:
                    summary_parts.append(f"Assistant: {str(msg.content)[:100]}...")
            
            summary = "\n".join(summary_parts)
            
            # Truncate if too long
            if len(summary) > max_chars:
                summary = summary[:max_chars] + "..."
            
            return summary
            
        except Exception as e:
            logger.error(f"Error generating context summary for session {session_id}: {str(e)}")
            return "Error generating context summary."
    
    def optimize_chat_history_for_tokens(self, session_id: str, max_tokens: Optional[int] = None) -> bool:
        """Optimize chat history to fit within token limits.
        
        Args:
            session_id: The session ID
            max_tokens: Maximum tokens allowed (defaults to safe limit)
            
        Returns:
            bool: True if optimization was performed
        """
        chat_history = self._session_histories.get(session_id)
        if not chat_history:
            return False
        
        # Convert to message list format for token counting
        messages = self.chat_history_to_messages(chat_history)
        original_count = len(messages)
        
        # Count current tokens
        current_tokens = token_manager.count_messages_tokens(messages)
        target_tokens = max_tokens or token_manager.AVAILABLE_FOR_HISTORY
        
        if current_tokens <= target_tokens:
            logger.debug(f"✅ Session {session_id} within token limit: {current_tokens}/{target_tokens}")
            return False
        
        logger.info(f"🔧 Optimizing session {session_id}: {current_tokens}/{target_tokens} tokens")
        
        # Optimize messages
        optimized_messages = token_manager.optimize_messages_for_tokens(messages, target_tokens)
        
        # Convert back to ChatHistory
        optimized_history = self.messages_to_chat_history(optimized_messages)
        self._session_histories[session_id] = optimized_history
        
        final_tokens = token_manager.count_messages_tokens(
            self.chat_history_to_messages(optimized_history)
        )
        
        logger.info(f"📉 Optimized session {session_id}: {original_count}→{len(optimized_messages)} messages, "
                   f"{current_tokens}→{final_tokens} tokens")
        
        return True
    
    def get_token_stats(self, session_id: str) -> Dict[str, int]:
        """Get token usage statistics for a session.
        
        Args:
            session_id: The session ID
            
        Returns:
            Dict with token statistics
        """
        chat_history = self._session_histories.get(session_id)
        if not chat_history:
            return {
                'messages_tokens': 0,
                'total_messages': 0,
                'usage_percentage': 0,
                'available_tokens': token_manager.AVAILABLE_FOR_HISTORY
            }
        
        messages = self.chat_history_to_messages(chat_history)
        tokens = token_manager.count_messages_tokens(messages)
        
        return {
            'messages_tokens': tokens,
            'total_messages': len(messages),
            'usage_percentage': int((tokens / token_manager.AVAILABLE_FOR_HISTORY) * 100),
            'available_tokens': token_manager.AVAILABLE_FOR_HISTORY - tokens,
            'max_tokens': token_manager.AVAILABLE_FOR_HISTORY
        }
    
    def chat_history_to_messages(self, chat_history: ChatHistory) -> List[Dict[str, Any]]:
        """Convert ChatHistory to message list format.
        
        Args:
            chat_history: Semantic Kernel ChatHistory
            
        Returns:
            List of message dictionaries
        """
        messages = []
        
        for msg in chat_history.messages:
            message = {
                'role': msg.role.value,
                'content': str(msg.content)
            }
            
            if hasattr(msg, 'name') and msg.name:
                message['name'] = msg.name
            
            messages.append(message)
        
        return messages
    
    def messages_to_chat_history(self, messages: List[Dict[str, Any]]) -> ChatHistory:
        """Convert message list to ChatHistory.
        
        Args:
            messages: List of message dictionaries
            
        Returns:
            ChatHistory: New ChatHistory instance
        """
        chat_history = ChatHistory()
        
        for msg in messages:
            role = AuthorRole(msg.get('role', 'user'))
            content = msg.get('content', '')
            name = msg.get('name')
            
            if name:
                message = ChatMessageContent(
                    role=role,
                    name=name,
                    content=content
                )
                chat_history.add_message(message)
            else:
                if role == AuthorRole.USER:
                    chat_history.add_user_message(content)
                elif role == AuthorRole.ASSISTANT:
                    chat_history.add_assistant_message(content)
                elif role == AuthorRole.SYSTEM:
                    chat_history.add_system_message(content)
        
        return chat_history
    
    def optimize_chat_history_for_tokens(self, session_id: str) -> bool:
        """Optimize chat history when approaching token limits.
        
        Args:
            session_id: The session ID to optimize
            
        Returns:
            bool: True if optimization was performed
        """
        try:
            chat_history = self._session_histories.get(session_id)
            if not chat_history or len(chat_history.messages) <= 10:
                return False
            
            # Import token manager
            try:
                from .token_management import token_manager
            except ImportError:
                logger.warning("Token manager not available for optimization")
                return False
            
            # Count tokens in current history
            total_content = ""
            for message in chat_history.messages:
                total_content += str(message.content) + "\n"
            
            current_tokens = token_manager.count_tokens(total_content)
            
            # If approaching limit, trim older messages
            if current_tokens > 80000:  # 80K token threshold
                logger.info(f"🔧 Optimizing memory - current: {current_tokens:,} tokens")
                
                # Keep system message + last 15 messages
                optimized_messages = []
                if chat_history.messages and hasattr(chat_history.messages[0], 'role') and chat_history.messages[0].role == "system":
                    optimized_messages.append(chat_history.messages[0])
                
                # Add recent messages
                recent_messages = chat_history.messages[-15:]
                optimized_messages.extend(recent_messages)
                
                # Update the chat history
                chat_history.messages = optimized_messages
                
                # Mark for saving (will be saved on next save operation)
                self._session_histories[session_id] = chat_history
                
                logger.info(f"✂️ Memory optimized to {len(optimized_messages)} messages")
                return True
            
            return False
            
        except Exception as e:
            logger.error(f"❌ Memory optimization error: {e}")
            return False
    
    def get_token_stats(self, session_id: str) -> dict:
        """Get token usage statistics for a session.
        
        Args:
            session_id: The session ID
            
        Returns:
            dict: Token usage statistics
        """
        try:
            chat_history = self._session_histories.get(session_id)
            if not chat_history:
                return {
                    "messages_tokens": 0, 
                    "max_tokens": 120000, 
                    "usage_percentage": 0, 
                    "total_messages": 0
                }
            
            # Import token manager
            try:
                from .token_management import token_manager
            except ImportError:
                return {
                    "messages_tokens": 0, 
                    "max_tokens": 120000, 
                    "usage_percentage": 0, 
                    "total_messages": len(chat_history.messages)
                }
            
            total_content = ""
            for message in chat_history.messages:
                total_content += str(message.content) + "\n"
            
            messages_tokens = token_manager.count_tokens(total_content)
            usage_percentage = (messages_tokens / 120000) * 100
            
            return {
                "messages_tokens": messages_tokens,
                "max_tokens": 120000,
                "usage_percentage": round(usage_percentage, 1),
                "total_messages": len(chat_history.messages)
            }
            
        except Exception as e:
            logger.error(f"❌ Token stats error: {e}")
            return {
                "messages_tokens": 0, 
                "max_tokens": 120000, 
                "usage_percentage": 0, 
                "total_messages": 0
            }


# Global memory service instance
memory_service = MemoryService()
