using MCPServer.Models;
using MCPServer.Services.Azure;

namespace MCPServer.Services.Agents;

/// <summary>
/// ADX (Azure Data Explorer) agent for data exploration and querying operations.
/// Handles Kusto queries and database schema discovery.
/// </summary>
public class AdxAgent : BaseAgent
{
    private readonly AzureDataExplorerToolService _adxService;

    public AdxAgent(
        ILogger<AdxAgent> logger, 
        IConfiguration configuration,
        AzureDataExplorerToolService adxService) 
        : base(logger, configuration)
    {
        _adxService = adxService;
    }

    public override string AgentId => "adx-agent";
    public override string Name => "ADX Agent";
    public override string Description => "Azure Data Explorer agent for data exploration, querying, and database operations";
    public override IEnumerable<string> Domains => new[] { "adx", "data-explorer", "kusto", "data", "query", "database" };

    protected override async Task OnInitializeAsync(string? userToken)
    {
        _logger.LogInformation("Initializing ADX Agent");
        if (_adxService != null && !string.IsNullOrEmpty(userToken))
        {
            await _adxService.InitializeWithUserTokenAsync(userToken);
        }
    }

    public override async Task<IEnumerable<McpTool>> GetAvailableToolsAsync()
    {
        _logger.LogInformation("ADX Agent getting available tools");
        
        try
        {
            var tools = await _adxService.GetAvailableToolsAsync();
            _logger.LogInformation("ADX Agent retrieved {Count} tools", tools.Count());
            return tools;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting ADX tools");
            return new List<McpTool>();
        }
    }

    public override async Task<McpToolCallResponse> ExecuteToolAsync(McpToolCallRequest request)
    {
        _logger.LogInformation("ADX Agent executing tool: {ToolName}", request.Name);
        
        try
        {
            var response = await _adxService.ExecuteToolAsync(request);
            _logger.LogInformation("ADX Agent tool {ToolName} completed successfully", request.Name);
            return response;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error executing ADX tool {ToolName}", request.Name);
            return new McpToolCallResponse
            {
                Content = new[]
                {
                    new McpContent
                    {
                        Type = "text",
                        Text = $"Error executing ADX tool {request.Name}: {ex.Message}"
                    }
                },
                IsError = true
            };
        }
    }

    public override async Task<bool> CanHandleToolAsync(string toolName)
    {
        try
        {
            var tools = await GetAvailableToolsAsync();
            return tools.Any(t => t.Name == toolName);
        }
        catch
        {
            return false;
        }
    }

    protected override async Task<bool> PerformHealthCheckAsync()
    {
        try
        {
            var tools = await GetAvailableToolsAsync();
            return tools.Any();
        }
        catch
        {
            return false;
        }
    }
}
