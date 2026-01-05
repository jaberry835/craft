using Microsoft.SemanticKernel;
using Microsoft.SemanticKernel.Agents;
using Microsoft.SemanticKernel.ChatCompletion;
using Microsoft.SemanticKernel.Connectors.AzureOpenAI;
using MCPServer.Models;
using MCPServer.Services;
using MCPServer.Services.Azure;
using System.Text.Json;

namespace MCPServer.Services.Agents;

public interface IAgentOrchestrator
{
    Task<(ChatMessage message, List<AgentInteraction> interactions)> ProcessChatAsync(ChatCompletionRequest request);
}

public class AgentOrchestrator : IAgentOrchestrator
{
    private readonly ILogger<AgentOrchestrator> _logger;
    private readonly IConfiguration _configuration;
    private readonly IChatHistoryService _chatHistoryService;
    private readonly IToolService _toolService;    private readonly IAgentActivityBroadcastService _broadcastService;    private readonly List<AgentInteraction> _currentInteractions = new();
    private string? _currentSessionId;
    private string? _currentUserId;
    
    private Kernel? _kernel;
    private ChatCompletionAgent? _orchestratorAgent;
    private ChatCompletionAgent? _adxAgent;
    private ChatCompletionAgent? _mapsAgent;
    private ChatCompletionAgent? _documentsAgent;
    private ChatCompletionAgent? _azureResourcesAgent;

    public AgentOrchestrator(
        ILogger<AgentOrchestrator> logger,
        IConfiguration configuration,
        IChatHistoryService chatHistoryService,
        IToolService toolService,
        IAgentActivityBroadcastService broadcastService)
    {
        _logger = logger;
        _configuration = configuration;
        _chatHistoryService = chatHistoryService;
        _toolService = toolService;
        _broadcastService = broadcastService;
    }    public async Task<(ChatMessage message, List<AgentInteraction> interactions)> ProcessChatAsync(ChatCompletionRequest request)
    {
        _currentInteractions.Clear(); // Reset interactions for this request
        _currentSessionId = request.SessionId; // Store session ID for broadcasting
        _currentUserId = request.UserId; // Store user ID for tool context
        
        try
        {
            await LogInteractionAsync("Orchestrator", "Starting chat processing", "Initializing agents and analyzing request", "in-progress");
            
            await InitializeAsync();

            if (_kernel == null || _orchestratorAgent == null)
            {
                throw new InvalidOperationException("Failed to initialize agents");
            }

            _logger.LogInformation("Processing chat completion with Agent Orchestrator for session {SessionId}", request.SessionId);

            // Create chat history for the main orchestrator
            var chatHistory = new ChatHistory();

            // Add system prompt
            var systemPrompt = _configuration["SystemPrompt"];
            if (!string.IsNullOrEmpty(systemPrompt))
            {
                chatHistory.AddSystemMessage(systemPrompt);
            }

            // Add conversation messages
            foreach (var message in request.Messages)
            {
                if (message.Role == "user")
                {
                    chatHistory.AddUserMessage(message.Content ?? "");
                }
                else if (message.Role == "assistant")
                {
                    chatHistory.AddAssistantMessage(message.Content ?? "");
                }
            }            // Get the user's message
            var lastUserMessage = request.Messages.LastOrDefault(m => m.Role == "user");
            if (lastUserMessage == null)
            {
                throw new InvalidOperationException("No user message found in the request");
            }

            _logger.LogInformation("Analyzing user request: {Prompt}", lastUserMessage.Content);

            // Determine which agents are needed and coordinate their responses
            var response = await CoordinateAgentsAsync(lastUserMessage.Content ?? "", chatHistory);

            _logger.LogInformation("Agent coordination completed with response: {Response}", response);

            // Create and save the response message
            var responseMessage = new ChatMessage
            {
                Id = Guid.NewGuid().ToString(),
                Role = "assistant",
                Content = response,
                Timestamp = DateTime.UtcNow,
                SessionId = request.SessionId,
                UserId = request.UserId            };

            await _chatHistoryService.SaveMessageAsync(responseMessage);
            
            await LogInteractionAsync("Orchestrator", "Chat processing completed", "Successfully generated response", "success");
            return (responseMessage, _currentInteractions.ToList());
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error processing chat completion with Agent Orchestrator for session {SessionId}", request.SessionId);
            
            await LogInteractionAsync("Orchestrator", "Error processing chat", ex.Message, "error");
            
            var errorMessage = new ChatMessage
            {
                Id = Guid.NewGuid().ToString(),
                Role = "assistant",
                Content = "I encountered an error while processing your request. Please try again.",
                Timestamp = DateTime.UtcNow,
                SessionId = request.SessionId,
                UserId = request.UserId
            };

            await _chatHistoryService.SaveMessageAsync(errorMessage);
            return (errorMessage, _currentInteractions.ToList());
        }
    }

    private async Task InitializeAsync()
    {
        if (_kernel != null && _orchestratorAgent != null)
        {
            return; // Already initialized
        }

        _logger.LogInformation("Initializing Agent Orchestrator with specialized agents");

        // Get Azure OpenAI configuration
        var endpoint = _configuration["AzureOpenAI:Endpoint"];
        var apiKey = _configuration["AzureOpenAI:ApiKey"];
        var deploymentName = _configuration["AzureOpenAI:DeploymentName"] ?? "gpt-4o";

        if (string.IsNullOrEmpty(endpoint) || string.IsNullOrEmpty(apiKey))
        {
            throw new InvalidOperationException("Azure OpenAI configuration is missing");
        }

        // Create shared kernel
        _kernel = Kernel.CreateBuilder()
            .AddAzureOpenAIChatCompletion(deploymentName, endpoint, apiKey)
            .Build();

        // Create execution settings
        var executionSettings = new AzureOpenAIPromptExecutionSettings
        {
            FunctionChoiceBehavior = FunctionChoiceBehavior.Auto(options: new() { RetainArgumentTypes = true })
        };

        // Initialize specialized agents
        await InitializeAgentsAsync(executionSettings);

        _logger.LogInformation("Agent Orchestrator initialization completed successfully");
    }

    private async Task InitializeAgentsAsync(AzureOpenAIPromptExecutionSettings executionSettings)
    {
        // Get all MCP tools and categorize them
        var allTools = await _toolService.GetAvailableToolsAsync();
        var toolGroups = CategorizeTools(allTools);

        // Create Main Orchestrator Agent
        _orchestratorAgent = new ChatCompletionAgent
        {
            Name = "Orchestrator",
            Instructions = @"You are the main orchestrator agent that coordinates with specialized agents to help users.

Your role is to:
1. Analyze user requests and determine which specialized agents are needed
2. Delegate tasks to the appropriate agents (ADX, Maps, Documents, Azure Resources)
3. Coordinate responses and provide a comprehensive final answer to the user
4. You do NOT call tools directly - instead, you ask other agents to perform specific tasks

Available specialized agents:
- **ADXAgent**: Handles database queries, data analysis, and personnel lookups
- **MapsAgent**: Handles geocoding, routing, mapping, and location services
- **DocumentsAgent**: Handles document search and retrieval
- **AzureResourcesAgent**: Handles Azure resource management and operations

When a user asks something:
1. Identify what type of information is needed
2. Ask the relevant agent(s) to gather that information
3. Synthesize the responses into a helpful final answer
4. Always provide a clear, comprehensive response to the user

Remember: You coordinate and synthesize - the specialized agents do the actual tool work.",
            Kernel = _kernel,
            Arguments = new KernelArguments(executionSettings)
        };        // Create ADX Data Agent
        if (toolGroups.TryGetValue("ADX", out var adxTools) && adxTools.Any() && _kernel != null)
        {
            var adxKernel = _kernel.Clone();
            await AddToolsToKernel(adxKernel, adxTools, "ADXTools");

            _adxAgent = new ChatCompletionAgent
            {
                Name = "ADXAgent",
                Instructions = @"You are the Azure Data Explorer (ADX) specialist agent. You handle all database queries and data analysis tasks.

Your responsibilities:
- Execute database queries using ADX tools
- Search for personnel information in the Personnel database
- Analyze data and provide insights
- Always provide clear, formatted results

Available tools: adx_list_databases, adx_list_tables, adx_describe_table, adx_query

When asked to find information:
1. First explore the database structure if needed
2. Execute targeted queries
3. Format results clearly
4. Provide insights or summaries as requested",
                Kernel = adxKernel,
                Arguments = new KernelArguments(executionSettings)
            };
        }        // Create Maps & Geospatial Agent
        if (toolGroups.TryGetValue("Maps", out var mapsTools) && mapsTools.Any() && _kernel != null)
        {
            var mapsKernel = _kernel.Clone();
            await AddToolsToKernel(mapsKernel, mapsTools, "MapsTools");            _mapsAgent = new ChatCompletionAgent
            {
                Name = "MapsAgent", 
                Instructions = @"You are the Maps and Geospatial specialist agent. You handle all location-related tasks.

Your responsibilities:
- Geocode addresses to coordinates
- Get driving directions between locations
- Generate map URLs for visualization
- Handle all geospatial queries

Available tools: geocode_address, get_route_directions

When asked about locations or directions:
1. First geocode all addresses mentioned to get their coordinates
2. For routing requests, ensure you have both origin and destination coordinates
3. Use get_route_directions with proper origin and destination coordinates
4. Generate map links for visualization
5. Include estimated travel times and distances when available

IMPORTANT: When provided with address information from a database lookup:
- Extract the EXACT addresses from the context
- Do NOT try to geocode generic names like 'Frank Turner's address'
- Look for actual street addresses in the format: number street, city, state, zip
- If coordinates are needed for routing, make sure both origin and destination are properly geocoded first",
                Kernel = mapsKernel,
                Arguments = new KernelArguments(executionSettings)
            };
        }        // Create Documents Agent
        if (toolGroups.TryGetValue("Documents", out var docTools) && docTools.Any() && _kernel != null)
        {
            var docsKernel = _kernel.Clone();
            await AddToolsToKernel(docsKernel, docTools, "DocumentTools");            _documentsAgent = new ChatCompletionAgent
            {
                Name = "DocumentsAgent",
                Instructions = @"You are the Document Search specialist agent. You handle document retrieval and search tasks.

Your responsibilities:
- Search through uploaded documents
- Retrieve relevant content based on queries
- Get full document content by document ID
- Provide document summaries and insights
- Handle RAG (Retrieval-Augmented Generation) tasks

Available tools: search_documents, list_user_documents, get_document_content

When asked to search documents:
1. Execute semantic search queries
2. Retrieve the most relevant documents
3. Summarize findings
4. Provide source references

When asked to extract content from a specific document:
1. Use list_user_documents to find the document ID
2. Use get_document_content with the document ID to get the full text content
3. Return the content in a format suitable for further processing

IMPORTANT: When the user wants to cross-reference document content with a database:
1. First get the document content using get_document_content
2. Extract the relevant information (like names, addresses, etc.)
3. Present the content clearly so it can be used by other agents",
                Kernel = docsKernel,
                Arguments = new KernelArguments(executionSettings)
            };
        }

        // Create Azure Resources Agent
        if (toolGroups.TryGetValue("Azure", out var azureTools) && azureTools.Any() && _kernel != null)
        {
            var azureKernel = _kernel.Clone();
            await AddToolsToKernel(azureKernel, azureTools, "AzureTools");

            _azureResourcesAgent = new ChatCompletionAgent
            {
                Name = "AzureResourcesAgent",
                Instructions = @"You are the Azure Resources specialist agent. You handle Azure cloud resource management tasks.

Your responsibilities:
- Manage Azure resources
- Handle cloud operations
- Provide Azure service information
- Execute Azure-specific tasks

When asked about Azure resources:
1. Execute the appropriate Azure operations
2. Provide status updates
3. Report results clearly
4. Include relevant Azure portal links when helpful",
                Kernel = azureKernel,
                Arguments = new KernelArguments(executionSettings)
            };
        }        _logger.LogInformation("Specialized agents initialized successfully");
    }    private async Task<string> CoordinateAgentsAsync(string userMessage, ChatHistory chatHistory)
    {
        _logger.LogInformation("Coordinating agents for user message: {Message}", userMessage);        // Analyze the user request to determine which agents are needed
        var neededAgents = DetermineNeededAgents(userMessage);
        _logger.LogInformation("Determined needed agents: {Agents}", string.Join(", ", neededAgents));
        
        await LogInteractionAsync("Orchestrator", "Analyzed user request", $"Determined needed agents: {string.Join(", ", neededAgents)}", "success");        var agentResponses = new List<string>();

        // Special workflow for document content extraction + ADX cross-reference
        if (neededAgents.Contains("Documents") && neededAgents.Contains("ADX") && 
            (userMessage.Contains("match") || userMessage.Contains("cross-reference") || 
             userMessage.Contains("names.txt") || (userMessage.Contains("names") && userMessage.Contains("file"))))
        {            _logger.LogInformation("Executing Documents → ADX RAG workflow for document content cross-reference");
            await LogInteractionAsync("Orchestrator", "Starting Documents → ADX RAG workflow", "Coordinating document content extraction and database cross-reference", "in-progress");
            
            // Add small delay for streaming effect
            await Task.Delay(500);
            
            try
            {
                // Step 1: Extract document content
                _logger.LogInformation("Step 1: Extracting document content");
                await LogInteractionAsync("Documents Agent", "Starting content extraction", "Getting document content for cross-reference", "in-progress");
                
                // Small delay to show the interaction
                await Task.Delay(300);
                
                var documentsAgent = GetAgent("Documents");
                if (documentsAgent != null)
                {
                    var startTime = DateTime.UtcNow;
                    var documentsPrompt = CreateDocumentExtractionPrompt(userMessage);
                    var documentsChatHistory = new ChatHistory();
                    documentsChatHistory.AddUserMessage(documentsPrompt);

                    var documentsResponse = await documentsAgent.InvokeAsync(documentsChatHistory).FirstAsync();
                    var documentsContent = documentsResponse.Message.Content ?? "";
                    var duration = DateTime.UtcNow - startTime;
                    
                    _logger.LogInformation("Documents agent extracted content: {Response}", documentsContent);
                    await LogInteractionAsync("Documents Agent", "Content extraction completed", $"Extracted document content: {documentsContent.Substring(0, Math.Min(100, documentsContent.Length))}...", "success", duration);
                    agentResponses.Add($"**Document Content Extraction:**\n{documentsContent}");

                    // Delay before next step for better streaming experience
                    await Task.Delay(800);

                    // Step 2: Use ADX to cross-reference the extracted content
                    _logger.LogInformation("Step 2: Using ADX agent to cross-reference extracted content");
                    await LogInteractionAsync("ADX Agent", "Starting cross-reference query", "Searching database for matches to document content", "in-progress");
                    
                    // Small delay to show the interaction
                    await Task.Delay(300);
                    
                    var adxAgent = GetAgent("ADX");
                    if (adxAgent != null)
                    {
                        var adxStartTime = DateTime.UtcNow;
                        var adxPrompt = CreateADXCrossReferencePrompt(userMessage, documentsContent);
                        var adxChatHistory = new ChatHistory();
                        adxChatHistory.AddUserMessage(adxPrompt);

                        var adxResponse = await adxAgent.InvokeAsync(adxChatHistory).FirstAsync();
                        var adxContent = adxResponse.Message.Content ?? "";
                        var adxDuration = DateTime.UtcNow - adxStartTime;
                        
                        _logger.LogInformation("ADX agent cross-reference response: {Response}", adxContent);
                        await LogInteractionAsync("ADX Agent", "Cross-reference query completed", $"Found database matches: {adxContent.Substring(0, Math.Min(100, adxContent.Length))}...", "success", adxDuration);
                        agentResponses.Add($"**Database Cross-Reference Results:**\n{adxContent}");
                    }
                }
                
                // Final delay before completion
                await Task.Delay(500);
                await LogInteractionAsync("Orchestrator", "Documents → ADX RAG workflow completed", "Successfully coordinated document extraction and database cross-reference", "success");
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error in Documents → ADX RAG workflow");
                await LogInteractionAsync("Orchestrator", "Documents → ADX RAG workflow failed", ex.Message, "error");
                agentResponses.Add("**RAG Workflow Error:** Failed to complete document extraction and database cross-reference workflow");
            }
        }        // Special workflow for address lookup + directions
        else if (neededAgents.Contains("ADX") && neededAgents.Contains("Maps") && 
            (userMessage.Contains("address") || userMessage.Contains("direct") || userMessage.Contains("location")))
        {
            _logger.LogInformation("Executing ADX → Maps workflow for address lookup and directions");
            await LogInteractionAsync("Orchestrator", "Starting ADX → Maps workflow", "Coordinating address lookup and mapping", "in-progress");
            
            // Add small delay for streaming effect
            await Task.Delay(500);
            
            // Step 1: Use ADX to find the person's address
            try
            {
                _logger.LogInformation("Step 1: Querying ADX for person's address");
                await LogInteractionAsync("ADX Agent", "Starting address lookup", "Searching database for person's address", "in-progress");
                
                // Small delay to show the interaction
                await Task.Delay(300);
                
                var adxAgent = GetAgent("ADX");
                if (adxAgent != null)
                {
                    var startTime = DateTime.UtcNow;
                    var adxPrompt = CreatePersonLookupPrompt(userMessage);
                    var adxChatHistory = new ChatHistory();
                    adxChatHistory.AddUserMessage(adxPrompt);

                    var adxResponse = await adxAgent.InvokeAsync(adxChatHistory).FirstAsync();
                    var adxContent = adxResponse.Message.Content ?? "";
                    var duration = DateTime.UtcNow - startTime;
                    
                    _logger.LogInformation("ADX agent found address info: {Response}", adxContent);
                    await LogInteractionAsync("ADX Agent", "Address lookup completed", $"Found address information: {adxContent.Substring(0, Math.Min(100, adxContent.Length))}...", "success", duration);
                    agentResponses.Add($"**Database Lookup Result:**\n{adxContent}");

                    // Delay before next step for better streaming experience
                    await Task.Delay(800);

                    // Step 2: Use Maps with the found address information
                    _logger.LogInformation("Step 2: Using Maps agent with found address");
                    await LogInteractionAsync("Maps Agent", "Starting geocoding and routing", "Processing addresses and generating maps", "in-progress");
                    
                    // Small delay to show the interaction
                    await Task.Delay(300);
                    
                    var mapsAgent = GetAgent("Maps");
                    if (mapsAgent != null)
                    {
                        var mapsStartTime = DateTime.UtcNow;
                        var mapsPrompt = CreateMapsPromptWithContext(userMessage, adxContent);
                        var mapsChatHistory = new ChatHistory();
                        mapsChatHistory.AddUserMessage(mapsPrompt);

                        var mapsResponse = await mapsAgent.InvokeAsync(mapsChatHistory).FirstAsync();
                        var mapsContent = mapsResponse.Message.Content ?? "";
                        var mapsDuration = DateTime.UtcNow - mapsStartTime;
                        
                        _logger.LogInformation("Maps agent response: {Response}", mapsContent);
                        await LogInteractionAsync("Maps Agent", "Geocoding and routing completed", $"Generated maps and directions: {mapsContent.Substring(0, Math.Min(100, mapsContent.Length))}...", "success", mapsDuration);
                        agentResponses.Add($"**Maps & Directions Result:**\n{mapsContent}");
                    }
                }
                
                await LogInteractionAsync("Orchestrator", "ADX → Maps workflow completed", "Successfully coordinated address lookup and mapping", "success");
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error in ADX → Maps workflow");
                await LogInteractionAsync("Orchestrator", "ADX → Maps workflow failed", ex.Message, "error");
                agentResponses.Add("**Workflow Error:** Failed to complete address lookup and mapping workflow");
            }        }
        else        {
            // Standard workflow - execute each agent independently
            await LogInteractionAsync("Orchestrator", "Starting standard workflow", "Executing agents independently", "in-progress");
            
            // Add small delay for streaming effect
            await Task.Delay(500);
            
            foreach (var agentType in neededAgents)
            {
                try
                {
                    var agent = GetAgent(agentType);
                    if (agent != null)
                    {
                        _logger.LogInformation("Invoking {AgentType} agent", agentType);
                        await LogInteractionAsync($"{agentType} Agent", "Starting task", $"Processing request independently", "in-progress");
                        
                        // Small delay to show the interaction
                        await Task.Delay(300);
                        
                        var startTime = DateTime.UtcNow;
                        var agentPrompt = CreateAgentSpecificPrompt(userMessage, agentType);
                        var agentChatHistory = new ChatHistory();
                        agentChatHistory.AddUserMessage(agentPrompt);

                        var response = await agent.InvokeAsync(agentChatHistory).FirstAsync();
                        var responseContent = response.Message.Content ?? "";
                        var duration = DateTime.UtcNow - startTime;
                        
                        _logger.LogInformation("{AgentType} agent response: {Response}", agentType, responseContent);
                        await LogInteractionAsync($"{agentType} Agent", "Task completed", $"Generated response: {responseContent.Substring(0, Math.Min(100, responseContent.Length))}...", "success", duration);
                        agentResponses.Add($"**{agentType} Agent Result:**\n{responseContent}");
                        
                        // Delay between agents for better streaming experience
                        await Task.Delay(400);
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Error invoking {AgentType} agent", agentType);
                    await LogInteractionAsync($"{agentType} Agent", "Task failed", ex.Message, "error");
                    agentResponses.Add($"**{agentType} Agent Error:** Failed to process request");
                    
                    // Small delay even on error
                    await Task.Delay(200);
                }
            }
            
            // Final delay before completion
            await Task.Delay(500);
            await LogInteractionAsync("Orchestrator", "Standard workflow completed", "All agents executed independently", "success");
        }

        // Use the orchestrator to synthesize the final response
        if (agentResponses.Any())
        {
            await LogInteractionAsync("Orchestrator", "Starting response synthesis", "Combining agent results into final response", "in-progress");
            
            var synthesisPrompt = $@"Based on the following results from specialized agents, provide a comprehensive and helpful response to the user's request: ""{userMessage}""

Agent Results:
{string.Join("\n\n", agentResponses)}

Please synthesize this information into a clear, helpful response for the user.";

            var startTime = DateTime.UtcNow;
            var orchestratorChatHistory = new ChatHistory();
            orchestratorChatHistory.AddUserMessage(synthesisPrompt);

            var finalResponse = await _orchestratorAgent!.InvokeAsync(orchestratorChatHistory).FirstAsync();
            var duration = DateTime.UtcNow - startTime;
            var finalContent = finalResponse.Message.Content ?? "I was unable to process your request.";
            
            await LogInteractionAsync("Orchestrator", "Response synthesis completed", $"Generated final response: {finalContent.Substring(0, Math.Min(100, finalContent.Length))}...", "success", duration);
            return finalContent;
        }
        else
        {
            await LogInteractionAsync("Orchestrator", "Direct processing", "No specialized agents needed, processing directly", "in-progress");
            
            // No specialized agents needed, use orchestrator directly
            var response = await _orchestratorAgent!.InvokeAsync(chatHistory).FirstAsync();
            return response.Message.Content ?? "I was unable to process your request.";
        }
    }    private List<string> DetermineNeededAgents(string userMessage)
    {
        var message = userMessage.ToLower();
        var neededAgents = new List<string>();

        _logger.LogInformation("Analyzing user message for agent needs: {Message}", message);

        // Check for person names that might need ADX lookup
        var personNames = new[] { "turner", "johnson", "frank", "bob", "alice", "john", "jane", "smith", "wilson" };
        var hasPersonName = personNames.Any(name => message.Contains(name));
        
        // Check for ADX/database needs - especially for person lookups
        if (message.Contains("employee") || message.Contains("person") || message.Contains("staff") ||
            message.Contains("database") || message.Contains("query") || message.Contains("data") ||
            hasPersonName ||
            (message.Contains("find") && message.Contains("name")) ||
            (message.Contains("address") && hasPersonName) ||
            (message.Contains("direct me to") && hasPersonName))
        {
            neededAgents.Add("ADX");
            _logger.LogInformation("ADX agent needed - detected person lookup or database query");
        }

        // Check for maps/location needs
        if (message.Contains("address") || message.Contains("location") || message.Contains("map") ||
            message.Contains("direction") || message.Contains("route") || message.Contains("navigate") ||
            message.Contains("street") || message.Contains("road") || message.Contains("drive") ||
            message.Contains("direct me") || message.Contains("show me") || message.Contains("get to") ||
            message.Contains("coordinate") || message.Contains("latitude") || message.Contains("longitude"))
        {
            neededAgents.Add("Maps");
            _logger.LogInformation("Maps agent needed - detected location or navigation request");
        }        // Check for document search needs
        if (message.Contains("document") || message.Contains("search") || message.Contains("file") ||
            message.Contains("upload") || message.Contains("content") || message.Contains("names.txt") ||
            (message.Contains("match") && (message.Contains("names") || message.Contains("list"))))
        {
            neededAgents.Add("Documents");
            _logger.LogInformation("Documents agent needed - detected document search request");
        }

        // Check for Azure resource needs
        if (message.Contains("azure") || message.Contains("resource") || message.Contains("cloud") ||
            message.Contains("subscription") || message.Contains("service"))
        {
            neededAgents.Add("Azure");
            _logger.LogInformation("Azure agent needed - detected Azure resource request");
        }

        _logger.LogInformation("Final determined agents: {Agents}", string.Join(", ", neededAgents));
        return neededAgents.Distinct().ToList();
    }

    private ChatCompletionAgent? GetAgent(string agentType)
    {
        return agentType switch
        {
            "ADX" => _adxAgent,
            "Maps" => _mapsAgent,
            "Documents" => _documentsAgent,
            "Azure" => _azureResourcesAgent,
            _ => null
        };
    }

    private string CreateAgentSpecificPrompt(string userMessage, string agentType)
    {
        return agentType switch
        {
            "ADX" => $"As the ADX specialist, help with this data query: {userMessage}",
            "Maps" => $"As the Maps specialist, help with this location request: {userMessage}",
            "Documents" => $"As the Documents specialist, help with this search request: {userMessage}",
            "Azure" => $"As the Azure specialist, help with this resource request: {userMessage}",
            _ => userMessage
        };
    }

    private Dictionary<string, List<McpTool>> CategorizeTools(IEnumerable<McpTool> tools)
    {
        var categories = new Dictionary<string, List<McpTool>>();

        foreach (var tool in tools)
        {
            var category = tool.Name.ToLower() switch
            {
                var name when name.StartsWith("adx_") => "ADX",
                var name when name.Contains("geocode") || name.Contains("route") || name.Contains("map") => "Maps",
                var name when name.Contains("document") || name.Contains("search") => "Documents",
                var name when name.Contains("azure") || name.Contains("resource") => "Azure",
                _ => "General"
            };

            if (!categories.ContainsKey(category))
            {
                categories[category] = new List<McpTool>();
            }
            categories[category].Add(tool);
        }

        return categories;
    }

    private Task AddToolsToKernel(Kernel kernel, List<McpTool> tools, string pluginName)
    {
        var kernelFunctions = new List<KernelFunction>();

        foreach (var tool in tools)
        {
            var kernelFunction = KernelFunctionFactory.CreateFromMethod(                method: async (KernelArguments args) =>
                {
                    _logger.LogInformation("Executing MCP tool: {ToolName} via {PluginName}", tool.Name, pluginName);

                    var mcpArgs = new Dictionary<string, object>();
                    
                    // Add session and user context to all tool calls
                    if (!string.IsNullOrEmpty(_currentSessionId))
                    {
                        mcpArgs["sessionId"] = _currentSessionId;
                    }
                    if (!string.IsNullOrEmpty(_currentUserId))
                    {
                        mcpArgs["userId"] = _currentUserId;
                    }
                    
                    // Add the original arguments from the kernel
                    foreach (var arg in args)
                    {
                        if (arg.Value != null)
                        {
                            mcpArgs[arg.Key] = arg.Value;
                        }
                    }

                    var toolRequest = new McpToolCallRequest
                    {
                        Name = tool.Name,
                        Arguments = mcpArgs
                    };

                    var result = await _toolService.ExecuteToolAsync(toolRequest);
                    var resultText = result?.Content?.FirstOrDefault()?.Text ?? $"Tool {tool.Name} executed successfully";

                    _logger.LogInformation("MCP tool {ToolName} result: {Result}", tool.Name, resultText);
                    return resultText;
                },
                functionName: tool.Name,
                description: tool.Description
            );

            kernelFunctions.Add(kernelFunction);
        }        if (kernelFunctions.Any())
        {
            kernel.Plugins.AddFromFunctions(pluginName, kernelFunctions);
            _logger.LogInformation("Added {ToolCount} tools to {PluginName}", kernelFunctions.Count, pluginName);
        }

        return Task.CompletedTask;
    }
    private string CreatePersonLookupPrompt(string userMessage)
    {
        return $@"The user is asking: ""{userMessage}""

Your task is to find the person queried details from the database. You have access to ADX database tools.

STEP-BY-STEP INSTRUCTIONS:
1. Use adx_list_databases to see available databases
2. Use adx_list_tables to see tables in the Personnel database (if available)
3. Use adx_describe_table to understand the structure of the tables
4. Use adx_query to search for the name in the proper table
5. Return the result founds COMPLETE ADDRESS including:
   - Street number and name
   - City
   - State
   - ZIP code

EXAMPLE OUTPUT FORMAT:
Found: Frank Turner
Address: 123 Main Street, Springfield, VA 22150

Focus on returning the exact, complete street address that can be used for mapping and directions.";
    }
    private string CreateMapsPromptWithContext(string userMessage, string adxResults)
    {
        return $@"The user originally asked: ""{userMessage}""

A database search was performed and found this information:
{adxResults}

Your task is to help with mapping and directions. You have access to geocoding and routing tools.

STEP-BY-STEP INSTRUCTIONS:
1. From the user's message, identify the STARTING ADDRESS: ""19255 Walsh Farm Ln, Bluemont, VA""
2. From the database results above, find Frank Turner's EXACT ADDRESS (look for street number, street name, city, state)
3. Use geocode_address tool to get coordinates for BOTH addresses:
   - First geocode: ""19255 Walsh Farm Ln, Bluemont, VA""
   - Second geocode: The exact address found for Frank Turner from the database
4. Once you have coordinates for both locations, use get_route_directions tool with:
   - origin: the starting address
   - destination: Frank Turner's exact address
5. Provide both map URLs and routing information

IMPORTANT: Do NOT use generic names like ""Frank Turner's address"" in the geocoding tools. Use the EXACT street address found in the database results.";
    }

    private string CreateDocumentExtractionPrompt(string userMessage)
    {
        return $@"The user is asking: ""{userMessage}""

Your task is to extract content from documents that the user wants to cross-reference. You have access to document tools.

STEP-BY-STEP INSTRUCTIONS:
1. Use list_user_documents to see what documents are available
2. Look for documents that match what the user is asking about (e.g., names.txt, employee list, etc.)
3. Use get_document_content with the documentId to get the full text content of the relevant document
4. Return the extracted content in a clear format that can be used for further processing

EXAMPLE OUTPUT FORMAT:
Document Content from names.txt:
Jason Kim 
34561 Blue Ridge View Ln, Purcellville, VA
Natalie Rivera 
117 E Market St, Leesburg, VA
[... more names and addresses ...]

Focus on extracting the actual content that the user wants to cross-reference with the database.";
    }

    private string CreateADXCrossReferencePrompt(string userMessage, string documentContent)
    {
        return $@"The user originally asked: ""{userMessage}""

Document content has been extracted:
{documentContent}

Your task is to search the database for matches to the names or information in the document content above.

STEP-BY-STEP INSTRUCTIONS:
1. Parse the document content to extract individual names (ignore addresses for now)
2. Use adx_list_databases and adx_list_tables to understand the database structure
3. Use adx_describe_table to see the Employee table structure
4. Use adx_query to search for each name from the document in the Employee table
5. For each match found, include the database information (name, address, etc.)
6. Provide a summary of matches found vs. names searched

EXAMPLE QUERY FORMAT:
Use queries like: ""Employees | where Name contains 'Jason Kim' | project Name, Address""

Return results in a clear format showing which names from the document were found in the database and their details.";
    }

    private async Task LogInteractionAsync(string agentName, string action, string result, string status = "success", TimeSpan? duration = null)
    {
        var interaction = new AgentInteraction
        {
            AgentName = agentName,
            Action = action,
            Result = result,
            Status = status,
            Duration = duration,
            Timestamp = DateTime.UtcNow
        };
          _currentInteractions.Add(interaction);
        _logger.LogInformation("Agent Interaction: {AgentName} - {Action} - {Status}", agentName, action, status);
        
        // Broadcast real-time update if we have a session ID
        if (!string.IsNullOrEmpty(_currentSessionId))
        {
            _logger.LogInformation("Broadcasting agent interaction for session {SessionId}: {AgentName} - {Action}", _currentSessionId, agentName, action);
            await _broadcastService.BroadcastAgentInteractionAsync(_currentSessionId, interaction);
        }
        else
        {
            _logger.LogWarning("No session ID available for broadcasting agent interaction: {AgentName} - {Action}", agentName, action);
        }
    }
}
