"""SSE-aware wrapper for the multi-agent system."""

import asyncio
from typing import Optional
from src.utils.logging import get_logger
from src.utils.sse_emitter import sse_emitter
from src.agents.mas_a2a import MultiAgentSystem

logger = get_logger(__name__)


class SSEMultiAgentSystem:
    """Wrapper around MultiAgentSystem that ensures proper SSE context setup."""
    
    def __init__(self, azure_endpoint: str, azure_api_key: str, azure_deployment: str, mcp_server_url: str = None):
        # Note: mcp_server_url is kept for API compatibility but not used (MCP client is created internally)
        self.agent_system = MultiAgentSystem(azure_api_key, azure_endpoint, azure_deployment)
    
    async def initialize(self) -> bool:
        """Initialize the underlying agent system."""
        try:
            return await self.agent_system.initialize()
        except Exception as e:
            logger.error(f"Error initializing SSE-aware agent system: {str(e)}")
            return False
    
    async def cleanup(self):
        """Cleanup the underlying agent system."""
        try:
            await self.agent_system.cleanup()
        except Exception as e:
            logger.error(f"Error cleaning up SSE-aware agent system: {str(e)}")
    
    async def process_question(self, question: str, session_id: Optional[str] = None, user_id: Optional[str] = None, adx_token: Optional[str] = None, authorization: Optional[str] = None) -> str:
        """Process a question with SSE event emission.
        
        Args:
            question: The user's question to process
            session_id: The session ID for context and event emission
            user_id: The user ID for context and document access control
            adx_token: The ADX access token for user impersonation
        """
        logger.info(f"🔄 SSE wrapper processing question: {question}")
        logger.info(f"🔑 SSE wrapper context - Session: {session_id}, User: {user_id}, ADX Token: {'Available' if adx_token else 'Not provided'} Auth: {'Provided' if authorization else 'None'}")
        
        try:
            # Emit initial processing event at wrapper level
            if session_id:
                logger.info(f"📡 SSE wrapper emitting initial activity for session: {session_id}")
                sse_emitter.emit_agent_activity(
                    session_id=session_id,
                    agent_name="Multi-Agent System",
                    action="Initializing agent processing",
                    status="starting",
                    details=f"Processing question: {question}"
                )
            
            # The underlying MultiAgentSystem handles all SSE events and context
            # during processing, so we just pass through to it
            logger.info(f"🔄 SSE wrapper delegating to underlying MultiAgentSystem...")
            result = await self.agent_system.process_question(question, session_id, user_id, adx_token, authorization)
            logger.info(f"✅ SSE wrapper received result from MultiAgentSystem")
            
            # Emit completion event at wrapper level
            if session_id:
                logger.info(f"📡 SSE wrapper emitting completion activity for session: {session_id}")
                sse_emitter.emit_agent_activity(
                    session_id=session_id,
                    agent_name="Multi-Agent System",
                    action="Agent processing completed",
                    status="completed",
                    details="Final response generated successfully"
                )
            
            return result
            
        except Exception as e:
            logger.error(f"❌ SSE wrapper error processing question: {str(e)}")
            if session_id:
                sse_emitter.emit_agent_activity(
                    session_id=session_id,
                    agent_name="System",
                    action="Error processing question",
                    status="error",
                    details=f"Error: {str(e)}"
                )
            raise
