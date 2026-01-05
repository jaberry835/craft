"""Flask API endpoint for multi-agent questions."""

from flask import Blueprint, request, jsonify
import asyncio
import os
from typing import Dict, Any, List
import uuid
from datetime import datetime, timezone

from src.utils.logging import get_logger
from src.utils.sse_emitter import sse_emitter
from src.agents.sse_multi_agent_system import SSEMultiAgentSystem
from services.token_management import token_manager

logger = get_logger(__name__)

# Create blueprint for agent routes
agent_bp = Blueprint('agents', __name__, url_prefix='/api')

# Global agent system instance
agent_system: SSEMultiAgentSystem = None


def initialize_agent_system():
    """Initialize the agent system with SSE support."""
    global agent_system
    
    if agent_system is not None:
        logger.info("🔄 Agent system already initialized")
        return True
    
    try:
        # Get Azure OpenAI configuration
        azure_api_key = os.getenv("AZURE_OPENAI_API_KEY")
        azure_endpoint = os.getenv("AZURE_OPENAI_ENDPOINT") 
        azure_deployment = os.getenv("AZURE_OPENAI_DEPLOYMENT", "gpt-4o")
        
        if not azure_api_key or not azure_endpoint:
            logger.error("❌ Missing Azure OpenAI configuration")
            return False
        
        # MCP server URL (not used directly - the MultiAgentSystem handles MCP internally)
        # But keep for compatibility
        mcp_server_url = os.getenv("MCP_SERVER_URL", "http://localhost:3001")
        
        # Create SSEMultiAgentSystem instance
        agent_system = SSEMultiAgentSystem(azure_endpoint, azure_api_key, azure_deployment, mcp_server_url)
        
        # Initialize the system
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        
        success = loop.run_until_complete(agent_system.initialize())
        loop.close()
        
        if success:
            logger.info("✅ SSE-aware Multi-Agent System initialized successfully")
            return True
        else:
            logger.error("❌ Failed to initialize SSE-aware agent system")
            agent_system = None
            return False
            
    except Exception as e:
        logger.error(f"❌ Error initializing SSE-aware agent system: {str(e)}")
        agent_system = None
        return False


@agent_bp.route('/ask', methods=['POST'])
def ask_agents():
    """Ask a question to the multi-agent system with real-time streaming."""
    try:
        # Initialize agent system if needed
        if agent_system is None:
            if not initialize_agent_system():
                return jsonify({
                    "error": "Agent system not available",
                    "message": "Failed to initialize multi-agent system. Check Azure OpenAI credentials."
                }), 500
        
        # Get question and session ID from request
        data = request.get_json()
        if not data or 'question' not in data:
            return jsonify({
                "error": "Missing question",
                "message": "Please provide a 'question' field in the request body"
            }), 400

        question = data['question'].strip()
        session_id = data.get('sessionId', str(uuid.uuid4()))

        # Extract ADX token and Authorization from headers for user impersonation
        adx_token = request.headers.get('X-ADX-Token')
        authorization = request.headers.get('Authorization')
        
        # Extract user ID from headers
        user_id = request.headers.get('X-User-Id')
        
        # Debug: Log all headers for troubleshooting
        logger.info(f"🔍 Request Headers Debug (Session: {session_id}):")
        for header_name, header_value in request.headers:
            if header_name.lower() in ['authorization', 'x-adx-token', 'x-user-id']:
                # Only log auth-related headers, and mask the actual token values
                masked_value = f"{header_value[:10]}..." if len(header_value) > 10 else header_value
                logger.info(f"  {header_name}: {masked_value}")
        
        if adx_token:
            logger.info(f"🔑 ADX token received for user impersonation (Session: {session_id})")
        else:
            logger.info(f"🔑 No ADX token provided, using system identity (Session: {session_id})")
        
        if not question:
            return jsonify({
                "error": "Empty question",
                "message": "Question cannot be empty"
            }), 400
        
        logger.info(f"Processing question: {question} (Session: {session_id})")
        
        # Ensure SSE session exists before emitting events
        sse_emitter.add_session(session_id)
        
        # Emit initial activity
        sse_emitter.emit_agent_activity(
            session_id=session_id,
            agent_name="System",
            action="Processing chat message",
            status="starting",
            details=f"Question: {question}"
        )
        
        # Process question through agent system
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        
        try:
            # The SSEMultiAgentSystem handles SSE events during processing
            # and properly sets context for the underlying MultiAgentSystem
            response = loop.run_until_complete(agent_system.process_question(question, session_id, user_id, adx_token, authorization))
            
            # Emit completion
            sse_emitter.emit_agent_activity(
                session_id=session_id,
                agent_name="System",
                action="Chat completion finished",
                status="completed",
                details=f"Response generated successfully"
            )
            
        finally:
            loop.close()
        
        return jsonify({
            "question": question,
            "response": response,
            "sessionId": session_id,
            "status": "success"
        })
        
    except Exception as e:
        logger.error(f"Error processing agent question: {str(e)}")
        
        # Emit error if we have session_id
        session_id = data.get('sessionId') if 'data' in locals() else None
        if session_id:
            sse_emitter.emit_error(
                session_id=session_id,
                message="Error processing question",
                details=str(e)
            )
        
        return jsonify({
            "error": "Processing error", 
            "message": str(e)
        }), 500


@agent_bp.route('/status', methods=['GET'])
def agent_status():
    """Get the status of the agent system."""
    try:
        if agent_system is None:
            return jsonify({
                "status": "not_initialized",
                "message": "Agent system not initialized. Send a POST to /ask to initialize.",
                "agents": []
            })
        
        return jsonify({
            "status": "active",
            "message": "Multi-agent system is active and ready",
            "agents": [
                {
                    "name": "CoordinatorAgent",
                    "role": "Coordinates other agents and routes questions",
                    "tools": "None (coordination only)"
                },
                {
                    "name": "MathAgent", 
                    "role": "Handles mathematical calculations and statistics",
                    "tools": ["add", "subtract", "multiply", "divide", "calculate_statistics"]
                },
                {
                    "name": "UtilityAgent",
                    "role": "Handles system utilities and helper functions", 
                    "tools": ["health_check", "get_timestamp", "generate_hash", "format_json"]
                }
            ]
        })
        
    except Exception as e:
        logger.error(f"Error getting agent status: {str(e)}")
        return jsonify({"error": "Status error", "message": str(e)}), 500


@agent_bp.route('/examples', methods=['GET'])
def get_examples():
    """Get example questions for the agent system."""
    return jsonify({
        "examples": [
            {
                "category": "Math",
                "questions": [
                    "What is 15 + 27?",
                    "Calculate 100 divided by 8",
                    "What's the average of 10, 20, 30, 40, 50?",
                    "Calculate statistics for: 5, 8, 12, 16, 20, 25"
                ]
            },
            {
                "category": "Utilities", 
                "questions": [
                    "Check the system health",
                    "What's the current timestamp?",
                    "Generate a SHA256 hash of 'Hello World'",
                    "Format this JSON: {\"name\":\"test\",\"value\":123}"
                ]
            },
            {
                "category": "Mixed",
                "questions": [
                    "Calculate 50 * 3 and also check the system health", 
                    "What's 25 divided by 5, and generate a hash of the result?",
                    "Get the current timestamp and calculate the square root of 144"
                ]
            }
        ]
    })


@agent_bp.route('/chat/completions', methods=['POST'])
def chat_completions():
    """Generate chat completion using multi-agent system - matches Angular UI format."""
    try:
        # Initialize agent system if needed
        if agent_system is None:
            if not initialize_agent_system():
                return jsonify({
                    "error": "Agent system not available",
                    "message": "Failed to initialize multi-agent system. Check Azure OpenAI credentials."
                }), 500
        
        # Get data from request
        data = request.get_json()
        if not data:
            return jsonify({"error": "Request body is required"}), 400
        
        messages = data.get('messages', [])
        user_id = data.get('userId')
        session_id = data.get('sessionId')
        use_rag = data.get('useRAG', False)
        use_mcp_tools = data.get('useMCPTools', False)
        
        if not messages:
            return jsonify({"error": "messages are required"}), 400
        
        if not user_id or not session_id:
            return jsonify({"error": "userId and sessionId are required"}), 400
        
        # Extract the latest user message (the one we need to process)
        user_question = None
        for msg in reversed(messages):
            if msg.get("role") == "user":
                user_question = msg.get("content")
                break

        # Extract ADX token and Authorization from headers for user impersonation
        adx_token = request.headers.get('X-ADX-Token')
        authorization = request.headers.get('Authorization')
            
        # Debug: Log all headers for troubleshooting
        logger.info(f"🔍 Chat Completions Headers Debug (Session: {session_id}):")
        for header_name, header_value in request.headers:
            if header_name.lower() in ['authorization', 'x-adx-token', 'x-user-id']:
                # Only log auth-related headers, and mask the actual token values
                masked_value = f"{header_value[:10]}..." if len(header_value) > 10 else header_value
                logger.info(f"  {header_name}: {masked_value}")
        
        if adx_token:
            logger.info(f"🔑 ADX token received for chat completions (Session: {session_id})")
        else:
            logger.info(f"🔑 No ADX token provided for chat completions (Session: {session_id})")

        if not user_question:
            return jsonify({"error": "No user message found"}), 400
        
        # 🔧 TOKEN MANAGEMENT: Validate and optimize messages before processing
        try:
            # Count tokens in current message set
            token_stats = token_manager.get_token_stats(
                messages=messages,
                system_prompt="Multi-agent system with specialized tools and memory context"
            )
            
            logger.info(f"📊 Token analysis: {token_stats['total_tokens']}/{token_manager.SAFE_LIMIT} tokens "
                       f"({token_stats['usage_percentage']}%)")
            
            # Optimize messages if approaching limit
            if token_stats['total_tokens'] > token_manager.AVAILABLE_FOR_HISTORY:
                logger.warning(f"⚠️ Messages exceed safe limit, optimizing...")
                messages = token_manager.optimize_messages_for_tokens(messages)
                
                # Recalculate stats
                token_stats = token_manager.get_token_stats(messages=messages)
                logger.info(f"📉 Optimized to: {token_stats['total_tokens']}/{token_manager.SAFE_LIMIT} tokens")
            
            # Log warning if still high usage
            if token_stats['usage_percentage'] > 85:
                logger.warning(f"🚨 High token usage: {token_stats['usage_percentage']}% - response may be truncated")
                
        except Exception as token_error:
            logger.warning(f"Token management failed: {token_error} - continuing with original messages")
        
        logger.info(f"Processing chat completion with multi-agent system for question: {user_question}")
        
        # Ensure SSE session exists before emitting events
        sse_emitter.add_session(session_id)
        
        # Emit initial activity for chat completion
        sse_emitter.emit_agent_activity(
            session_id=session_id,
            agent_name="System",
            action="Processing chat message",
            status="starting",
            details=f"Message: {user_question}"
        )
        
        # Process question through agent system
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        
        try:
            # Emit progress updates
            sse_emitter.emit_agent_activity(
                session_id=session_id,
                agent_name="Multi-Agent System",
                action="Analyzing message",
                status="in-progress",
                details="Processing with agent coordination"
            )
            
            # Run agent processing with both user_id, session_id, and ADX token
            # The SSEMultiAgentSystem will properly set context and emit SSE events
            agent_response = loop.run_until_complete(agent_system.process_question(user_question, session_id, user_id, adx_token, authorization))
            
            # Create assistant message with agent response
            assistant_message = {
                "id": str(uuid.uuid4()),
                "role": "assistant",
                "content": agent_response,
                "timestamp": datetime.now(timezone.utc).isoformat()
            }
            
            # Save assistant message to Cosmos DB
            from services.cosmos_service import cosmos_service
            loop.run_until_complete(cosmos_service.save_message(
                session_id=session_id,
                user_id=user_id,
                message_id=assistant_message["id"],
                role=assistant_message["role"],
                content=assistant_message["content"],
                metadata={
                    "sources": [],
                    "toolCalls": [],
                    "model": "multi-agent-system",
                    "finish_reason": "stop"
                }
            ))
            
            # Emit completion activity
            sse_emitter.emit_agent_activity(
                session_id=session_id,
                agent_name="System",
                action="Chat completion finished",
                status="completed",
                details="Message saved and response ready"
            )
            
        except Exception as inner_e:
            # Emit error activity
            sse_emitter.emit_error(
                session_id=session_id,
                message="Error during chat processing",
                details=str(inner_e)
            )
            raise
            
        finally:
            loop.close()
        
        # Return response in expected format for Angular UI
        response_data = {
            "message": assistant_message,
            "sources": [],  # RAG sources would go here
            "toolCalls": [],  # MCP tool calls would go here
            "agentInteractions": []  # Agent interactions would go here
        }
        
        logger.info(f"Generated chat completion using multi-agent system for session: {session_id}")
        return jsonify(response_data)
        
    except Exception as e:
        logger.error(f"Error processing chat completion: {str(e)}")
        return jsonify({
            "error": "Processing error", 
            "message": str(e)
        }), 500


@agent_bp.route('/research/pause', methods=['POST'])
def pause_research():
    """Pause ongoing research."""
    try:
        data = request.get_json()
        session_id = data.get('sessionId')
        
        if not session_id:
            return jsonify({'error': 'sessionId required'}), 400
        
        if agent_system and hasattr(agent_system, 'agent_system') and hasattr(agent_system.agent_system, 'host'):
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            try:
                loop.run_until_complete(agent_system.agent_system.host.pause_research(session_id))
                return jsonify({'success': True, 'message': 'Research pause requested'})
            finally:
                loop.close()
        
        return jsonify({'error': 'Agent system not available'}), 503
        
    except Exception as e:
        logger.error(f"Error pausing research: {e}")
        return jsonify({'error': str(e)}), 500


@agent_bp.route('/research/summary', methods=['POST'])
def request_summary():
    """Request progress summary."""
    try:
        data = request.get_json()
        session_id = data.get('sessionId')
        
        if not session_id:
            return jsonify({'error': 'sessionId required'}), 400
        
        if agent_system and hasattr(agent_system, 'agent_system') and hasattr(agent_system.agent_system, 'host'):
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            try:
                loop.run_until_complete(agent_system.agent_system.host.request_summary(session_id))
                return jsonify({'success': True, 'message': 'Summary requested'})
            finally:
                loop.close()
        
        return jsonify({'error': 'Agent system not available'}), 503
        
    except Exception as e:
        logger.error(f"Error requesting summary: {e}")
        return jsonify({'error': str(e)}), 500


# Cleanup function
def cleanup_agent_system():
    """Cleanup the agent system."""
    global agent_system
    if agent_system:
        try:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            loop.run_until_complete(agent_system.cleanup())
            agent_system = None
            logger.info("Agent system cleaned up successfully")
        except Exception as e:
            logger.error(f"Error cleaning up agent system: {str(e)}")


def get_agent_system():
    """Get the global agent system instance."""
    return agent_system
