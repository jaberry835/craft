"""Flask API routes and handlers."""

from flask import Blueprint, jsonify, request
from typing import Dict, Any, List
import traceback

from src.utils.logging import get_logger

logger = get_logger(__name__)

# Create blueprint for API routes
api_bp = Blueprint('api', __name__, url_prefix='/api/v1')

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


@api_bp.route('/health', methods=['GET'])
def health_check():
    """Health check endpoint."""
    logger.info("Health check requested", extra={
        'endpoint': '/api/v1/health',
        'method': 'GET',
        'user_agent': request.headers.get('User-Agent', 'unknown'),
        'ip_address': request.remote_addr
    })
    
    response_data = {
        "status": "healthy",
        "service": "PythonAPI with Simple MCP Server",
        "mcp_tools_count": len(AVAILABLE_TOOLS)
    }
    
    logger.info("Health check completed", extra={
        'endpoint': '/api/v1/health',
        'status': 'healthy',
        'tools_count': len(AVAILABLE_TOOLS)
    })
    
    return jsonify(response_data)


@api_bp.route('/tools', methods=['GET'])
def list_tools():
    """List all available MCP tools."""
    try:
        category_filter = request.args.get('category')
        
        logger.info("Tools list requested", extra={
            'endpoint': '/api/v1/tools',
            'method': 'GET',
            'category_filter': category_filter,
            'user_agent': request.headers.get('User-Agent', 'unknown'),
            'ip_address': request.remote_addr
        })
        
        if category_filter:
            if category_filter not in TOOL_CATEGORIES:
                logger.warning("Invalid category requested", extra={
                    'requested_category': category_filter,
                    'available_categories': list(TOOL_CATEGORIES.keys())
                })
                return jsonify({
                    "error": f"Invalid category: {category_filter}",
                    "available_categories": list(TOOL_CATEGORIES.keys())
                }), 400
            
            # Filter tools by category
            tools_data = [tool for tool in AVAILABLE_TOOLS if tool["category"] == category_filter]
        else:
            tools_data = AVAILABLE_TOOLS
        
        logger.info("Tools list completed", extra={
            'endpoint': '/api/v1/tools',
            'tools_returned': len(tools_data),
            'category_filter': category_filter
        })
        
        return jsonify({
            "tools": tools_data,
            "count": len(tools_data),
            "category_filter": category_filter
        })
        
    except Exception as e:
        logger.error(f"Error listing tools: {str(e)}", extra={
            'endpoint': '/api/v1/tools',
            'error': str(e),
            'traceback': traceback.format_exc()
        })
        return jsonify({"error": "Internal server error"}), 500


@api_bp.route('/tools/categories', methods=['GET'])
def list_categories():
    """List all tool categories with counts."""
    try:
        logger.info("Tool categories requested", extra={
            'endpoint': '/api/v1/tools/categories',
            'method': 'GET',
            'user_agent': request.headers.get('User-Agent', 'unknown'),
            'ip_address': request.remote_addr
        })
        
        categories = []
        
        for category_name, tool_names in TOOL_CATEGORIES.items():
            categories.append({
                "name": category_name,
                "count": len(tool_names),
                "tools": tool_names
            })
        
        logger.info("Tool categories completed", extra={
            'endpoint': '/api/v1/tools/categories',
            'categories_returned': len(categories),
            'total_tools': len(AVAILABLE_TOOLS)
        })
        
        return jsonify({
            "categories": categories,
            "total_categories": len(categories),
            "total_tools": len(AVAILABLE_TOOLS)
        })
        
    except Exception as e:
        logger.error(f"Error listing categories: {str(e)}", extra={
            'endpoint': '/api/v1/tools/categories',
            'error': str(e),
            'traceback': traceback.format_exc()
        })
        return jsonify({"error": "Internal server error"}), 500


@api_bp.route('/tools/<tool_name>', methods=['GET'])
def get_tool_info(tool_name: str):
    """Get detailed information about a specific tool."""
    try:
        logger.info("Tool info requested", extra={
            'endpoint': f'/api/v1/tools/{tool_name}',
            'method': 'GET',
            'tool_name': tool_name,
            'user_agent': request.headers.get('User-Agent', 'unknown'),
            'ip_address': request.remote_addr
        })
        
        tool = next((t for t in AVAILABLE_TOOLS if t["name"] == tool_name), None)
        
        if not tool:
            logger.warning("Tool not found", extra={
                'requested_tool': tool_name,
                'available_tools': [t["name"] for t in AVAILABLE_TOOLS]
            })
            return jsonify({"error": f"Tool '{tool_name}' not found"}), 404
        
        logger.info("Tool info completed", extra={
            'endpoint': f'/api/v1/tools/{tool_name}',
            'tool_name': tool_name,
            'tool_category': tool["category"]
        })
        
        return jsonify({
            "name": tool["name"],
            "description": tool["description"],
            "category": tool["category"],
            "available_via": "MCP Server (mcp_server.py)"
        })
        
    except Exception as e:
        logger.error(f"Error getting tool info for {tool_name}: {str(e)}", extra={
            'endpoint': f'/api/v1/tools/{tool_name}',
            'tool_name': tool_name,
            'error': str(e),
            'traceback': traceback.format_exc()
        })
        return jsonify({"error": "Internal server error"}), 500


@api_bp.route('/tools/<tool_name>/execute', methods=['POST'])
def execute_tool(tool_name: str):
    """Execute a tool with provided parameters - Note: Only available via MCP."""
    try:
        logger.info("Tool execution attempted", extra={
            'endpoint': f'/api/v1/tools/{tool_name}/execute',
            'method': 'POST',
            'tool_name': tool_name,
            'user_agent': request.headers.get('User-Agent', 'unknown'),
            'ip_address': request.remote_addr
        })
        
        tool = next((t for t in AVAILABLE_TOOLS if t["name"] == tool_name), None)
        
        if not tool:
            logger.warning("Tool execution failed - tool not found", extra={
                'requested_tool': tool_name,
                'available_tools': [t["name"] for t in AVAILABLE_TOOLS]
            })
            return jsonify({"error": f"Tool '{tool_name}' not found"}), 404
        
        logger.info("Tool execution blocked - MCP only", extra={
            'endpoint': f'/api/v1/tools/{tool_name}/execute',
            'tool_name': tool_name,
            'reason': 'tools_only_via_mcp'
        })
        
        return jsonify({
            "error": "Tool execution not available via REST API",
            "message": "Tools can only be executed via MCP client",
            "tool": tool_name,
            "suggestion": "Use MCP client to execute tools: mcp dev mcp_server.py"
        }), 400
        
    except Exception as e:
        logger.error(f"Error in execute_tool for {tool_name}: {str(e)}", extra={
            'endpoint': f'/api/v1/tools/{tool_name}/execute',
            'tool_name': tool_name,
            'error': str(e),
            'traceback': traceback.format_exc()
        })
        return jsonify({"error": "Internal server error"}), 500


@api_bp.route('/mcp/status', methods=['GET'])
def mcp_status():
    """Get MCP server status."""
    try:
        logger.info("MCP status requested", extra={
            'endpoint': '/api/v1/mcp/status',
            'method': 'GET',
            'user_agent': request.headers.get('User-Agent', 'unknown'),
            'ip_address': request.remote_addr
        })
        
        response_data = {
            "mcp_server": {
                "name": "PythonAPI_MCP_Server",
                "type": "Simple MCP Server",
                "file": "mcp_server.py",
                "port": "3001 (default)",
                "status": "Available via mcp_server.py"
            },
            "tools": {
                "total": len(AVAILABLE_TOOLS),
                "by_category": {cat: len(tools) for cat, tools in TOOL_CATEGORIES.items()}
            }
        }
        
        logger.info("MCP status completed", extra={
            'endpoint': '/api/v1/mcp/status',
            'total_tools': len(AVAILABLE_TOOLS),
            'categories': list(TOOL_CATEGORIES.keys())
        })
        
        return jsonify(response_data)
        
    except Exception as e:
        logger.error(f"Error getting MCP status: {str(e)}", extra={
            'endpoint': '/api/v1/mcp/status',
            'error': str(e),
            'traceback': traceback.format_exc()
        })
        return jsonify({"error": "Internal server error"}), 500


@api_bp.errorhandler(404)
def not_found(error):
    """Handle 404 errors."""
    logger.warning("404 error occurred", extra={
        'url': request.url,
        'method': request.method,
        'user_agent': request.headers.get('User-Agent', 'unknown'),
        'ip_address': request.remote_addr,
        'error': 'endpoint_not_found'
    })
    return jsonify({"error": "Endpoint not found"}), 404


@api_bp.errorhandler(500)
def internal_error(error):
    """Handle 500 errors."""
    logger.error(f"Internal server error: {str(error)}", extra={
        'url': request.url,
        'method': request.method,
        'user_agent': request.headers.get('User-Agent', 'unknown'),
        'ip_address': request.remote_addr,
        'error': str(error),
        'error_type': 'internal_server_error'
    })
    return jsonify({"error": "Internal server error"}), 500
