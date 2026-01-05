using MCPServer.Models;
using MCPServer.Services.Azure;

namespace MCPServer.Services.Agents;

/// <summary>
/// Specialized agent for Azure resource management operations.
/// Handles resource groups, storage accounts, and general Azure resources.
/// </summary>
public class ResourcesAgent : BaseAgent
{
    private readonly AzureResourceToolService _resourceService;

    public ResourcesAgent(
        ILogger<ResourcesAgent> logger, 
        IConfiguration configuration,
        AzureResourceToolService resourceService) 
        : base(logger, configuration)
    {
        _resourceService = resourceService;
    }

    public override string AgentId => "resources-agent";
    public override string Name => "Azure Resources Agent";
    public override string Description => "Specialized agent for Azure resource management including resource groups, storage accounts, and general Azure operations";
    public override IEnumerable<string> Domains => new[] { "azure", "resources", "management", "storage", "infrastructure" };

    protected override async Task OnInitializeAsync(string? userToken)
    {
        _logger.LogInformation("Initializing Resources Agent with user token");
        await _resourceService.InitializeWithUserTokenAsync(userToken ?? string.Empty);
    }

    public override async Task<IEnumerable<McpTool>> GetAvailableToolsAsync()
    {
        try
        {
            var allTools = await _resourceService.GetAvailableToolsAsync();
            var resourceTools = allTools.Where(IsResourceManagementTool);
            _logger.LogDebug("Resources Agent providing {ToolCount} tools", resourceTools.Count());
            return resourceTools;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to get Resources tools");
            return Enumerable.Empty<McpTool>();
        }
    }

    public override async Task<McpToolCallResponse> ExecuteToolAsync(McpToolCallRequest request)
    {
        _logger.LogInformation("Resources Agent executing tool: {ToolName}", request.Name);

        try
        {
            // Validate that this is a resource management tool
            if (!IsResourceManagementTool(request.Name))
            {
                return CreateErrorResponse($"Tool {request.Name} is not a resource management tool");
            }

            // Execute through the resource service
            var result = await _resourceService.ExecuteToolAsync(request);
            
            _logger.LogDebug("Resources Agent successfully executed tool {ToolName}", request.Name);
            return result;
        }
        catch (Exception ex)
        {
            return CreateErrorResponse($"Resources Agent failed to execute tool {request.Name}", ex);
        }
    }

    public override Task<bool> CanHandleToolAsync(string toolName)
    {
        return Task.FromResult(IsResourceManagementTool(toolName));
    }

    protected override async Task<bool> PerformHealthCheckAsync()
    {
        try
        {
            // Try to get available tools as a health check
            var tools = await GetAvailableToolsAsync();
            return tools.Any();
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Resources Agent health check failed");
            return false;
        }
    }

    protected override async Task<Dictionary<string, object>> GetHealthMetadataAsync()
    {
        var metadata = new Dictionary<string, object>
        {
            ["service_type"] = "Azure Resource Management",
            ["subscription_id"] = _configuration["Azure:SubscriptionId"] ?? "Not configured"
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

    private static bool IsResourceManagementTool(string toolName)
    {
        return toolName switch
        {
            "list_resource_groups" => true,
            "list_storage_accounts" => true,
            "create_resource_group" => true,
            _ => false
        };
    }

    private static bool IsResourceManagementTool(McpTool tool)
    {
        return IsResourceManagementTool(tool.Name);
    }

    /// <summary>
    /// Resources-specific method to suggest resource management operations
    /// </summary>
    public Task<McpToolCallResponse> SuggestResourceOperationsAsync(string context)
    {
        try
        {
            _logger.LogInformation("Resources Agent providing suggestions for context: {Context}", context);

            var suggestions = new List<string>();

            if (context.ToLower().Contains("resource group") || context.ToLower().Contains("rg"))
            {
                suggestions.Add("Use: list_resource_groups to see all resource groups");
                suggestions.Add("Use: create_resource_group to create a new resource group");
                suggestions.Add("Example: create_resource_group with name 'my-rg' in 'East US'");
            }

            if (context.ToLower().Contains("storage") || context.ToLower().Contains("blob"))
            {
                suggestions.Add("Use: list_storage_accounts to see storage accounts in a resource group");
                suggestions.Add("First get resource groups, then list storage accounts in specific group");
            }

            if (context.ToLower().Contains("list") || context.ToLower().Contains("show"))
            {
                suggestions.Add("Start with: list_resource_groups to see available resource groups");
                suggestions.Add("Then: list_storage_accounts in specific resource group");
            }

            if (!suggestions.Any())
            {
                suggestions.Add("Available operations:");
                suggestions.Add("• list_resource_groups - View all resource groups");
                suggestions.Add("• list_storage_accounts - View storage accounts in a resource group");
                suggestions.Add("• create_resource_group - Create new resource group");
            }

            var suggestionText = "☁️ **Resources Agent Suggestions:**\n\n" + 
                               string.Join("\n", suggestions.Select((s, i) => $"{i + 1}. {s}"));

            return Task.FromResult(CreateSuccessResponse(suggestionText));
        }
        catch (Exception ex)
        {
            return Task.FromResult(CreateErrorResponse("Failed to generate Resources suggestions", ex));
        }
    }
}
