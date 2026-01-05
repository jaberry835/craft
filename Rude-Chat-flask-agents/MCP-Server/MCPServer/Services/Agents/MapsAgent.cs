using MCPServer.Models;
using MCPServer.Services.Azure;

namespace MCPServer.Services.Agents;

/// <summary>
/// Specialized agent for Azure Maps operations.
/// Handles geocoding, routing, and location-based services.
/// </summary>
public class MapsAgent : BaseAgent
{
    private readonly AzureResourceToolService _resourceService;

    public MapsAgent(
        ILogger<MapsAgent> logger, 
        IConfiguration configuration,
        AzureResourceToolService resourceService) 
        : base(logger, configuration)
    {
        _resourceService = resourceService;
    }

    public override string AgentId => "maps-agent";
    public override string Name => "Azure Maps Agent";
    public override string Description => "Specialized agent for Azure Maps operations including geocoding, routing, and location services";
    public override IEnumerable<string> Domains => new[] { "maps", "location", "geocoding", "routing", "navigation" };

    protected override async Task OnInitializeAsync(string? userToken)
    {
        _logger.LogInformation("Initializing Maps Agent with user token");
        await _resourceService.InitializeWithUserTokenAsync(userToken ?? string.Empty);
    }

    public override async Task<IEnumerable<McpTool>> GetAvailableToolsAsync()
    {
        try
        {
            var allTools = await _resourceService.GetAvailableToolsAsync();
            var mapsTools = allTools.Where(IsMapsRelatedTool);
            _logger.LogDebug("Maps Agent providing {ToolCount} tools", mapsTools.Count());
            return mapsTools;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to get Maps tools");
            return Enumerable.Empty<McpTool>();
        }
    }

    public override async Task<McpToolCallResponse> ExecuteToolAsync(McpToolCallRequest request)
    {
        _logger.LogInformation("Maps Agent executing tool: {ToolName}", request.Name);

        try
        {
            // Validate that this is a Maps tool
            if (!IsMapsRelatedTool(request.Name))
            {
                return CreateErrorResponse($"Tool {request.Name} is not a Maps tool");
            }

            // Execute through the resource service
            var result = await _resourceService.ExecuteToolAsync(request);
            
            _logger.LogDebug("Maps Agent successfully executed tool {ToolName}", request.Name);
            return result;
        }
        catch (Exception ex)
        {
            return CreateErrorResponse($"Maps Agent failed to execute tool {request.Name}", ex);
        }
    }

    public override Task<bool> CanHandleToolAsync(string toolName)
    {
        return Task.FromResult(IsMapsRelatedTool(toolName));
    }

    protected override async Task<bool> PerformHealthCheckAsync()
    {
        try
        {
            // Check if Azure Maps subscription key is configured
            var subscriptionKey = _configuration["AzureMaps:SubscriptionKey"];
            if (string.IsNullOrEmpty(subscriptionKey) || subscriptionKey.Contains("["))
            {
                return false;
            }

            // Try to get available tools as a health check
            var tools = await GetAvailableToolsAsync();
            return tools.Any();
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Maps Agent health check failed");
            return false;
        }
    }

    protected override async Task<Dictionary<string, object>> GetHealthMetadataAsync()
    {
        var metadata = new Dictionary<string, object>
        {
            ["service_type"] = "Azure Maps",
            ["base_url"] = _configuration["AzureMaps:BaseUrl"] ?? "https://atlas.microsoft.com",
            ["subscription_key_configured"] = !string.IsNullOrEmpty(_configuration["AzureMaps:SubscriptionKey"]) && 
                                            !_configuration["AzureMaps:SubscriptionKey"]!.Contains("[")
        };

        try
        {
            var tools = await GetAvailableToolsAsync();
            metadata["available_tools"] = tools.Count();
            metadata["tool_names"] = tools.Select(t => t.Name).ToArray();
        }
        catch (Exception ex)
        {
            metadata["tools_error"] = ex.Message;
        }

        return metadata;
    }

    private static bool IsMapsRelatedTool(string toolName)
    {
        return toolName switch
        {
            "geocode_address" => true,
            "get_route_directions" => true,
            "search_nearby_places" => true,
            _ => false
        };
    }

    private static bool IsMapsRelatedTool(McpTool tool)
    {
        return IsMapsRelatedTool(tool.Name);
    }

    /// <summary>
    /// Maps-specific method to suggest location-based queries
    /// </summary>
    public Task<McpToolCallResponse> SuggestLocationOperationsAsync(string context)
    {
        try
        {
            _logger.LogInformation("Maps Agent providing location suggestions for context: {Context}", context);

            var suggestions = new List<string>();

            if (context.ToLower().Contains("address") || context.ToLower().Contains("location"))
            {
                suggestions.Add("Use: geocode_address to convert addresses to coordinates");
                suggestions.Add("Example: geocode_address with '1600 Amphitheatre Parkway, Mountain View, CA'");
            }

            if (context.ToLower().Contains("directions") || context.ToLower().Contains("route"))
            {
                suggestions.Add("Use: get_route_directions for turn-by-turn directions");
                suggestions.Add("Example: get_route_directions from 'Seattle, WA' to 'Portland, OR'");
            }

            if (context.ToLower().Contains("nearby") || context.ToLower().Contains("search"))
            {
                suggestions.Add("Use: search_nearby_places to find points of interest");
                suggestions.Add("Example: search_nearby_places for 'restaurants' near 'downtown Seattle'");
            }

            if (!suggestions.Any())
            {
                suggestions.Add("Available operations:");
                suggestions.Add("• geocode_address - Convert addresses to coordinates");
                suggestions.Add("• get_route_directions - Get driving directions");
                suggestions.Add("• search_nearby_places - Find nearby points of interest");
            }

            var suggestionText = "🗺️ **Maps Agent Location Suggestions:**\n\n" + 
                               string.Join("\n", suggestions.Select((s, i) => $"{i + 1}. {s}"));

            return Task.FromResult(CreateSuccessResponse(suggestionText));
        }
        catch (Exception ex)
        {
            return Task.FromResult(CreateErrorResponse("Failed to generate Maps suggestions", ex));
        }
    }
}
