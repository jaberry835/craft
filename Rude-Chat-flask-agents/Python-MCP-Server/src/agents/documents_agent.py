"""
Documents agent for document management operations.
Handles document upload, processing, search, and retrieval.
"""

import logging
from typing import List, Dict, Any, Optional

from .base_agent import BaseAgent
try:
    from ..models.mcp_models import McpTool, McpToolCallRequest, McpToolCallResponse, McpProperty, McpToolInputSchema
except ImportError:
    # Fallback for when running directly
    import sys
    import os
    sys.path.append(os.path.dirname(os.path.dirname(__file__)))
    from models.mcp_models import McpTool, McpToolCallRequest, McpToolCallResponse, McpProperty, McpToolInputSchema

logger = logging.getLogger(__name__)

class DocumentsAgent(BaseAgent):
    """Specialized agent for document management operations"""
    
    def __init__(self, config: Dict[str, Any]):
        super().__init__(config)
        self.document_service = None
        
    @property
    def agent_id(self) -> str:
        return "documents-agent"
    
    @property
    def name(self) -> str:
        return "Documents Agent"
    
    @property
    def description(self) -> str:
        return "Specialized agent for document management including upload, processing, search, and retrieval"
    
    @property
    def domains(self) -> List[str]:
        return ["documents", "files", "upload", "search", "rag", "content"]
    
    async def _on_initialize_async(self, user_token: Optional[str]) -> None:
        """Initialize the Documents Agent"""
        logger.info("🔧 Initializing Documents Agent")
        try:
            # Import AzureDocumentService
            from ..services.azure_document_service import AzureDocumentService
            
            # Get cosmos sessions container if available
            cosmos_container = getattr(self, '_cosmos_sessions_container', None)
            logger.info(f"🗄️ Cosmos container available: {cosmos_container is not None}")
            
            # Initialize Azure Document Service
            self.document_service = AzureDocumentService(self._config, cosmos_container)
            logger.info("✅ Documents Agent initialized with AzureDocumentService")
            
            # Test document service initialization
            if self.document_service:
                logger.info("✅ Document service is available and ready")
            else:
                logger.error("❌ Document service failed to initialize")
                
        except Exception as e:
            logger.error(f"❌ Failed to initialize Documents Agent: {e}", exc_info=True)
            self.document_service = None
        # TODO: Initialize Azure Document Intelligence and Search services
    
    async def get_available_tools_async(self) -> List[McpTool]:
        """Get all tools that this agent can execute"""
        try:
            tools = [
                McpTool(
                    name="search_documents",
                    description="Search through uploaded documents using AI search capabilities",
                    input_schema=McpToolInputSchema(
                        type="object",
                        properties={
                            "query": McpProperty(
                                type="string",
                                description="The search query to find relevant documents"
                            ),
                            "maxResults": McpProperty(
                                type="integer",
                                description="Maximum number of results to return (default: 5)"
                            )
                        },
                        required=["query"]
                    )
                ),
                McpTool(
                    name="list_user_documents",
                    description="List all documents uploaded by the current user",
                    input_schema=McpToolInputSchema(
                        type="object",
                        properties={},
                        required=[]
                    )
                ),
                McpTool(
                    name="get_document_content",
                    description="Get the full extracted text content of a specific document by its ID",
                    input_schema=McpToolInputSchema(
                        type="object",
                        properties={
                            "documentId": McpProperty(
                                type="string",
                                description="The ID of the document to retrieve content for"
                            )
                        },
                        required=["documentId"]
                    )
                )
            ]
            
            logger.debug(f"Documents Agent providing {len(tools)} tools")
            return tools
        except Exception as e:
            logger.error(f"Failed to get Documents tools: {str(e)}")
            return []
    
    async def execute_tool_async(self, request: McpToolCallRequest) -> McpToolCallResponse:
        """Execute a tool request"""
        logger.info(f"Documents Agent executing tool: {request.name}")
        
        try:
            if request.name == "search_documents":
                return await self._execute_search_documents(request.arguments)
            elif request.name == "list_user_documents":
                return await self._execute_list_user_documents(request.arguments)
            elif request.name == "get_document_content":
                return await self._execute_get_document_content(request.arguments)
            else:
                return self._create_cannot_answer_response(f"Unknown documents tool: {request.name}")
        except Exception as e:
            return self._create_error_response(f"Documents Agent failed to execute tool {request.name}", e)
    
    async def can_handle_tool_async(self, tool_name: str) -> bool:
        """Check if this agent can handle the specified tool"""
        document_tools = ["search_documents", "list_user_documents", "get_document_content"]
        return tool_name in document_tools
    
    async def _perform_health_check_async(self) -> bool:
        """Perform Documents Agent health check"""
        try:
            # Check if Azure Search and Document Intelligence are configured
            search_endpoint = self._config.get("Azure", {}).get("Search", {}).get("Endpoint")
            doc_intel_endpoint = self._config.get("Azure", {}).get("DocumentIntelligence", {}).get("Endpoint")
            
            if not search_endpoint or not doc_intel_endpoint:
                logger.warning("Documents Agent: Azure Search or Document Intelligence not configured")
                return False
                
            # Simple health check - verify we can get tools
            tools = await self.get_available_tools_async()
            return len(tools) > 0
        except Exception as e:
            logger.warning(f"Documents Agent health check failed: {str(e)}")
            return False
    
    async def _execute_search_documents(self, arguments: Dict[str, Any]) -> McpToolCallResponse:
        """Execute the search_documents tool"""
        # Extract userId and sessionId BEFORE handling nested kwargs from Semantic Kernel
        user_id = arguments.get("userId", "") or arguments.get("user_id", "")
        session_id = arguments.get("sessionId", "") or arguments.get("session_id", "")
        
        # Handle nested kwargs from Semantic Kernel
        if "kwargs" in arguments:
            kwargs_data = arguments["kwargs"]
            # If userId/sessionId are not found at top level, check inside kwargs
            if not user_id:
                user_id = kwargs_data.get("userId", "") or kwargs_data.get("user_id", "")
            if not session_id:
                session_id = kwargs_data.get("sessionId", "") or kwargs_data.get("session_id", "")
            arguments = kwargs_data
        
        query = arguments.get("query", "")
        max_results = arguments.get("maxResults", 5) or arguments.get("max_results", 5)
        
        logger.info(f"🔍 Executing search_documents: query='{query}', user_id='{user_id}', max_results={max_results}")
        
        if not query:
            return self._create_error_response("No search query provided")
        
        if not user_id:
            return self._create_error_response("No user ID provided")
        
        try:
            if not self.document_service:
                logger.error("❌ Document service not available during search")
                return self._create_error_response("Document service not available")
            
            logger.info("📋 Document service is available, performing search...")
            
            # Perform search using AzureDocumentService
            results = await self.document_service.search_documents_async(
                query=query,
                user_id=user_id,
                session_id=session_id,
                max_results=max_results
            )
            
            logger.info(f"🔍 Search completed, found {len(results) if results else 0} results")
            
            if not results:
                return McpToolCallResponse.success(f"No documents found matching '{query}'")
            
            # Format results
            message = f"Found {len(results)} documents matching '{query}':\n\n"
            for i, chunk in enumerate(results, 1):
                message += f"**{i}. {chunk.file_name}** (Chunk {chunk.chunk_index})\n"
                message += f"Content: {chunk.content[:200]}...\n\n"
            
            logger.info(f"✅ Search results formatted successfully")
            return McpToolCallResponse.success(message)
        
        except Exception as e:
            logger.error(f"❌ Error searching documents: {e}", exc_info=True)
            return self._create_error_response(f"Document search failed: {str(e)}")
    
    async def _execute_list_user_documents(self, arguments: Dict[str, Any]) -> McpToolCallResponse:
        """Execute the list_user_documents tool"""
        # Extract userId and sessionId BEFORE handling nested kwargs from Semantic Kernel
        user_id = arguments.get("userId", "") or arguments.get("user_id", "")
        session_id = arguments.get("sessionId", "") or arguments.get("session_id", "")
        
        # Handle nested kwargs from Semantic Kernel
        if "kwargs" in arguments:
            kwargs_data = arguments["kwargs"]
            # If userId/sessionId are not found at top level, check inside kwargs
            if not user_id:
                user_id = kwargs_data.get("userId", "") or kwargs_data.get("user_id", "")
            if not session_id:
                session_id = kwargs_data.get("sessionId", "") or kwargs_data.get("session_id", "")
            arguments = kwargs_data
        
        if not user_id:
            return self._create_error_response("No user ID provided")
        
        try:
            if not self.document_service:
                return self._create_error_response("Document service not available")
            
            # Get user documents using AzureDocumentService
            documents = await self.document_service.get_user_documents_async(
                user_id=user_id,
                session_id=session_id
            )
            
            if not documents:
                return McpToolCallResponse.success("No documents found for this user/session.")
            
            # Format results
            message = f"Found {len(documents)} documents:\n\n"
            for i, doc in enumerate(documents, 1):
                status_text = {0: "Uploaded", 1: "Processing", 2: "Processed", 5: "Failed"}.get(doc.status, "Unknown")
                message += f"**{i}. {doc.file_name}**\n"
                message += f"   - ID: {doc.document_id}\n"
                message += f"   - Status: {status_text}\n"
                message += f"   - Uploaded: {doc.upload_date}\n"
                message += f"   - Size: {doc.file_size} bytes\n\n"
            
            return McpToolCallResponse.success(message)
        
        except Exception as e:
            logger.error(f"Error listing user documents: {e}")
            return self._create_error_response(f"Document listing failed: {str(e)}")
    
    async def _execute_get_document_content(self, arguments: Dict[str, Any]) -> McpToolCallResponse:
        """Execute the get_document_content tool"""
        # Extract userId, sessionId, and documentId BEFORE handling nested kwargs from Semantic Kernel
        user_id = arguments.get("userId", "") or arguments.get("user_id", "")
        session_id = arguments.get("sessionId", "") or arguments.get("session_id", "")
        document_id = (arguments.get("documentId", "") or 
                      arguments.get("document_id", "") or 
                      arguments.get("id", ""))  # SK sometimes sends 'id' instead of 'documentId'
        
        # Handle nested kwargs from Semantic Kernel
        if "kwargs" in arguments:
            kwargs_data = arguments["kwargs"]
            # If userId/sessionId/documentId are not found at top level, check inside kwargs
            if not user_id:
                user_id = kwargs_data.get("userId", "") or kwargs_data.get("user_id", "")
            if not session_id:
                session_id = kwargs_data.get("sessionId", "") or kwargs_data.get("session_id", "")
            if not document_id:
                document_id = (kwargs_data.get("documentId", "") or 
                              kwargs_data.get("document_id", "") or 
                              kwargs_data.get("id", ""))  # SK sometimes sends 'id' instead of 'documentId'
            arguments = kwargs_data
        
        logger.info(f"🔍 Executing get_document_content: document_id='{document_id}', user_id='{user_id}', session_id='{session_id}'")
        
        if not document_id:
            return self._create_error_response("No document ID provided")
        
        if not user_id:
            return self._create_error_response("No user ID provided")
        
        # IMPORTANT: Always require sessionId for security - only allow access to documents in current session
        if not session_id:
            return self._create_error_response("No session ID provided - session isolation required")
        
        try:
            if not self.document_service:
                return self._create_error_response("Document service not available")
            
            # Find document context first with session verification
            document_context = await self.document_service._find_document_with_context_async(document_id, session_id)
            if not document_context:
                return self._create_error_response(f"Document not found: {document_id}")
            
            document_metadata, doc_user_id, doc_session_id = document_context
            
            # Verify the document belongs to the current user and session
            if doc_user_id != user_id:
                logger.warning(f"🚫 Access denied: Document {document_id} belongs to user {doc_user_id}, requested by {user_id}")
                return self._create_error_response("Access denied: Document not found")
            
            if doc_session_id != session_id:
                logger.warning(f"🚫 Session isolation: Document {document_id} belongs to session {doc_session_id}, requested from session {session_id}")
                return self._create_error_response("Document not found in current session")
            
            logger.info(f"✅ Document access authorized: {document_id} for user {user_id} in session {session_id}")
            
            # Extract text
            blob_url = document_metadata.get('blobUrl', '')
            file_name = document_metadata.get('fileName', 'Unknown')
            
            if not blob_url:
                return self._create_error_response("Document content not available")
            
            extracted_text = await self.document_service._extract_text_async(blob_url, file_name)
            
            if not extracted_text:
                return self._create_error_response("Could not extract text from document")
            
            # Format response
            message = f"**Content of {file_name}:**\n\n{extracted_text}"
            
            return McpToolCallResponse.success(message)
        
        except Exception as e:
            logger.error(f"Error getting document content: {e}")
            return self._create_error_response(f"Document content retrieval failed: {str(e)}")
