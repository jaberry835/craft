using MCPServer.Models;

namespace MCPServer.Services.Agents;

/// <summary>
/// Core agent for basic system tools and general-purpose functionality.
/// Handles tools that don't belong to specific domain areas.
/// </summary>
public class CoreAgent : BaseAgent
{
    public CoreAgent(
        ILogger<CoreAgent> logger, 
        IConfiguration configuration) 
        : base(logger, configuration)
    {
    }

    public override string AgentId => "core-agent";
    public override string Name => "Core Agent";
    public override string Description => "Core agent for basic system tools and general-purpose functionality";
    public override IEnumerable<string> Domains => new[] { "core", "system", "basic", "general" };

    protected override Task OnInitializeAsync(string? userToken)
    {
        _logger.LogInformation("Initializing Core Agent");
        return Task.CompletedTask;
    }

    public override Task<IEnumerable<McpTool>> GetAvailableToolsAsync()
    {
        try
        {
            var tools = new List<McpTool>
            {
                new McpTool
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
                },
                new McpTool
                {
                    Name = "system_info",
                    Description = "Get information about the MCP server system and available agents",
                    InputSchema = new McpToolInputSchema
                    {
                        Type = "object",
                        Properties = new Dictionary<string, McpProperty>(),
                        Required = Array.Empty<string>()
                    }
                }
            };

            _logger.LogDebug("Core Agent providing {ToolCount} tools", tools.Count);
            return Task.FromResult<IEnumerable<McpTool>>(tools);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to get Core tools");
            return Task.FromResult(Enumerable.Empty<McpTool>());
        }
    }

    public override Task<McpToolCallResponse> ExecuteToolAsync(McpToolCallRequest request)
    {
        _logger.LogInformation("Core Agent executing tool: {ToolName}", request.Name);

        try
        {
            return request.Name switch
            {
                "hello_world" => ExecuteHelloWorldAsync(request.Arguments),
                "system_info" => ExecuteSystemInfoAsync(request.Arguments),
                _ => Task.FromResult(CreateErrorResponse($"Unknown core tool: {request.Name}"))
            };
        }
        catch (Exception ex)
        {
            return Task.FromResult(CreateErrorResponse($"Core Agent failed to execute tool {request.Name}", ex));
        }
    }

    public override Task<bool> CanHandleToolAsync(string toolName)
    {
        return Task.FromResult(IsCoreTool(toolName));
    }

    protected override Task<bool> PerformHealthCheckAsync()
    {
        // Core agent is always healthy as it doesn't depend on external services
        return Task.FromResult(true);
    }

    protected override Task<Dictionary<string, object>> GetHealthMetadataAsync()
    {
        var metadata = new Dictionary<string, object>
        {
            ["service_type"] = "Core System",
            ["version"] = "1.0.0",
            ["startup_time"] = DateTime.UtcNow.ToString("yyyy-MM-dd HH:mm:ss UTC")
        };

        return Task.FromResult(metadata);
    }

    private Task<McpToolCallResponse> ExecuteHelloWorldAsync(Dictionary<string, object> arguments)
    {
        var name = arguments.GetValueOrDefault("name", "World")?.ToString() ?? "World";
        
        var response = CreateSuccessResponse($"Hello, {name}! This is a greeting from the Azure MCP Server Core Agent.");
        return Task.FromResult(response);
    }

    private Task<McpToolCallResponse> ExecuteSystemInfoAsync(Dictionary<string, object> arguments)
    {
        var systemInfo = "🤖 **Azure MCP Server System Information**\n\n";
        systemInfo += "**Architecture:** Agent-based modular design\n";
        systemInfo += "**Available Agent Domains:**\n";
        systemInfo += "• Core - Basic system tools\n";
        systemInfo += "• ADX - Azure Data Explorer operations\n";
        systemInfo += "• Maps - Azure Maps and location services\n";
        systemInfo += "• Documents - Document management and search\n";
        systemInfo += "• Resources - Azure resource management\n\n";
        systemInfo += "**Features:**\n";
        systemInfo += "• User-based authentication with On-Behalf-Of flow\n";
        systemInfo += "• Dynamic tool execution with unlimited chaining\n";
        systemInfo += "• Agent health monitoring\n";
        systemInfo += "• Extensible architecture for new domains\n\n";
        systemInfo += "Use agent-specific tools or ask for suggestions to get started!";

        var response = CreateSuccessResponse(systemInfo);
        return Task.FromResult(response);
    }

    private static bool IsCoreTool(string toolName)
    {
        return toolName switch
        {
            "hello_world" => true,
            "system_info" => true,
            _ => false
        };
    }
}
