import asyncio
import logging
import json
from typing import Dict, List, Any, Optional
from datetime import datetime
import socketio
from flask import Flask
from ..models.chat_models import AgentInteraction

logger = logging.getLogger(__name__)

class AgentActivityStreamer:
    """Real-time agent activity streaming using SocketIO"""
    
    def __init__(self, app: Flask):
        self.app = app
        self.sio = socketio.AsyncServer(cors_allowed_origins="*", async_mode='threading')
        self.socketio_app = socketio.ASGIApp(self.sio, app)
        
        # Track active connections and their subscriptions
        self.active_connections: Dict[str, Dict[str, Any]] = {}
        self.session_subscriptions: Dict[str, List[str]] = {}  # session_id -> [socket_ids]
        
        self._setup_socketio_handlers()
        
    def _setup_socketio_handlers(self):
        """Set up SocketIO event handlers"""
        
        @self.sio.event
        async def connect(sid, environ):
            """Handle client connection"""
            logger.info(f"Client connected: {sid}")
            self.active_connections[sid] = {
                "connected_at": datetime.utcnow().isoformat(),
                "subscribed_sessions": []
            }
            await self.sio.emit('connection_established', {'sid': sid}, room=sid)
        
        @self.sio.event
        async def disconnect(sid):
            """Handle client disconnection"""
            logger.info(f"Client disconnected: {sid}")
            
            # Remove from session subscriptions
            if sid in self.active_connections:
                for session_id in self.active_connections[sid]["subscribed_sessions"]:
                    if session_id in self.session_subscriptions:
                        if sid in self.session_subscriptions[session_id]:
                            self.session_subscriptions[session_id].remove(sid)
                        if not self.session_subscriptions[session_id]:
                            del self.session_subscriptions[session_id]
                
                del self.active_connections[sid]
        
        @self.sio.event
        async def subscribe_session(sid, data):
            """Subscribe to agent activity for a specific session"""
            try:
                session_id = data.get('session_id')
                if not session_id:
                    await self.sio.emit('error', {'message': 'session_id required'}, room=sid)
                    return
                
                logger.info(f"Client {sid} subscribing to session {session_id}")
                
                # Add to session subscriptions
                if session_id not in self.session_subscriptions:
                    self.session_subscriptions[session_id] = []
                
                if sid not in self.session_subscriptions[session_id]:
                    self.session_subscriptions[session_id].append(sid)
                
                # Update connection info
                if sid in self.active_connections:
                    if session_id not in self.active_connections[sid]["subscribed_sessions"]:
                        self.active_connections[sid]["subscribed_sessions"].append(session_id)
                
                await self.sio.emit('subscription_confirmed', {
                    'session_id': session_id,
                    'status': 'subscribed'
                }, room=sid)
                
            except Exception as e:
                logger.error(f"Error in subscribe_session: {str(e)}")
                await self.sio.emit('error', {'message': str(e)}, room=sid)
        
        @self.sio.event
        async def unsubscribe_session(sid, data):
            """Unsubscribe from agent activity for a specific session"""
            try:
                session_id = data.get('session_id')
                if not session_id:
                    await self.sio.emit('error', {'message': 'session_id required'}, room=sid)
                    return
                
                logger.info(f"Client {sid} unsubscribing from session {session_id}")
                
                # Remove from session subscriptions
                if session_id in self.session_subscriptions:
                    if sid in self.session_subscriptions[session_id]:
                        self.session_subscriptions[session_id].remove(sid)
                    if not self.session_subscriptions[session_id]:
                        del self.session_subscriptions[session_id]
                
                # Update connection info
                if sid in self.active_connections:
                    if session_id in self.active_connections[sid]["subscribed_sessions"]:
                        self.active_connections[sid]["subscribed_sessions"].remove(session_id)
                
                await self.sio.emit('unsubscription_confirmed', {
                    'session_id': session_id,
                    'status': 'unsubscribed'
                }, room=sid)
                
            except Exception as e:
                logger.error(f"Error in unsubscribe_session: {str(e)}")
                await self.sio.emit('error', {'message': str(e)}, room=sid)
        
        @self.sio.event
        async def get_active_sessions(sid, data):
            """Get list of sessions the client is subscribed to"""
            try:
                if sid in self.active_connections:
                    subscribed_sessions = self.active_connections[sid]["subscribed_sessions"]
                    await self.sio.emit('active_sessions', {
                        'sessions': subscribed_sessions
                    }, room=sid)
                else:
                    await self.sio.emit('active_sessions', {
                        'sessions': []
                    }, room=sid)
                    
            except Exception as e:
                logger.error(f"Error in get_active_sessions: {str(e)}")
                await self.sio.emit('error', {'message': str(e)}, room=sid)
    
    async def stream_agent_interaction(self, interaction: AgentInteraction, session_id: str):
        """Stream an agent interaction to subscribed clients"""
        try:
            if session_id not in self.session_subscriptions:
                logger.debug(f"No subscribers for session {session_id}")
                return
            
            # Prepare interaction data for streaming
            interaction_data = {
                "agent_name": interaction.agent_name,
                "action": interaction.action,
                "details": interaction.details,
                "status": interaction.status,
                "timestamp": interaction.timestamp.isoformat(),
                "session_id": session_id
            }
            
            # Send to all subscribers of this session
            for socket_id in self.session_subscriptions[session_id]:
                try:
                    await self.sio.emit('agent_interaction', interaction_data, room=socket_id)
                    logger.debug(f"Streamed interaction to client {socket_id} for session {session_id}")
                except Exception as e:
                    logger.error(f"Failed to stream to client {socket_id}: {str(e)}")
                    # Remove failed connection
                    if socket_id in self.active_connections:
                        del self.active_connections[socket_id]
                    self.session_subscriptions[session_id].remove(socket_id)
            
            # Clean up empty session subscriptions
            if not self.session_subscriptions[session_id]:
                del self.session_subscriptions[session_id]
                
        except Exception as e:
            logger.error(f"Error streaming agent interaction: {str(e)}")
    
    async def stream_workflow_start(self, session_id: str, workflow_type: str, description: str):
        """Stream workflow start notification"""
        try:
            if session_id not in self.session_subscriptions:
                return
            
            workflow_data = {
                "event_type": "workflow_start",
                "workflow_type": workflow_type,
                "description": description,
                "timestamp": datetime.utcnow().isoformat(),
                "session_id": session_id
            }
            
            for socket_id in self.session_subscriptions[session_id]:
                try:
                    await self.sio.emit('workflow_event', workflow_data, room=socket_id)
                except Exception as e:
                    logger.error(f"Failed to stream workflow start to client {socket_id}: {str(e)}")
                    
        except Exception as e:
            logger.error(f"Error streaming workflow start: {str(e)}")
    
    async def stream_workflow_complete(self, session_id: str, workflow_type: str, success: bool, result_summary: str):
        """Stream workflow completion notification"""
        try:
            if session_id not in self.session_subscriptions:
                return
            
            workflow_data = {
                "event_type": "workflow_complete",
                "workflow_type": workflow_type,
                "success": success,
                "result_summary": result_summary,
                "timestamp": datetime.utcnow().isoformat(),
                "session_id": session_id
            }
            
            for socket_id in self.session_subscriptions[session_id]:
                try:
                    await self.sio.emit('workflow_event', workflow_data, room=socket_id)
                except Exception as e:
                    logger.error(f"Failed to stream workflow complete to client {socket_id}: {str(e)}")
                    
        except Exception as e:
            logger.error(f"Error streaming workflow complete: {str(e)}")
    
    async def stream_agent_status(self, session_id: str, agent_name: str, status: str, message: str):
        """Stream general agent status updates"""
        try:
            if session_id not in self.session_subscriptions:
                return
            
            status_data = {
                "event_type": "agent_status",
                "agent_name": agent_name,
                "status": status,
                "message": message,
                "timestamp": datetime.utcnow().isoformat(),
                "session_id": session_id
            }
            
            for socket_id in self.session_subscriptions[session_id]:
                try:
                    await self.sio.emit('agent_status', status_data, room=socket_id)
                except Exception as e:
                    logger.error(f"Failed to stream agent status to client {socket_id}: {str(e)}")
                    
        except Exception as e:
            logger.error(f"Error streaming agent status: {str(e)}")
    
    def get_connection_stats(self) -> Dict[str, Any]:
        """Get statistics about active connections"""
        total_connections = len(self.active_connections)
        total_subscriptions = sum(len(subs) for subs in self.session_subscriptions.values())
        active_sessions = len(self.session_subscriptions)
        
        return {
            "total_connections": total_connections,
            "total_subscriptions": total_subscriptions,
            "active_sessions": active_sessions,
            "session_details": {
                session_id: len(subscribers) 
                for session_id, subscribers in self.session_subscriptions.items()
            }
        }


# Global instance to be used by the orchestrator
agent_activity_streamer: Optional[AgentActivityStreamer] = None

def initialize_agent_streaming(app: Flask) -> AgentActivityStreamer:
    """Initialize the global agent activity streamer"""
    global agent_activity_streamer
    agent_activity_streamer = AgentActivityStreamer(app)
    return agent_activity_streamer

def get_agent_streamer() -> Optional[AgentActivityStreamer]:
    """Get the global agent activity streamer instance"""
    return agent_activity_streamer
