using MCPServer.Models;
using MCPServer.Services.Agents;

namespace MCPServer.Services;

/// <summary>
/// Updated ToolService that uses the agent-based architecture for tool execution.
/// This service acts as a facade over the AgentManager for backward compatibility.
/// </summary>
public class AgentBasedToolService : IToolService
{
    private readonly ILogger<AgentBasedToolService> _logger;
    private readonly IAgentManager _agentManager;

    public AgentBasedToolService(
        ILogger<AgentBasedToolService> logger, 
        IAgentManager agentManager)
    {
        _logger = logger;
        _agentManager = agentManager;
    }

    public async Task<IEnumerable<McpTool>> GetAvailableToolsAsync()
    {
        try
        {
            _logger.LogInformation("Getting all available tools from agent manager");
            var tools = await _agentManager.GetAllAvailableToolsAsync();
            _logger.LogInformation("Retrieved {ToolCount} total tools from all agents", tools.Count());
            return tools;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting available tools from agent manager");
            return Enumerable.Empty<McpTool>();
        }
    }

    public async Task<McpToolCallResponse> ExecuteToolAsync(McpToolCallRequest request, string? userToken = null)
    {
        try
        {
            _logger.LogInformation("Executing tool {ToolName} via agent manager", request.Name);
            
            // Initialize all agents with user token if provided
            if (!string.IsNullOrEmpty(userToken))
            {
                await _agentManager.InitializeAllAgentsAsync(userToken);
            }

            // Execute the tool through the agent manager
            var result = await _agentManager.ExecuteToolAsync(request, userToken);
            
            _logger.LogDebug("Tool {ToolName} execution completed with result: {IsError}", 
                request.Name, result.IsError);
            
            return result;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error executing tool {ToolName} via agent manager", request.Name);
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
    }

    /// <summary>
    /// Get information about all registered agents and their health status
    /// </summary>
    public async Task<McpToolCallResponse> GetAgentStatusAsync()
    {
        try
        {
            var agents = await _agentManager.GetAllAgentsAsync();
            var healthStatuses = await _agentManager.GetAllAgentHealthAsync();

            var statusText = "🤖 **Agent Manager Status**\n\n";
            statusText += $"**Total Agents:** {agents.Count()}\n\n";

            foreach (var agent in agents)
            {
                var health = healthStatuses.FirstOrDefault(h => h.AgentId == agent.AgentId);
                var healthIcon = health?.IsHealthy == true ? "✅" : "❌";
                
                statusText += $"{healthIcon} **{agent.Name}** ({agent.AgentId})\n";
                statusText += $"• Description: {agent.Description}\n";
                statusText += $"• Domains: {string.Join(", ", agent.Domains)}\n";
                statusText += $"• Status: {health?.Status ?? "Unknown"}\n";
                statusText += $"• Last Checked: {health?.LastChecked:yyyy-MM-dd HH:mm:ss}\n\n";
            }

            return new McpToolCallResponse
            {
                Content = new[]
                {
                    new McpContent
                    {
                        Type = "text",
                        Text = statusText
                    }
                },
                IsError = false
            };
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error getting agent status");
            return new McpToolCallResponse
            {
                Content = new[]
                {
                    new McpContent
                    {
                        Type = "text",
                        Text = $"Error getting agent status: {ex.Message}"
                    }
                },
                IsError = true
            };
        }
    }
}
