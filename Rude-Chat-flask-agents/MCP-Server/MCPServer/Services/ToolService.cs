using MCPServer.Models;
using MCPServer.Services.Azure;
using System.Text.Json;

namespace MCPServer.Services;

public class ToolService : IToolService
{
    private readonly ILogger<ToolService> _logger;
    private readonly IConfiguration _configuration;
    private readonly IEnumerable<IAzureToolService> _azureToolServices;

    public ToolService(
        ILogger<ToolService> logger, 
        IConfiguration configuration,
        IEnumerable<IAzureToolService> azureToolServices)
    {
        _logger = logger;
        _configuration = configuration;
        _azureToolServices = azureToolServices;
    }    public async Task<IEnumerable<McpTool>> GetAvailableToolsAsync()
    {
        var tools = new List<McpTool>();

        // Add Hello World Tool
        tools.Add(new McpTool
        {
            Name = "hello_world",
            Description = "A simple Hello World tool that greets the user",
            InputSchema = new McpToolInputSchema
            {
                Type = "object",
                Properties = new Dictionary<string, McpProperty>
                {
                    ["name"] = new McpProperty
                    {
                        Type = "string",
                        Description = "The name to greet"
                    }
                },
                Required = new[] { "name" }
            }
        });

        // Add all Azure tools from all Azure services
        foreach (var azureService in _azureToolServices)
        {
            var azureTools = await azureService.GetAvailableToolsAsync();
            tools.AddRange(azureTools);
        }

        return tools;
    }    public async Task<McpToolCallResponse> ExecuteToolAsync(McpToolCallRequest request, string? userToken = null)
    {
        try
        {
            _logger.LogInformation("Executing tool: {ToolName}", request.Name);

            // Handle Hello World tool locally
            if (request.Name == "hello_world")
            {
                return await ExecuteHelloWorldAsync(request.Arguments);
            }

            // Find the Azure service that has this tool
            foreach (var azureService in _azureToolServices)
            {
                // Initialize service with user token if provided
                if (!string.IsNullOrEmpty(userToken))
                {
                    await azureService.InitializeWithUserTokenAsync(userToken);
                }

                // Get available tools from this service
                var availableTools = await azureService.GetAvailableToolsAsync();
                
                // Check if this service has the requested tool
                if (availableTools.Any(tool => tool.Name == request.Name))
                {
                    return await azureService.ExecuteToolAsync(request);
                }
            }

            // Unknown tool
            return new McpToolCallResponse
            {
                Content = new[]
                {
                    new McpContent
                    {
                        Type = "text",
                        Text = $"Unknown tool: {request.Name}"
                    }
                },
                IsError = true
            };
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error executing tool {ToolName}", request.Name);
            return new McpToolCallResponse
            {
                Content = new[]
                {
                    new McpContent
                    {
                        Type = "text",
                        Text = $"Error executing tool {request.Name}: {ex.Message}"
                    }
                },
                IsError = true
            };
        }
    }private async Task<McpToolCallResponse> ExecuteHelloWorldAsync(Dictionary<string, object> arguments)
    {
        var name = arguments.GetValueOrDefault("name", "World")?.ToString() ?? "World";
        
        var response = new McpToolCallResponse
        {
            Content = new[]
            {
                new McpContent
                {
                    Type = "text",
                    Text = $"Hello, {name}! This is a greeting from the Azure MCP Server."
                }
            },
            IsError = false
        };

        return await Task.FromResult(response);
    }
}
