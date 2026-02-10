"""Chat API endpoints."""

from fastapi import APIRouter, Depends, HTTPException

from ..config import Settings, get_settings
from ..models import ChatRequest, ChatResponse
from ..services import SearchService, ChatService
from .search import get_search_service

router = APIRouter(prefix="/api", tags=["chat"])

# Cached singleton instance
_chat_service: ChatService | None = None


def get_chat_service(settings: Settings = Depends(get_settings)) -> ChatService:
    """Dependency to get cached chat service singleton."""
    global _chat_service
    if _chat_service is None:
        search_service = get_search_service(settings)
        _chat_service = ChatService(settings, search_service)
    return _chat_service


@router.post("/chat", response_model=ChatResponse)
async def chat(
    request: ChatRequest,
    service: ChatService = Depends(get_chat_service)
) -> ChatResponse:
    """
    Chat with the image search assistant.
    
    - **message**: User message
    - **history**: Previous conversation history
    - **include_images**: Include relevant images in response (default: true)
    
    The assistant will search for relevant images and provide helpful responses
    about your image collection.
    """
    settings = get_settings()
    
    if not settings.enable_chat:
        raise HTTPException(status_code=503, detail="Chat feature is disabled")
    
    try:
        return await service.chat(request)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Chat failed: {str(e)}")
