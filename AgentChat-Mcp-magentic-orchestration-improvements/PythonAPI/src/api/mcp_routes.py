"""MCP-specific API routes."""

from flask import Blueprint, jsonify, request
from typing import Dict, Any, List

from src.utils.logging import get_logger

logger = get_logger(__name__)

# Create blueprint for MCP routes
mcp_bp = Blueprint('mcp', __name__, url_prefix='/api/mcp')

# Static tool information (mirrors mcp_server.py)
AVAILABLE_TOOLS = [
    {"name": "health_check", "description": "Check the health and status of the MCP server", "category": "utility"},
    {"name": "get_timestamp", "description": "Get the current UTC timestamp", "category": "utility"},
    {"name": "generate_hash", "description": "Generate a hash for the given text", "category": "utility"},
    {"name": "add", "description": "Add two numbers", "category": "math"},
    {"name": "subtract", "description": "Subtract two numbers", "category": "math"},
    {"name": "multiply", "description": "Multiply two numbers", "category": "math"},
    {"name": "divide", "description": "Divide two numbers", "category": "math"},
    {"name": "calculate_statistics", "description": "Calculate comprehensive statistics for a list of numbers", "category": "math"},
    {"name": "format_json", "description": "Validate and format JSON data", "category": "utility"}
]

TOOL_CATEGORIES = {
    "utility": ["health_check", "get_timestamp", "generate_hash", "format_json"],
    "math": ["add", "subtract", "multiply", "divide", "calculate_statistics"]
}


@mcp_bp.route('/tools/list', methods=['GET', 'OPTIONS'])
def list_mcp_tools():
    """List all available MCP tools."""
    if request.method == 'OPTIONS':
        # Handle CORS preflight
        return '', 200
    
    try:
        category_filter = request.args.get('category')
        
        if category_filter:
            if category_filter not in TOOL_CATEGORIES:
                return jsonify({
                    "error": "Invalid category",
                    "available_categories": list(TOOL_CATEGORIES.keys())
                }), 400
            
            # Filter tools by category
            filtered_tools = [
                tool for tool in AVAILABLE_TOOLS 
                if tool["category"] == category_filter
            ]
            
            return jsonify({
                "tools": filtered_tools,
                "category": category_filter,
                "count": len(filtered_tools)
            })
        
        # Return all tools
        return jsonify({
            "tools": AVAILABLE_TOOLS,
            "categories": TOOL_CATEGORIES,
            "count": len(AVAILABLE_TOOLS)
        })
        
    except Exception as e:
        logger.error(f"Error listing MCP tools: {str(e)}")
        return jsonify({
            "error": "Failed to list tools",
            "message": str(e)
        }), 500


@mcp_bp.route('/tools/categories', methods=['GET'])
def list_tool_categories():
    """List all tool categories."""
    try:
        return jsonify({
            "categories": TOOL_CATEGORIES,
            "total_tools": len(AVAILABLE_TOOLS)
        })
        
    except Exception as e:
        logger.error(f"Error listing tool categories: {str(e)}")
        return jsonify({
            "error": "Failed to list categories",
            "message": str(e)
        }), 500


@mcp_bp.route('/status', methods=['GET'])
def mcp_status():
    """Get MCP server status."""
    try:
        return jsonify({
            "status": "active",
            "service": "MCP Server",
            "tools_available": len(AVAILABLE_TOOLS),
            "categories": list(TOOL_CATEGORIES.keys())
        })
        
    except Exception as e:
        logger.error(f"Error getting MCP status: {str(e)}")
        return jsonify({
            "error": "Failed to get status",
            "message": str(e)
        }), 500


@mcp_bp.route('/server/info', methods=['GET', 'OPTIONS'])
def get_server_info():
    """Get MCP server information that Angular expects."""
    if request.method == 'OPTIONS':
        # Handle CORS preflight
        return '', 200
    
    try:
        return jsonify({
            "name": "MCP Server",
            "version": "1.0.0",
            "protocolVersion": "2024-11-05",
            "capabilities": {
                "logging": {},
                "prompts": {
                    "listChanged": True
                },
                "resources": {
                    "subscribe": True,
                    "listChanged": True
                },
                "tools": {
                    "listChanged": True
                }
            },
            "serverInfo": {
                "name": "AgentChat MCP Server",
                "version": "1.0.0"
            }
        })
        
    except Exception as e:
        logger.error(f"Error getting server info: {str(e)}")
        return jsonify({
            "error": "Failed to get server info",
            "message": str(e)
        }), 500
