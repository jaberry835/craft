using Microsoft.SemanticKernel;
using Microsoft.SemanticKernel.Agents;
using Microsoft.SemanticKernel.ChatCompletion;
using Microsoft.SemanticKernel.Connectors.AzureOpenAI;
using ModelContextProtocol;
using MCPServer.Models;
using MCPServer.Services;
using MCPServer.Services.Azure;
using System.Text.Json;

namespace MCPServer.Services;

public interface ISemanticKernelChatService
{
    Task<ChatMessage> ProcessChatAsync(ChatCompletionRequest request);
}

public class SemanticKernelChatService : ISemanticKernelChatService
{
    private readonly ILogger<SemanticKernelChatService> _logger;
    private readonly IConfiguration _configuration;
    private readonly IChatHistoryService _chatHistoryService;
    private readonly IToolService _toolService;
    private Kernel? _kernel;
    private ChatCompletionAgent? _agent;

    public SemanticKernelChatService(
        ILogger<SemanticKernelChatService> logger,
        IConfiguration configuration,
        IChatHistoryService chatHistoryService,
        IToolService toolService)
    {
        _logger = logger;
        _configuration = configuration;
        _chatHistoryService = chatHistoryService;
        _toolService = toolService;
    }

    public async Task<ChatMessage> ProcessChatAsync(ChatCompletionRequest request)
    {
        try
        {
            // Initialize kernel and agent if not already done
            await InitializeAsync();

            if (_kernel == null || _agent == null)
            {
                throw new InvalidOperationException("Failed to initialize Semantic Kernel components");
            }

            _logger.LogInformation("Processing chat completion with Semantic Kernel for session {SessionId}", request.SessionId);

            // Create chat history for Semantic Kernel
            var chatHistory = new ChatHistory();

            // Add system prompt if available
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
            }

            // Get the last user message as the prompt
            var lastUserMessage = request.Messages.LastOrDefault(m => m.Role == "user");
            if (lastUserMessage == null)
            {
                throw new InvalidOperationException("No user message found in the request");
            }

            _logger.LogInformation("Invoking Semantic Kernel agent with prompt: {Prompt}", lastUserMessage.Content);            // Invoke the agent with the chat history
            var response = await _agent.InvokeAsync(chatHistory).FirstAsync();

            _logger.LogInformation("Semantic Kernel agent response received: {Response}", response.Message.Content);

            // Create and save the response message
            var responseMessage = new ChatMessage
            {
                Id = Guid.NewGuid().ToString(),
                Role = "assistant",
                Content = response.Message.Content ?? "I apologize, but I was unable to generate a response.",
                Timestamp = DateTime.UtcNow,
                SessionId = request.SessionId,
                UserId = request.UserId
            };

            await _chatHistoryService.SaveMessageAsync(responseMessage);

            return responseMessage;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error processing chat completion with Semantic Kernel for session {SessionId}", request.SessionId);
            
            // Return an error message
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
            return errorMessage;
        }
    }

    private async Task InitializeAsync()
    {        if (_kernel != null && _agent != null)
        {
            return; // Already initialized
        }

        _logger.LogInformation("Initializing Semantic Kernel with Azure OpenAI and MCP tools");

        // Get Azure OpenAI configuration
        var endpoint = _configuration["AzureOpenAI:Endpoint"];
        var apiKey = _configuration["AzureOpenAI:ApiKey"];
        var deploymentName = _configuration["AzureOpenAI:DeploymentName"] ?? "gpt-4o";

        if (string.IsNullOrEmpty(endpoint) || string.IsNullOrEmpty(apiKey))
        {
            throw new InvalidOperationException("Azure OpenAI configuration is missing");
        }        // Create kernel with Azure OpenAI
        var kernelBuilder = Kernel.CreateBuilder()
            .AddAzureOpenAIChatCompletion(deploymentName, endpoint, apiKey);

        // Get MCP tools and add them as Semantic Kernel functions
        try
        {
            var mcpTools = await _toolService.GetAvailableToolsAsync();
            _logger.LogInformation("Found {ToolCount} MCP tools to add to Semantic Kernel", mcpTools.Count());            if (mcpTools.Any())
            {
                var kernelFunctions = new List<KernelFunction>();
                
                foreach (var tool in mcpTools)
                {
                    // Create a Semantic Kernel function for each MCP tool
                    var kernelFunction = KernelFunctionFactory.CreateFromMethod(
                        method: async (KernelArguments args) =>
                        {
                            _logger.LogInformation("Executing MCP tool: {ToolName} with args: {Args}", tool.Name, 
                                string.Join(", ", args.Select(kv => $"{kv.Key}={kv.Value}")));
                            
                            // Convert Semantic Kernel arguments to MCP format
                            var mcpArgs = new Dictionary<string, object>();
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
                        description: tool.Description,
                        parameters: ConvertMcpParametersToKernelParameters(tool.InputSchema)
                    );
                    
                    kernelFunctions.Add(kernelFunction);
                }
                
                // Add all MCP tools as a plugin
                kernelBuilder.Plugins.AddFromFunctions("MCPTools", kernelFunctions);
                _logger.LogInformation("Successfully added {ToolCount} MCP tools to Semantic Kernel", kernelFunctions.Count);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to load MCP tools, continuing without tools");
        }

        _kernel = kernelBuilder.Build();

        // Create execution settings for automatic function calling
        var executionSettings = new AzureOpenAIPromptExecutionSettings
        {
            FunctionChoiceBehavior = FunctionChoiceBehavior.Auto(options: new() { RetainArgumentTypes = true })
        };

        // Create the chat completion agent
        _agent = new ChatCompletionAgent
        {
            Name = "MCPChatAgent",
            Instructions = @"You are an intelligent assistant that can help users with various tasks. 
You have access to powerful tools for data analysis, geocoding, file processing, and more. 
Always provide helpful, accurate, and detailed responses based on the information available.
When using tools, explain what you're doing and provide clear summaries of the results.
If you encounter any issues, explain them clearly and suggest alternatives when possible.",
            Kernel = _kernel,
            Arguments = new KernelArguments(executionSettings)
        };        _logger.LogInformation("Semantic Kernel initialization completed successfully");
    }

    private IEnumerable<KernelParameterMetadata> ConvertMcpParametersToKernelParameters(McpToolInputSchema? inputSchema)
    {
        var parameters = new List<KernelParameterMetadata>();
        
        if (inputSchema?.Properties != null)
        {
            foreach (var prop in inputSchema.Properties)
            {
                var isRequired = inputSchema.Required?.Contains(prop.Key) ?? false;
                var parameterMetadata = new KernelParameterMetadata(prop.Key)
                {
                    Description = prop.Value.Description,
                    IsRequired = isRequired,
                    DefaultValue = isRequired ? null : ""
                };
                
                parameters.Add(parameterMetadata);
            }
        }
        
        return parameters;
    }
}
