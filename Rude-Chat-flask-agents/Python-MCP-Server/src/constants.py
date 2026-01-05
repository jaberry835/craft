"""
Constants for the MCP server and agents.
"""

# Standardized response when an agent cannot handle a query
AGENT_CANNOT_ANSWER = "AGENT_CANNOT_ANSWER: This agent cannot handle this type of query."

# Activity filtering patterns
NEGATIVE_RESPONSE_PATTERNS = [
    AGENT_CANNOT_ANSWER,
    "analyzing request and determining appropriate response",
    "cannot handle",
    "not able to",
    "cannot process",
    "not equipped",
    "outside my domain",
    "not my specialty",
    "i don't have",
    "unable to help",
    "not designed for"
]
