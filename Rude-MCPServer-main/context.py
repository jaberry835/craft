"""
Shared context variables for the MCP server
Used by both main.py and tools for request-scoped data
"""

from contextvars import ContextVar
import threading

# Context variables to store request data
current_user_id: ContextVar[str] = ContextVar('current_user_id', default='defaMCPUser')
current_session_id: ContextVar[str] = ContextVar('current_session_id', default=None)
current_user_token: ContextVar[str] = ContextVar('current_user_token', default=None)

# Thread-local storage as backup for FastMCP context preservation
_thread_local = threading.local()

def set_user_token(token: str):
    """Set user token in both contextvars and thread-local storage"""
    current_user_token.set(token)
    _thread_local.user_token = token

def get_user_token() -> str:
    """Get user token from contextvars or thread-local storage"""
    token = current_user_token.get(None)
    if not token and hasattr(_thread_local, 'user_token'):
        token = _thread_local.user_token
    return token

def clear_user_token():
    """Clear user token from both storages"""
    if hasattr(_thread_local, 'user_token'):
        delattr(_thread_local, 'user_token')
