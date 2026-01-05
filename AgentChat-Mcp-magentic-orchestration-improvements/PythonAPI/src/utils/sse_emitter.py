"""Server-Sent Events (SSE) emitter utility for agent activity streaming."""

import json
import uuid
import threading
import time
from datetime import datetime, timezone
from typing import Dict, Any, Optional, List
from queue import Queue, Empty
from src.utils.logging import get_logger

logger = get_logger(__name__)


class SSEEmitter:
    """Utility class for managing Server-Sent Events streams."""
    
    _instance = None
    _lock = threading.Lock()
    
    def __new__(cls):
        """Ensure only one instance exists (singleton pattern)."""
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = super().__new__(cls)
                    cls._instance._initialized = False
        return cls._instance
    
    def __init__(self):
        # Only initialize once
        if hasattr(self, '_initialized') and self._initialized:
            return
            
        self._sessions: Dict[str, Queue] = {}
        self._session_lock = threading.Lock()
        self._session_last_activity: Dict[str, datetime] = {}  # Track last activity per session
        # Debug tracking
        self._emission_stats = {
            'total_emissions': 0,
            'successful_queues': 0,
            'failed_queues': 0,
            'last_emission': None
        }
        self._initialized = True
        logger.info(f"🔧 SSE Emitter singleton initialized - Instance ID: {id(self)}")
        
    def add_session(self, session_id: str) -> Queue:
        """Add a new SSE session and return its queue."""
        with self._session_lock:
            if session_id not in self._sessions:
                self._sessions[session_id] = Queue()
                self._session_last_activity[session_id] = datetime.now(timezone.utc)
                logger.info(f"📡 Added SSE session: {session_id} (Total sessions: {len(self._sessions)})")
            else:
                # Update last activity time
                self._session_last_activity[session_id] = datetime.now(timezone.utc)
                logger.info(f"📡 Reusing existing SSE session: {session_id}")
            return self._sessions[session_id]
    
    def remove_session(self, session_id: str):
        """Remove an SSE session."""
        with self._session_lock:
            if session_id in self._sessions:
                del self._sessions[session_id]
                if session_id in self._session_last_activity:
                    del self._session_last_activity[session_id]
                logger.info(f"📡 Removed SSE session: {session_id} (Remaining sessions: {len(self._sessions)})")
            else:
                logger.warning(f"⚠️ Attempted to remove non-existent SSE session: {session_id}")
                logger.info(f"📡 Current active sessions: {list(self._sessions.keys())}")
    
    def emit_agent_activity(
        self,
        session_id: str,
        agent_name: str,
        action: str,
        status: str,
        details: Optional[str] = None,
        duration: Optional[float] = None
    ):
        """Emit agent activity event to a specific session."""
        try:
            logger.info(f"🎯 emit_agent_activity called - Session: {session_id}, Agent: {agent_name}, Action: {action}")
            
            activity_data = {
                "id": str(uuid.uuid4()),
                "agentName": agent_name,
                "action": action,
                "status": status,
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "details": details,
                "duration": duration
            }
            
            logger.info(f"📊 Emitting agent activity to session {session_id}: {agent_name} - {action} ({status})")
            
            # Check if session exists before emitting
            with self._session_lock:
                if session_id not in self._sessions:
                    logger.warning(f"⚠️ No SSE session found for {session_id}, activity will be lost: {agent_name} - {action}")
                    return
                else:
                    logger.info(f"✅ Session {session_id} exists in SSE emitter, proceeding with emission")
                    
            self._emit_to_session(session_id, 'agentActivity', activity_data)
            logger.info(f"🏁 emit_agent_activity completed for session {session_id}")
            
        except Exception as e:
            logger.error(f"Error emitting agent activity: {str(e)}")
    
    def emit_agent_status_update(
        self,
        session_id: str,
        agent_id: str,
        agent_name: str,
        status: str,
        current_activity: Optional[str] = None
    ):
        """Emit agent status update event."""
        try:
            status_data = {
                "agentId": agent_id,
                "name": agent_name,
                "status": status,
                "currentActivity": current_activity,
                "lastActivity": datetime.now(timezone.utc).isoformat()
            }
            
            logger.info(f"📊 Emitting agent status update to session {session_id}: {agent_name} - {status}")
            
            self._emit_to_session(session_id, 'agentStatusUpdate', status_data)
            
        except Exception as e:
            logger.error(f"Error emitting agent status update: {str(e)}")
    
    def emit_error(self, session_id: str, message: str, details: Optional[str] = None):
        """Emit error event to a specific session."""
        try:
            error_data = {
                "message": message,
                "details": details,
                "timestamp": datetime.now(timezone.utc).isoformat()
            }
            
            logger.error(f"📊 Emitting error to session {session_id}: {message}")
            
            self._emit_to_session(session_id, 'error', error_data)
            
        except Exception as e:
            logger.error(f"Error emitting error event: {str(e)}")
    
    def emit_research_summary(
        self,
        session_id: str,
        round_num: int,
        max_rounds: int,
        summary: str
    ):
        """Emit research progress summary."""
        try:
            summary_data = {
                "id": str(uuid.uuid4()),
                "roundNum": round_num,
                "maxRounds": max_rounds,
                "summary": summary,
                "timestamp": datetime.now(timezone.utc).isoformat()
            }
            
            logger.info(f"📊 Emitting research summary for session {session_id} (round {round_num}/{max_rounds})")
            
            self._emit_to_session(session_id, 'researchSummary', summary_data)
            
        except Exception as e:
            logger.error(f"Error emitting research summary: {str(e)}")
    
    def _emit_to_session(self, session_id: str, event_type: str, data: Dict[str, Any]):
        """Emit data to a specific session."""
        logger.info(f"🎯 _emit_to_session called - Session: {session_id}, Event: {event_type}")
        
        self._emission_stats['total_emissions'] += 1
        self._emission_stats['last_emission'] = {
            'session_id': session_id,
            'event_type': event_type,
            'timestamp': datetime.now(timezone.utc).isoformat()
        }
        
        with self._session_lock:
            # Update last activity for this session
            self._session_last_activity[session_id] = datetime.now(timezone.utc)
            
            if session_id in self._sessions:
                queue = self._sessions[session_id]
                logger.info(f"✅ Session {session_id} found, queue size before: {queue.qsize()}")
                try:
                    # Create SSE formatted message
                    sse_message = {
                        'event': event_type,
                        'data': data,
                        'timestamp': datetime.now(timezone.utc).isoformat()
                    }
                    logger.info(f"🔄 Attempting to queue message: {sse_message}")
                    queue.put(sse_message, timeout=1)
                    self._emission_stats['successful_queues'] += 1
                    logger.info(f"📤 Queued {event_type} message to session {session_id} - Queue size now: {queue.qsize()}")
                except Exception as e:
                    self._emission_stats['failed_queues'] += 1
                    logger.error(f"Error queuing message to session {session_id}: {str(e)}")
            else:
                # If session doesn't exist but activity is recent, recreate it
                now = datetime.now(timezone.utc)
                if session_id in self._session_last_activity:
                    last_activity = self._session_last_activity[session_id]
                    time_since_activity = (now - last_activity).total_seconds()
                    if time_since_activity < 300:  # 5 minutes
                        logger.warning(f"⚠️ Session {session_id} missing but recent activity detected. Recreating session...")
                        self._sessions[session_id] = Queue()
                        # Retry emitting
                        try:
                            sse_message = {
                                'event': event_type,
                                'data': data,
                                'timestamp': datetime.now(timezone.utc).isoformat()
                            }
                            self._sessions[session_id].put(sse_message, timeout=1)
                            logger.info(f"✅ Successfully recreated and emitted to session {session_id}")
                        except Exception as e:
                            logger.error(f"Error emitting to recreated session {session_id}: {str(e)}")
                        return
                
                logger.warning(f"⚠️ Session {session_id} not found in active sessions. Current sessions: {list(self._sessions.keys())}")
                if session_id in self._session_last_activity:
                    last_activity = self._session_last_activity[session_id]
                    time_since_activity = (datetime.now(timezone.utc) - last_activity).total_seconds()
                    logger.info(f"📊 Last activity for session {session_id}: {time_since_activity:.1f}s ago")
    
    def get_session_stream(self, session_id: str):
        """Get SSE stream generator for a session."""
        queue = self.add_session(session_id)
        
        def generate():
            try:
                # Send initial connection message immediately
                initial_data = {
                    'message': 'SSE connection established',
                    'session_id': session_id,
                    'timestamp': datetime.now(timezone.utc).isoformat()
                }
                yield f"event: connected\ndata: {json.dumps(initial_data)}\n\n"
                
                # Main loop with shorter timeouts for Azure threading
                while True:
                    try:
                        # Shorter timeout works better with threaded workers
                        message = queue.get(timeout=15)  # 15s timeout for threaded workers
                        
                        # Format as SSE
                        sse_data = f"event: {message['event']}\n"
                        sse_data += f"data: {json.dumps(message['data'])}\n\n"
                        
                        yield sse_data
                        
                    except Empty:
                        # Send heartbeat every 15 seconds to keep connection alive
                        heartbeat_data = {'timestamp': datetime.now(timezone.utc).isoformat()}
                        yield f"event: heartbeat\ndata: {json.dumps(heartbeat_data)}\n\n"
                        
            except GeneratorExit:
                # Check if session was recently active before removing
                with self._session_lock:
                    if session_id in self._session_last_activity:
                        last_activity = self._session_last_activity[session_id]
                        time_since_activity = (datetime.now(timezone.utc) - last_activity).total_seconds()
                        if time_since_activity < 60:  # Less than 1 minute ago
                            logger.warning(f"📡 SSE stream ended for session: {session_id} but recent activity detected ({time_since_activity:.1f}s ago). Keeping session alive.")
                            return  # Don't remove the session
                
                logger.info(f"📡 SSE stream ended for session: {session_id} (GeneratorExit - client disconnected)")
                self.remove_session(session_id)
            except Exception as e:
                logger.error(f"❌ Error in SSE stream for session {session_id}: {str(e)}")
                
                # Check if session was recently active before removing
                with self._session_lock:
                    if session_id in self._session_last_activity:
                        last_activity = self._session_last_activity[session_id]
                        time_since_activity = (datetime.now(timezone.utc) - last_activity).total_seconds()
                        if time_since_activity < 60:  # Less than 1 minute ago
                            logger.warning(f"📡 SSE error for session: {session_id} but recent activity detected ({time_since_activity:.1f}s ago). Keeping session alive.")
                            return  # Don't remove the session
                
                self.remove_session(session_id)
                # Send error message before closing
                try:
                    error_message = json.dumps({
                        'event': 'error',
                        'data': {'message': 'SSE stream error', 'details': str(e)}
                    })
                    yield f"event: error\ndata: {error_message}\n\n"
                except:
                    pass
        
        return generate()

    def cleanup_stale_sessions(self, max_age_minutes: int = 30):
        """Remove sessions that have been inactive for too long."""
        now = datetime.now(timezone.utc)
        stale_sessions = []
        
        with self._session_lock:
            for session_id, last_activity in self._session_last_activity.items():
                age_minutes = (now - last_activity).total_seconds() / 60
                if age_minutes > max_age_minutes:
                    stale_sessions.append(session_id)
        
        for session_id in stale_sessions:
            logger.info(f"🧹 Cleaning up stale SSE session: {session_id}")
            self.remove_session(session_id)


# Global SSE emitter instance
sse_emitter = SSEEmitter()
