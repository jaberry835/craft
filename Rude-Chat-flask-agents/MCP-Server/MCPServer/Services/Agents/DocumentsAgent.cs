using MCPServer.Models;
using MCPServer.Services.Azure;

namespace MCPServer.Services.Agents;

/// <summary>
/// Specialized agent for document management operations.
/// Handles document upload, processing, search, and retrieval.
/// </summary>
public class DocumentsAgent : BaseAgent
{
    private readonly IAzureDocumentService _documentService;

    public DocumentsAgent(
        ILogger<DocumentsAgent> logger, 
        IConfiguration configuration,
        IAzureDocumentService documentService) 
        : base(logger, configuration)
    {
        _documentService = documentService;
    }

    public override string AgentId => "documents-agent";
    public override string Name => "Documents Agent";
    public override string Description => "Specialized agent for document management including upload, processing, search, and retrieval";
    public override IEnumerable<string> Domains => new[] { "documents", "files", "upload", "search", "rag", "content" };

    protected override Task OnInitializeAsync(string? userToken)
    {
        _logger.LogInformation("Initializing Documents Agent");
        // Document service doesn't need user token initialization currently
        return Task.CompletedTask;
    }

    public override Task<IEnumerable<McpTool>> GetAvailableToolsAsync()
    {        try
        {
            // Document operations are typically handled through dedicated endpoints,
            // not as MCP tools, but we can provide metadata about capabilities
            var tools = new List<McpTool>
            {
                new McpTool
                {
                    Name = "search_documents",
                    Description = "Search through uploaded documents using AI search capabilities",
                    InputSchema = new McpToolInputSchema
                    {
                        Type = "object",
                        Properties = new Dictionary<string, McpProperty>
                        {
                            ["query"] = new McpProperty
                            {
                                Type = "string",
                                Description = "The search query to find relevant documents"
                            },
                            ["maxResults"] = new McpProperty
                            {
                                Type = "integer",
                                Description = "Maximum number of results to return (default: 5)"
                            }
                        },
                        Required = new[] { "query" }
                    }
                },
                new McpTool
                {
                    Name = "list_user_documents",
                    Description = "List all documents uploaded by the current user",
                    InputSchema = new McpToolInputSchema
                    {
                        Type = "object",
                        Properties = new Dictionary<string, McpProperty>(),
                        Required = Array.Empty<string>()
                    }
                },
                new McpTool
                {
                    Name = "get_document_content",
                    Description = "Get the full extracted text content of a specific document by its ID",
                    InputSchema = new McpToolInputSchema
                    {
                        Type = "object",
                        Properties = new Dictionary<string, McpProperty>
                        {
                            ["documentId"] = new McpProperty
                            {
                                Type = "string",
                                Description = "The ID of the document to retrieve content for"
                            }
                        },
                        Required = new[] { "documentId" }
                    }
                }
            };

            _logger.LogDebug("Documents Agent providing {ToolCount} tools", tools.Count);
            return Task.FromResult<IEnumerable<McpTool>>(tools);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to get Documents tools");
            return Task.FromResult(Enumerable.Empty<McpTool>());
        }
    }

    public override async Task<McpToolCallResponse> ExecuteToolAsync(McpToolCallRequest request)
    {
        _logger.LogInformation("Documents Agent executing tool: {ToolName}", request.Name);

        try
        {            return request.Name switch
            {
                "search_documents" => await ExecuteSearchDocumentsAsync(request.Arguments),
                "list_user_documents" => await ExecuteListUserDocumentsAsync(request.Arguments),
                "get_document_content" => await ExecuteGetDocumentContentAsync(request.Arguments),
                _ => CreateErrorResponse($"Unknown document tool: {request.Name}")
            };
        }
        catch (Exception ex)
        {
            return CreateErrorResponse($"Documents Agent failed to execute tool {request.Name}", ex);
        }
    }

    public override Task<bool> CanHandleToolAsync(string toolName)
    {
        return Task.FromResult(IsDocumentTool(toolName));
    }    protected override Task<bool> PerformHealthCheckAsync()
    {
        try
        {
            // Check if required services are configured
            var storageConnectionString = _configuration.GetConnectionString("AzureStorage");
            var searchEndpoint = _configuration["AzureAISearch:Endpoint"];
            
            if (string.IsNullOrEmpty(storageConnectionString) || storageConnectionString.Contains("[") ||
                string.IsNullOrEmpty(searchEndpoint) || searchEndpoint.Contains("["))
            {
                return Task.FromResult(false);
            }

            return Task.FromResult(true);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Documents Agent health check failed");
            return Task.FromResult(false);
        }
    }

    protected override Task<Dictionary<string, object>> GetHealthMetadataAsync()
    {
        var metadata = new Dictionary<string, object>
        {
            ["service_type"] = "Document Management",
            ["storage_configured"] = !string.IsNullOrEmpty(_configuration.GetConnectionString("AzureStorage")) && 
                                   !_configuration.GetConnectionString("AzureStorage")!.Contains("["),
            ["search_configured"] = !string.IsNullOrEmpty(_configuration["AzureAISearch:Endpoint"]) && 
                                  !_configuration["AzureAISearch:Endpoint"]!.Contains("["),
            ["openai_configured"] = !string.IsNullOrEmpty(_configuration["AzureOpenAI:Endpoint"]) && 
                                  !_configuration["AzureOpenAI:Endpoint"]!.Contains("[")
        };

        return Task.FromResult(metadata);
    }    private async Task<McpToolCallResponse> ExecuteSearchDocumentsAsync(Dictionary<string, object> arguments)
    {
        var query = arguments.GetValueOrDefault("query")?.ToString();
        var maxResults = int.TryParse(arguments.GetValueOrDefault("maxResults")?.ToString(), out var max) ? max : 5;
        
        // Get userId and sessionId from the arguments (provided by AgentOrchestrator)
        var userId = arguments.GetValueOrDefault("userId")?.ToString();
        var sessionId = arguments.GetValueOrDefault("sessionId")?.ToString();

        if (string.IsNullOrEmpty(query))
        {
            return CreateErrorResponse("Search query is required");
        }
        
        if (string.IsNullOrEmpty(userId))
        {
            return CreateErrorResponse("User ID is required but not provided in the context");
        }
        
        if (string.IsNullOrEmpty(sessionId))
        {
            return CreateErrorResponse("Session ID is required but not provided in the context");
        }

        try
        {
            var results = await _documentService.SearchDocumentsAsync(query, userId, sessionId, maxResults);
            
            if (!results.Any())
            {
                return CreateSuccessResponse($"No documents found matching query: '{query}'");
            }

            var responseText = $"📄 **Document Search Results** (Query: '{query}')\n\n";
            foreach (var (result, index) in results.Select((r, i) => (r, i + 1)))
            {
                responseText += $"**{index}. {result.FileName}**\n";
                responseText += $"• Score: {result.Score:F2}\n";
                var contentLength = result.Content?.Length ?? 0;
                var previewLength = Math.Min(200, contentLength);
                responseText += $"• Content: {result.Content?[..previewLength]}...\n";
                responseText += $"• Uploaded: {result.UploadedAt:yyyy-MM-dd HH:mm}\n\n";
            }

            return CreateSuccessResponse(responseText);
        }
        catch (Exception ex)
        {
            return CreateErrorResponse($"Error searching documents: {ex.Message}");
        }
    }    private async Task<McpToolCallResponse> ExecuteListUserDocumentsAsync(Dictionary<string, object> arguments)
    {
        // Get userId and sessionId from the arguments (provided by AgentOrchestrator)
        var userId = arguments.GetValueOrDefault("userId")?.ToString();
        var sessionId = arguments.GetValueOrDefault("sessionId")?.ToString();
        
        if (string.IsNullOrEmpty(userId))
        {
            return CreateErrorResponse("User ID is required but not provided in the context");
        }

        try
        {
            var documents = await _documentService.GetUserDocumentsAsync(userId, sessionId);
            
            if (!documents.Any())
            {
                return CreateSuccessResponse("No documents found for the current user.");
            }

            var responseText = $"📄 **User Documents** ({documents.Count()} found)\n\n";
            foreach (var (doc, index) in documents.Select((d, i) => (d, i + 1)))
            {
                responseText += $"**{index}. {doc.FileName}**\n";
                responseText += $"• ID: {doc.DocumentId}\n";
                responseText += $"• Size: {doc.FileSize:N0} bytes\n";
                responseText += $"• Uploaded: {doc.UploadDate:yyyy-MM-dd HH:mm}\n";
                responseText += $"• Status: {(DocumentStatus)doc.Status}\n\n";
            }            return CreateSuccessResponse(responseText);
        }
        catch (Exception ex)
        {
            return CreateErrorResponse($"Error listing user documents: {ex.Message}");
        }
    }

    private async Task<McpToolCallResponse> ExecuteGetDocumentContentAsync(Dictionary<string, object> arguments)
    {
        var documentId = arguments.GetValueOrDefault("documentId")?.ToString();
        var userId = arguments.GetValueOrDefault("userId")?.ToString();

        if (string.IsNullOrEmpty(documentId))
        {
            return CreateErrorResponse("Document ID is required");
        }
        
        if (string.IsNullOrEmpty(userId))
        {
            return CreateErrorResponse("User ID is required but not provided in the context");
        }

        try
        {
            var content = await _documentService.GetDocumentContentAsync(documentId, userId);
            
            if (string.IsNullOrEmpty(content))
            {
                return CreateSuccessResponse($"Document {documentId} was found but contains no extractable text content.");
            }

            var responseText = $"📄 **Document Content** (ID: {documentId})\n\n{content}";
            return CreateSuccessResponse(responseText);
        }
        catch (Exception ex)
        {
            return CreateErrorResponse($"Error getting document content: {ex.Message}");
        }
    }    private static bool IsDocumentTool(string toolName)
    {
        return toolName switch
        {
            "search_documents" => true,
            "list_user_documents" => true,
            "get_document_content" => true,
            _ => false
        };
    }

    /// <summary>
    /// Documents-specific method to suggest document operations
    /// </summary>
    public Task<McpToolCallResponse> SuggestDocumentOperationsAsync(string context)
    {
        try
        {
            _logger.LogInformation("Documents Agent providing suggestions for context: {Context}", context);

            var suggestions = new List<string>();

            if (context.ToLower().Contains("search") || context.ToLower().Contains("find"))
            {
                suggestions.Add("Use: search_documents to find relevant content in uploaded documents");
                suggestions.Add("Example: search_documents with query 'contract terms'");
            }

            if (context.ToLower().Contains("list") || context.ToLower().Contains("show"))
            {
                suggestions.Add("Use: list_user_documents to see all your uploaded documents");
            }

            if (context.ToLower().Contains("upload"))
            {
                suggestions.Add("Use the /api/documents/upload endpoint to upload new documents");
                suggestions.Add("Documents are automatically processed and indexed for search");
            }

            if (!suggestions.Any())
            {
                suggestions.Add("Available operations:");
                suggestions.Add("• search_documents - Find content in uploaded documents");
                suggestions.Add("• list_user_documents - View all your documents");
                suggestions.Add("• Upload via API endpoint for new documents");
            }

            var suggestionText = "📄 **Documents Agent Suggestions:**\n\n" + 
                               string.Join("\n", suggestions.Select((s, i) => $"{i + 1}. {s}"));

            return Task.FromResult(CreateSuccessResponse(suggestionText));
        }
        catch (Exception ex)
        {
            return Task.FromResult(CreateErrorResponse("Failed to generate Documents suggestions", ex));
        }
    }
}
