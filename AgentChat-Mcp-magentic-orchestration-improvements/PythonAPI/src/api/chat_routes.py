"""Flask API endpoints for chat sessions and messages using Cosmos DB with memory support."""

from flask import Blueprint, request, jsonify
import asyncio
import uuid
from datetime import datetime, timezone
from typing import Dict, Any

from src.utils.logging import get_logger
from services.cosmos_service import cosmos_service

logger = get_logger(__name__)

# Create blueprint for chat routes
chat_bp = Blueprint('chat', __name__, url_prefix='/api/chat')


@chat_bp.route('/sessions', methods=['GET'])
def get_sessions():
    """Get user's chat sessions."""
    try:
        user_id = request.args.get('userId')
        page_size = int(request.args.get('pageSize', 20))
        continuation_token = request.args.get('continuationToken')
        
        if not user_id:
            return jsonify({"error": "userId parameter is required"}), 400
        
        # Check if Cosmos DB is available
        if not cosmos_service.is_available():
            return jsonify({"error": "Database not available"}), 500
        
        # Get sessions from Cosmos DB
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        
        try:
            sessions, next_token, has_more = loop.run_until_complete(
                cosmos_service.get_user_sessions(user_id, page_size, continuation_token)
            )
        finally:
            loop.close()
        
        # Convert sessions to expected format
        user_sessions = []
        for session in sessions:
            session_data = {
                "id": session["id"],
                "title": session["title"],
                "createdAt": session["createdAt"],
                "updatedAt": session.get("updatedAt", session["createdAt"]),
                "userId": session["userId"],
                "messages": []  # Messages are loaded separately
            }
            user_sessions.append(session_data)
        
        response = {
            "sessions": user_sessions,
            "hasMore": has_more,
            "continuationToken": next_token
        }
        
        logger.info(f"Retrieved {len(user_sessions)} sessions for user: {user_id}")
        return jsonify(response)
        
    except Exception as e:
        logger.error(f"Error getting sessions: {str(e)}")
        return jsonify({"error": "Internal server error"}), 500


@chat_bp.route('/session', methods=['POST'])
def create_session():
    """Create a new chat session with memory initialization."""
    try:
        data = request.get_json()
        if not data:
            return jsonify({"error": "Request body is required"}), 400
        
        user_id = data.get('userId')
        title = data.get('title', f"New Chat {datetime.now().strftime('%H:%M:%S')}")
        
        if not user_id:
            return jsonify({"error": "userId is required"}), 400
        
        # Check if Cosmos DB is available
        if not cosmos_service.is_available():
            return jsonify({"error": "Database not available"}), 500
        
        # Create session using Cosmos DB (this will also initialize memory)
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        
        try:
            session = loop.run_until_complete(
                cosmos_service.create_session(user_id, title)
            )
        finally:
            loop.close()
        
        logger.info(f"Created new session with memory: {session['id']} for user: {user_id}")
        
        return jsonify({"sessionId": session["id"]})
        
    except Exception as e:
        logger.error(f"Error creating session: {str(e)}")
        return jsonify({"error": "Internal server error"}), 500


@chat_bp.route('/session/<session_id>', methods=['GET'])
def get_session(session_id: str):
    """Get session details."""
    try:
        user_id = request.args.get('userId')
        if not user_id:
            return jsonify({"error": "userId parameter is required"}), 400
        
        # Check if Cosmos DB is available
        if not cosmos_service.is_available():
            return jsonify({"error": "Database not available"}), 500
        
        # Get session from Cosmos DB
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        
        try:
            session = loop.run_until_complete(
                cosmos_service.get_session(session_id, user_id)
            )
        finally:
            loop.close()
        
        if not session:
            return jsonify({"error": "Session not found"}), 404
        
        return jsonify(session), 200
    
    except Exception as e:
        logger.error(f"Error getting session {session_id}: {str(e)}")
        return jsonify({
            "error": "Session error", 
            "message": str(e)
        }), 500


@chat_bp.route('/session/<session_id>', methods=['PUT'])
def update_session(session_id: str):
    """Update a chat session."""
    try:
        data = request.get_json()
        if not data:
            return jsonify({"error": "Request body is required"}), 400
        
        user_id = data.get('userId')
        if not user_id:
            return jsonify({"error": "userId is required"}), 400
        
        # Check if Cosmos DB is available
        if not cosmos_service.is_available():
            return jsonify({"error": "Database not available"}), 500
        
        # Get session from Cosmos DB to verify it exists and user owns it
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        
        try:
            session = loop.run_until_complete(
                cosmos_service.get_session(session_id, user_id)
            )
            
            if not session:
                return jsonify({"error": "Session not found"}), 404
            
            # Prepare updates
            updates = {}
            if 'title' in data:
                updates['title'] = data['title']
            
            if updates:
                loop.run_until_complete(
                    cosmos_service.update_session(session_id, user_id, updates)
                )
                
        finally:
            loop.close()
        
        logger.info(f"Updated session: {session_id}")
        return jsonify({"success": True})
        
    except Exception as e:
        logger.error(f"Error updating session: {str(e)}")
        return jsonify({"error": "Internal server error"}), 500


@chat_bp.route('/session/<session_id>', methods=['DELETE'])
def delete_session(session_id: str):
    """Delete a chat session and all its messages."""
    try:
        user_id = request.args.get('userId')
        if not user_id:
            return jsonify({"error": "userId parameter is required"}), 400
        
        # Check if Cosmos DB is available
        if not cosmos_service.is_available():
            return jsonify({"error": "Database not available"}), 500
        
        # Delete session using Cosmos DB
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        
        try:
            loop.run_until_complete(
                cosmos_service.delete_session(session_id, user_id)
            )
        finally:
            loop.close()
        
        logger.info(f"Deleted session: {session_id}")
        return jsonify({"success": True}), 200
        
    except Exception as e:
        logger.error(f"Error deleting session {session_id}: {str(e)}")
        return jsonify({"error": "Internal server error"}), 500


@chat_bp.route('/message', methods=['POST'])
def save_message():
    """Save a message to a session."""
    try:
        data = request.get_json()
        if not data:
            return jsonify({"error": "Request body is required"}), 400
        
        session_id = data.get('sessionId')
        user_id = data.get('userId')
        message_id = data.get('id')
        role = data.get('role')
        content = data.get('content')
        timestamp = data.get('timestamp')
        
        if not all([session_id, user_id, message_id, role, content]):
            return jsonify({"error": "sessionId, userId, id, role, and content are required"}), 400
        
        # Check if Cosmos DB is available
        if not cosmos_service.is_available():
            return jsonify({"error": "Database not available"}), 500
        
        # Verify session exists and user owns it
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        
        try:
            session = loop.run_until_complete(
                cosmos_service.get_session(session_id, user_id)
            )
            
            if not session:
                return jsonify({"error": "Session not found"}), 404
            
            # Save message to Cosmos DB
            saved_message = loop.run_until_complete(
                cosmos_service.save_message(
                    session_id=session_id,
                    user_id=user_id,
                    message_id=message_id,
                    role=role,
                    content=content,
                    metadata={
                        "timestamp": timestamp or datetime.now(timezone.utc).isoformat()
                    }
                )
            )
            
        finally:
            loop.close()
        
        logger.info(f"Saved message to session: {session_id}")
        return jsonify({"messageId": message_id})
        
    except Exception as e:
        logger.error(f"Error saving message: {str(e)}")
        return jsonify({"error": "Internal server error"}), 500


@chat_bp.route('/history', methods=['GET'])
def get_chat_history():
    """Get chat history/messages for a session."""
    try:
        session_id = request.args.get('sessionId')
        user_id = request.args.get('userId')
        page_size = int(request.args.get('pageSize', 20))
        continuation_token = request.args.get('continuationToken')
        
        if not session_id or not user_id:
            return jsonify({"error": "sessionId and userId parameters are required"}), 400
        
        # Check if Cosmos DB is available
        if not cosmos_service.is_available():
            return jsonify({"error": "Database not available"}), 500
        
        # Get messages from Cosmos DB
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        
        try:
            messages, next_token, has_more = loop.run_until_complete(
                cosmos_service.get_session_messages(session_id, user_id, page_size, continuation_token)
            )
        finally:
            loop.close()
        
        # Convert messages to expected format
        chat_messages = []
        for msg in messages:
            message_data = {
                "id": msg["id"],
                "role": msg["role"],
                "content": msg["content"],
                "timestamp": msg["timestamp"],
                "sessionId": msg["sessionId"]
            }
            # Add metadata if present
            if "metadata" in msg and msg["metadata"]:
                message_data.update(msg["metadata"])
            
            chat_messages.append(message_data)
        
        response = {
            "messages": chat_messages,
            "hasMore": has_more,
            "continuationToken": next_token
        }
        
        logger.info(f"Retrieved {len(chat_messages)} messages for session: {session_id}")
        return jsonify(response)
        
    except Exception as e:
        logger.error(f"Error getting chat history: {str(e)}")
        return jsonify({"error": "Internal server error"}), 500


@chat_bp.route('/messages/<session_id>', methods=['GET'])
def get_session_messages(session_id: str):
    """Get messages for a session with pagination."""
    try:
        user_id = request.args.get('userId')
        page_size = int(request.args.get('pageSize', 20))
        continuation_token = request.args.get('continuationToken')
        
        if not user_id:
            return jsonify({"error": "userId parameter is required"}), 400
        
        # Check if Cosmos DB is available
        if not cosmos_service.is_available():
            return jsonify({"error": "Database not available"}), 500
        
        # Get messages from Cosmos DB
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        
        try:
            messages, next_token, has_more = loop.run_until_complete(
                cosmos_service.get_session_messages(session_id, user_id, page_size, continuation_token)
            )
        finally:
            loop.close()
        
        # Return messages in expected format
        response = {
            "messages": messages,
            "hasMore": has_more,
            "continuationToken": next_token
        }
        
        return jsonify(response), 200
    
    except Exception as e:
        logger.error(f"Error getting messages for session {session_id}: {str(e)}")
        return jsonify({
            "error": "Messages error", 
            "message": str(e)
        }), 500


@chat_bp.route('/search', methods=['GET'])
def search_messages():
    """Search messages by content."""
    try:
        user_id = request.args.get('userId')
        search_term = request.args.get('q')
        page_size = int(request.args.get('pageSize', 20))
        continuation_token = request.args.get('continuationToken')
        
        if not user_id or not search_term:
            return jsonify({"error": "userId and q parameters are required"}), 400
        
        # Check if Cosmos DB is available
        if not cosmos_service.is_available():
            return jsonify({"error": "Database not available"}), 500
        
        # Search messages in Cosmos DB
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        
        try:
            messages, next_token, has_more = loop.run_until_complete(
                cosmos_service.search_messages(user_id, search_term, page_size, continuation_token)
            )
        finally:
            loop.close()
        
        response = {
            "messages": messages,
            "hasMore": has_more,
            "continuationToken": next_token,
            "searchTerm": search_term
        }
        
        logger.info(f"Found {len(messages)} messages matching '{search_term}' for user {user_id}")
        return jsonify(response)
        
    except Exception as e:
        logger.error(f"Error searching messages: {str(e)}")
        return jsonify({"error": "Internal server error"}), 500


@chat_bp.route('/session/<session_id>/memory/load', methods=['POST'])
def load_session_memory(session_id: str):
    """Load chat history memory for a session."""
    try:
        data = request.get_json()
        if not data:
            return jsonify({"error": "Request body is required"}), 400
        
        user_id = data.get('userId')
        if not user_id:
            return jsonify({"error": "userId is required"}), 400
        
        # Check if Cosmos DB is available
        if not cosmos_service.is_available():
            return jsonify({"error": "Database not available"}), 500
        
        # Load memory for the session
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        
        try:
            loop.run_until_complete(cosmos_service.load_session_memory(session_id, user_id))
            
            # Get context summary
            context_summary = cosmos_service.get_session_context(session_id, 500)
            
        finally:
            loop.close()
        
        response = {
            "success": True,
            "contextSummary": context_summary
        }
        
        logger.info(f"Loaded memory for session: {session_id}")
        return jsonify(response)
        
    except Exception as e:
        logger.error(f"Error loading session memory: {str(e)}")
        return jsonify({"error": "Internal server error"}), 500


@chat_bp.route('/session/<session_id>/memory/save', methods=['POST'])
def save_session_memory(session_id: str):
    """Save current chat history memory for a session."""
    try:
        data = request.get_json()
        if not data:
            return jsonify({"error": "Request body is required"}), 400
        
        user_id = data.get('userId')
        if not user_id:
            return jsonify({"error": "userId is required"}), 400
        
        # Check if Cosmos DB is available
        if not cosmos_service.is_available():
            return jsonify({"error": "Database not available"}), 500
        
        # Save memory for the session
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        
        try:
            loop.run_until_complete(cosmos_service.save_session_memory(session_id, user_id))
        finally:
            loop.close()
        
        logger.info(f"Saved memory for session: {session_id}")
        return jsonify({"success": True})
        
    except Exception as e:
        logger.error(f"Error saving session memory: {str(e)}")
        return jsonify({"error": "Internal server error"}), 500


@chat_bp.route('/session/<session_id>/memory/reduce', methods=['POST'])
def reduce_session_memory(session_id: str):
    """Reduce session memory by truncating old messages."""
    try:
        data = request.get_json()
        if not data:
            return jsonify({"error": "Request body is required"}), 400
        
        user_id = data.get('userId')
        target_count = data.get('targetCount', 30)
        
        if not user_id:
            return jsonify({"error": "userId is required"}), 400
        
        # Check if Cosmos DB is available
        if not cosmos_service.is_available():
            return jsonify({"error": "Database not available"}), 500
        
        # Reduce memory for the session
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        
        try:
            was_reduced = loop.run_until_complete(cosmos_service.reduce_session_memory(session_id, target_count))
        finally:
            loop.close()
        
        response = {
            "success": True,
            "wasReduced": was_reduced
        }
        
        logger.info(f"Memory reduction for session {session_id}: {'performed' if was_reduced else 'not needed'}")
        return jsonify(response)
        
    except Exception as e:
        logger.error(f"Error reducing session memory: {str(e)}")
        return jsonify({"error": "Internal server error"}), 500


@chat_bp.route('/session/<session_id>/context', methods=['GET'])
def get_session_context(session_id: str):
    """Get conversation context summary for a session."""
    try:
        max_chars = int(request.args.get('maxChars', 1000))
        
        # Get context summary
        context_summary = cosmos_service.get_session_context(session_id, max_chars)
        
        response = {
            "sessionId": session_id,
            "contextSummary": context_summary,
            "maxChars": max_chars
        }
        
        return jsonify(response)
        
    except Exception as e:
        logger.error(f"Error getting session context: {str(e)}")
        return jsonify({"error": "Internal server error"}), 500


@chat_bp.route('/sessions/summary', methods=['GET'])
def get_sessions_summary():
    """Get summary of all chat sessions for a user."""
    try:
        user_id = request.args.get('userId')
        
        if not user_id:
            return jsonify({"error": "userId parameter is required"}), 400
        
        # Check if Cosmos DB is available
        if not cosmos_service.is_available():
            return jsonify({"error": "Database not available"}), 500
        
        # Get sessions summary from Cosmos DB
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        
        try:
            summaries = loop.run_until_complete(
                cosmos_service.get_sessions_summary(user_id)
            )
        finally:
            loop.close()
        
        return jsonify({"summaries": summaries}), 200
    
    except Exception as e:
        logger.error(f"Error getting sessions summary: {str(e)}")
        return jsonify({"error": "Internal server error"}), 500


@chat_bp.route('/session/<session_id>/memory/summary', methods=['GET'])
def get_memory_summary(session_id: str):
    """Get summary of chat history memory for a session."""
    try:
        user_id = request.args.get('userId')
        
        if not user_id:
            return jsonify({"error": "userId parameter is required"}), 400
        
        # Check if Cosmos DB is available
        if not cosmos_service.is_available():
            return jsonify({"error": "Database not available"}), 500
        
        # Get memory summary from Cosmos DB
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        
        try:
            summary = loop.run_until_complete(
                cosmos_service.get_memory_summary(session_id, user_id)
            )
        finally:
            loop.close()
        
        return jsonify({"summary": summary}), 200
    
    except Exception as e:
        logger.error(f"Error getting memory summary for session {session_id}: {str(e)}")
        return jsonify({
            "error": "Memory summary error", 
            "message": str(e)
        }), 500


@chat_bp.route('/session/<session_id>/tokens', methods=['GET'])
def get_session_token_stats(session_id: str):
    """Get token usage statistics for a session."""
    try:
        from services.token_management import token_manager
        from services.memory_service import memory_service
        
        # Get token statistics from memory service
        token_stats = memory_service.get_token_stats(session_id)
        
        return jsonify({
            "sessionId": session_id,
            "tokenStats": token_stats,
            "limits": {
                "maxTokens": token_manager.MAX_TOKENS,
                "safeLimit": token_manager.SAFE_LIMIT,
                "availableForHistory": token_manager.AVAILABLE_FOR_HISTORY
            },
            "recommendations": _get_token_recommendations(token_stats)
        })
    
    except Exception as e:
        logger.error(f"Error getting token stats for session {session_id}: {str(e)}")
        return jsonify({
            "error": "Token stats error", 
            "message": str(e)
        }), 500


@chat_bp.route('/session/<session_id>/tokens/optimize', methods=['POST'])
def optimize_session_tokens(session_id: str):
    """Optimize session memory for token limits."""
    try:
        from services.memory_service import memory_service
        
        data = request.get_json() or {}
        max_tokens = data.get('maxTokens')
        
        # Optimize the session memory
        was_optimized = memory_service.optimize_chat_history_for_tokens(session_id, max_tokens)
        
        # Get updated stats
        token_stats = memory_service.get_token_stats(session_id)
        
        return jsonify({
            "sessionId": session_id,
            "wasOptimized": was_optimized,
            "tokenStats": token_stats,
            "message": "Memory optimized successfully" if was_optimized else "No optimization needed"
        })
    
    except Exception as e:
        logger.error(f"Error optimizing tokens for session {session_id}: {str(e)}")
        return jsonify({
            "error": "Token optimization error", 
            "message": str(e)
        }), 500


def _get_token_recommendations(token_stats: dict) -> list:
    """Get recommendations based on token usage."""
    recommendations = []
    usage_percentage = token_stats.get('usage_percentage', 0)
    
    if usage_percentage > 90:
        recommendations.append("Critical: Consider starting a new conversation to avoid token limit errors")
    elif usage_percentage > 75:
        recommendations.append("High usage: Memory optimization recommended")
        recommendations.append("Consider summarizing older parts of the conversation")
    elif usage_percentage > 50:
        recommendations.append("Moderate usage: Monitor conversation length")
    else:
        recommendations.append("Good: Plenty of token space available")
    
    if token_stats.get('total_messages', 0) > 30:
        recommendations.append("Long conversation: Consider using memory reduction features")
    
    return recommendations
