"""
tools/__init__.py – Tool Registration Hub
==========================================
This is the single place where all tool modules are wired into the MCP server.
server.py calls register_tools(mcp) once at startup – nothing else changes there.

HOW TO ADD A NEW TOOL MODULE
-----------------------------
1. Create a new file in this directory, e.g.:
       tools/my_feature.py

2. Inside that file, define your tools and expose a register function:
       def register_my_feature_tools(mcp: FastMCP) -> None:
           @mcp.tool()
           def my_tool(...) -> ...: ...

3. Import and call it here:
       from tools.my_feature import register_my_feature_tools
       ...
       def register_tools(mcp: FastMCP) -> None:
           register_example_tools(mcp)
           register_my_feature_tools(mcp)   # <-- add this line

See tools/example.py for detailed patterns and best practices.
"""

from mcp.server.fastmcp import FastMCP

from tools.echo_api import register_echo_api_tools
from tools.example import register_example_tools
from tools.secure_api import register_secure_api_tools


def register_tools(mcp: FastMCP) -> None:
    """Register every tool module with the MCP server."""

    register_example_tools(mcp)
    register_echo_api_tools(mcp)
    register_secure_api_tools(mcp)

    # ------------------------------------------------------------------
    # TODO: Add more tool registrations below as you build new modules.
    # ------------------------------------------------------------------
    # from tools.my_feature import register_my_feature_tools
    # register_my_feature_tools(mcp)
