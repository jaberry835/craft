"""Chat service for conversational image search."""

import re
import structlog
from openai import AzureOpenAI

from ..config import Settings, get_openai_token_provider
from ..models import (
    ChatRequest, ChatResponse, ChatImageReference, ChatMessage,
    SearchRequest
)
from .search_service import SearchService
from .person_service import PersonService, get_person_service

logger = structlog.get_logger()

SYSTEM_PROMPT = """You are Azure Snap Seek, an intelligent image search assistant. Your role is to help users find and discover images in their collection.

When users ask about images, you should:
1. Understand their intent and what they're looking for
2. Search for relevant images using the search capabilities
3. Describe the images found and explain why they match
4. Provide helpful suggestions for refining searches

**Person Search Capabilities:**
- Users can search for images containing specific people by name (e.g., "show me photos of John Smith")
- Users can search by person ID (e.g., "find images with person ID abc123")
- If a person name is mentioned, search for images of that person
- You can list known persons and their image counts

When describing search results:
- Be concise but informative
- Mention key visual elements (objects, colors, text, people)
- Explain why each image matches the query
- If searching by person, mention the person's name and how many images were found
- Suggest related searches if appropriate

If no relevant images are found, suggest alternative search terms or broader categories.

Always be helpful, friendly, and focused on helping users discover images in their collection."""


class ChatService:
    """Service for conversational image search using Azure OpenAI."""
    
    def __init__(self, settings: Settings, search_service: SearchService):
        """Initialize the chat service."""
        self.settings = settings
        self.search_service = search_service
        self.person_service = get_person_service(settings)
        
        # Try identity-based auth first, fall back to API key
        token_provider = get_openai_token_provider()
        if token_provider:
            logger.info("Using DefaultAzureCredential for Azure OpenAI (chat)")
            self.client = AzureOpenAI(
                azure_endpoint=settings.azure_openai_endpoint,
                azure_ad_token_provider=token_provider,
                api_version=settings.azure_openai_api_version
            )
        elif settings.azure_openai_key:
            logger.info("Using API key for Azure OpenAI (chat)")
            self.client = AzureOpenAI(
                azure_endpoint=settings.azure_openai_endpoint,
                api_key=settings.azure_openai_key,
                api_version=settings.azure_openai_api_version
            )
        else:
            raise ValueError("No valid credential available for Azure OpenAI")
        
        self.logger = logger.bind(component="chat_service")
    
    async def _detect_person_query(self, message: str) -> tuple[str | None, str | None]:
        """
        Detect if the message is asking about a specific person.
        
        Returns:
            Tuple of (person_id, person_name) - one or both may be set
        """
        message_lower = message.lower()
        
        # Check for person ID patterns
        # Pattern: "person id abc123" or "person_id: abc123" or just a UUID-like pattern
        id_patterns = [
            r'person[_\s]?id[:\s]+([a-f0-9-]{8,36})',
            r'\b([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\b',  # Full UUID
        ]
        
        for pattern in id_patterns:
            match = re.search(pattern, message_lower)
            if match:
                return (match.group(1), None)
        
        # Check for name-based queries
        name_patterns = [
            r"(?:show|find|search|get|display|photos?|images?|pictures?)\s+(?:me\s+)?(?:of|with|for|containing)?\s*['\"]?([a-z\s]+?)['\"]?\s*(?:photos?|images?|pictures?)?$",
            r"(?:photos?|images?|pictures?)\s+(?:of|with|for)\s+['\"]?([a-z\s]+)['\"]?",
            r"who\s+is\s+['\"]?([a-z\s]+)['\"]?",
        ]
        
        for pattern in name_patterns:
            match = re.search(pattern, message_lower)
            if match:
                potential_name = match.group(1).strip()
                # Filter out common non-name words
                skip_words = {'the', 'a', 'an', 'this', 'that', 'my', 'all', 'some', 'any'}
                if potential_name and potential_name not in skip_words:
                    return (None, potential_name)
        
        return (None, None)
    
    async def _find_person_by_name(self, name: str) -> str | None:
        """Find a person ID by name (partial match)."""
        persons = await self.person_service.list_persons()
        name_lower = name.lower()
        
        for person in persons:
            person_name = person.get("name", "")
            if person_name and name_lower in person_name.lower():
                return person.get("person_id")
        
        return None
    
    def _extract_search_query(self, user_message: str, assistant_response: str) -> str | None:
        """Extract a search query from the conversation."""
        # Simple extraction - use the user message as the search query
        # In a more advanced implementation, this could use another LLM call
        # to extract specific search terms
        return user_message
    
    async def chat(self, request: ChatRequest) -> ChatResponse:
        """
        Process a chat message and optionally search for images.
        
        Args:
            request: Chat request with message and history
            
        Returns:
            ChatResponse with message and optional images
        """
        self.logger.info("Processing chat message", message=request.message[:100])
        
        # Build messages for the chat
        messages = [
            {"role": "system", "content": SYSTEM_PROMPT}
        ]
        
        # Add history
        for msg in request.history:
            messages.append({"role": msg.role, "content": msg.content})
        
        # Add current message
        messages.append({"role": "user", "content": request.message})
        
        # If including images, first search for relevant ones
        images = []
        search_query = None
        person_context = None
        
        if request.include_images:
            search_query = request.message
            
            # Check if this is a person-related query
            person_id, person_name = await self._detect_person_query(request.message)
            
            # If we found a name but not ID, try to look up the person
            if person_name and not person_id:
                person_id = await self._find_person_by_name(person_name)
                if person_id:
                    person_context = f"Found person '{person_name}' (ID: {person_id[:8]}...)"
                else:
                    person_context = f"No person named '{person_name}' found in the collection."
            
            # Build search request
            search_request = SearchRequest(
                query=search_query,
                top=5,
                use_vector_search=True,
                use_semantic_search=self.settings.enable_semantic_search,
                person_ids=[person_id] if person_id else None
            )
            
            search_results = await self.search_service.search(search_request)
            
            # Add search context to the prompt
            if search_results.results:
                image_context = "\n\nRelevant images found:\n"
                for i, img in enumerate(search_results.results, 1):
                    image_context += f"{i}. {img.filename}"
                    if img.caption:
                        image_context += f" - {img.caption}"
                    if img.tags:
                        image_context += f" (tags: {', '.join(img.tags[:5])})"
                    image_context += "\n"
                
                context_msg = f"Search results for '{search_query}':"
                if person_context:
                    context_msg += f"\n{person_context}"
                context_msg += f"{image_context}\nDescribe these results to the user."
                
                messages.append({
                    "role": "system",
                    "content": context_msg
                })
                
                # Build image references
                relevance = f"Matched search for: {search_query}"
                if person_id:
                    relevance = f"Shows person {person_name or person_id[:8]}"
                    
                for img in search_results.results:
                    images.append(ChatImageReference(
                        id=img.id,
                        filename=img.filename,
                        file_url=img.file_url,
                        caption=img.caption,
                        relevance_reason=relevance
                    ))
            else:
                no_results_msg = f"No images found matching '{search_query}'."
                if person_context:
                    no_results_msg += f" {person_context}"
                no_results_msg += " Help the user refine their search."
                
                messages.append({
                    "role": "system",
                    "content": no_results_msg
                })
        
        # Generate response
        try:
            response = self.client.chat.completions.create(
                model=self.settings.azure_openai_chat_deployment,
                messages=messages,
                max_tokens=500,
                temperature=0.7
            )
            
            assistant_message = response.choices[0].message.content
            
            self.logger.info(
                "Chat response generated",
                images_found=len(images),
                response_length=len(assistant_message)
            )
            
            return ChatResponse(
                message=assistant_message,
                images=images,
                search_query=search_query
            )
            
        except Exception as e:
            self.logger.error("Chat generation failed", error=str(e))
            raise
