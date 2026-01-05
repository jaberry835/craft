"""
Tools package for Rude MCP Server
Contains modular tool implementations for different domains
"""

from .math_tools import register_math_tools
from .adx_tools import register_adx_tools
from .fictional_api_tools import register_fictional_api_tools
from .document_tools import register_document_tools
from .rag_tools import register_rag_tools

__all__ = ['register_math_tools', 'register_adx_tools', 'register_fictional_api_tools', 'register_document_tools', 'register_rag_tools']
