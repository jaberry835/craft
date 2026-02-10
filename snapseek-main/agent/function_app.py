"""
SnapSeek Agent - Azure Functions HTTP endpoint for image search agent.

This function provides a conversational AI interface for searching and 
discovering images using the SnapSeek image search capabilities.
"""

import json
import logging
import azure.functions as func
from openai import AzureOpenAI

from shared.config import get_settings
from shared.tools import ImageSearchTools, TOOL_DEFINITIONS

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Initialize settings and tools
settings = get_settings()
search_tools = ImageSearchTools(settings)
openai_client = AzureOpenAI(
    azure_endpoint=settings.azure_openai_endpoint,
    api_key=settings.azure_openai_key,
    api_version=settings.azure_openai_api_version
)

SYSTEM_PROMPT = """You are Azure Snap Seek, an intelligent image search assistant. You help users find and discover images in their collection.

You have access to the following tools:
1. search_images - Search for images using natural language queries
2. get_image_details - Get detailed information about a specific image
3. find_similar_images - Find images similar to a given image
4. get_collection_stats - Get statistics about the image collection

When helping users:
- Use search_images for general queries about finding images
- Use get_image_details when users want more information about a specific image
- Use find_similar_images when users want to find related images
- Use get_collection_stats when users ask about their collection overview

Always provide helpful, concise responses and suggest follow-up actions when appropriate."""


def execute_tool(tool_name: str, arguments: dict) -> str:
    """Execute a tool and return the result as a string."""
    logger.info(f"Executing tool: {tool_name} with args: {arguments}")
    
    if tool_name == "search_images":
        result = search_tools.search_images(**arguments)
    elif tool_name == "get_image_details":
        result = search_tools.get_image_details(**arguments)
    elif tool_name == "find_similar_images":
        result = search_tools.find_similar_images(**arguments)
    elif tool_name == "get_collection_stats":
        result = search_tools.get_collection_stats()
    else:
        result = {"error": f"Unknown tool: {tool_name}"}
    
    return json.dumps(result, default=str)


def process_message(user_message: str, conversation_history: list = None) -> dict:
    """
    Process a user message and return the agent's response.
    
    Args:
        user_message: The user's message
        conversation_history: Previous messages in the conversation
        
    Returns:
        Dictionary with the agent's response
    """
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    
    # Add conversation history
    if conversation_history:
        messages.extend(conversation_history)
    
    # Add user message
    messages.append({"role": "user", "content": user_message})
    
    # Initial API call
    response = openai_client.chat.completions.create(
        model=settings.azure_openai_chat_deployment,
        messages=messages,
        tools=TOOL_DEFINITIONS,
        tool_choice="auto",
        max_tokens=1000
    )
    
    assistant_message = response.choices[0].message
    
    # Handle tool calls
    while assistant_message.tool_calls:
        # Add assistant message with tool calls
        messages.append(assistant_message)
        
        # Execute each tool call
        for tool_call in assistant_message.tool_calls:
            tool_name = tool_call.function.name
            arguments = json.loads(tool_call.function.arguments)
            
            tool_result = execute_tool(tool_name, arguments)
            
            # Add tool result
            messages.append({
                "role": "tool",
                "tool_call_id": tool_call.id,
                "content": tool_result
            })
        
        # Get next response
        response = openai_client.chat.completions.create(
            model=settings.azure_openai_chat_deployment,
            messages=messages,
            tools=TOOL_DEFINITIONS,
            tool_choice="auto",
            max_tokens=1000
        )
        
        assistant_message = response.choices[0].message
    
    return {
        "message": assistant_message.content,
        "conversation_history": messages[1:]  # Exclude system prompt
    }


# Azure Functions entry point
app = func.FunctionApp(http_auth_level=func.AuthLevel.FUNCTION)


@app.route(route="chat", methods=["POST"])
def chat(req: func.HttpRequest) -> func.HttpResponse:
    """
    HTTP endpoint for the SnapSeek chat agent.
    
    Request body:
    {
        "message": "User message",
        "history": [optional conversation history]
    }
    
    Response:
    {
        "message": "Agent response",
        "history": [updated conversation history]
    }
    """
    logger.info("Received chat request")
    
    try:
        req_body = req.get_json()
        user_message = req_body.get("message")
        history = req_body.get("history", [])
        
        if not user_message:
            return func.HttpResponse(
                json.dumps({"error": "Message is required"}),
                status_code=400,
                mimetype="application/json"
            )
        
        result = process_message(user_message, history)
        
        return func.HttpResponse(
            json.dumps(result),
            status_code=200,
            mimetype="application/json"
        )
        
    except Exception as e:
        logger.error(f"Error processing request: {str(e)}")
        return func.HttpResponse(
            json.dumps({"error": str(e)}),
            status_code=500,
            mimetype="application/json"
        )


@app.route(route="search", methods=["POST"])
def search(req: func.HttpRequest) -> func.HttpResponse:
    """
    Direct search endpoint without conversation context.
    
    Request body:
    {
        "query": "Search query",
        "top": 10,
        "tags": ["optional", "tags"],
        "objects": ["optional", "objects"],
        "has_text": true/false,
        "has_faces": true/false
    }
    """
    logger.info("Received search request")
    
    try:
        req_body = req.get_json()
        query = req_body.get("query")
        
        if not query:
            return func.HttpResponse(
                json.dumps({"error": "Query is required"}),
                status_code=400,
                mimetype="application/json"
            )
        
        result = search_tools.search_images(
            query=query,
            top=req_body.get("top", 10),
            tags=req_body.get("tags"),
            objects=req_body.get("objects"),
            has_text=req_body.get("has_text"),
            has_faces=req_body.get("has_faces")
        )
        
        return func.HttpResponse(
            json.dumps(result, default=str),
            status_code=200,
            mimetype="application/json"
        )
        
    except Exception as e:
        logger.error(f"Error processing search: {str(e)}")
        return func.HttpResponse(
            json.dumps({"error": str(e)}),
            status_code=500,
            mimetype="application/json"
        )


@app.route(route="image/{image_id}", methods=["GET"])
def get_image(req: func.HttpRequest) -> func.HttpResponse:
    """Get image details by ID."""
    image_id = req.route_params.get("image_id")
    
    if not image_id:
        return func.HttpResponse(
            json.dumps({"error": "Image ID is required"}),
            status_code=400,
            mimetype="application/json"
        )
    
    result = search_tools.get_image_details(image_id)
    
    if result is None:
        return func.HttpResponse(
            json.dumps({"error": "Image not found"}),
            status_code=404,
            mimetype="application/json"
        )
    
    return func.HttpResponse(
        json.dumps(result, default=str),
        status_code=200,
        mimetype="application/json"
    )


@app.route(route="stats", methods=["GET"])
def stats(req: func.HttpRequest) -> func.HttpResponse:
    """Get collection statistics."""
    result = search_tools.get_collection_stats()
    
    return func.HttpResponse(
        json.dumps(result, default=str),
        status_code=200,
        mimetype="application/json"
    )
