using MCPServer.Models;

namespace MCPServer.Services.Agents;

/// <summary>
/// Registry and manager for all MCP agents. Handles agent discovery, 
/// routing, and inter-agent communication.
/// </summary>
public interface IAgentManager
{
    /// <summary>
    /// Register an agent with the manager
    /// </summary>
    Task RegisterAgentAsync(IAgent agent);
    
    /// <summary>
    /// Get all registered agents
    /// </summary>
    Task<IEnumerable<IAgent>> GetAllAgentsAsync();
    
    /// <summary>
    /// Get all available tools from all agents
    /// </summary>
    Task<IEnumerable<McpTool>> GetAllAvailableToolsAsync();
    
    /// <summary>
    /// Find the appropriate agent for a tool and execute it
    /// </summary>
    Task<McpToolCallResponse> ExecuteToolAsync(McpToolCallRequest request, string? userToken = null);
    
    /// <summary>
    /// Get agent by ID
    /// </summary>
    Task<IAgent?> GetAgentByIdAsync(string agentId);
    
    /// <summary>
    /// Get agents by domain
    /// </summary>
    Task<IEnumerable<IAgent>> GetAgentsByDomainAsync(string domain);
    
    /// <summary>
    /// Get health status of all agents
    /// </summary>
    Task<IEnumerable<AgentHealthStatus>> GetAllAgentHealthAsync();
    
    /// <summary>
    /// Initialize all agents with user token
    /// </summary>
    Task InitializeAllAgentsAsync(string? userToken = null);
}

public class AgentManager : IAgentManager
{
    private readonly ILogger<AgentManager> _logger;
    private readonly List<IAgent> _agents = new();
    private readonly SemaphoreSlim _agentsSemaphore = new(1, 1);

    public AgentManager(ILogger<AgentManager> logger)
    {
        _logger = logger;
    }

    public async Task RegisterAgentAsync(IAgent agent)
    {
        await _agentsSemaphore.WaitAsync();
        try
        {
            if (_agents.Any(a => a.AgentId == agent.AgentId))
            {
                _logger.LogWarning("Agent {AgentId} is already registered", agent.AgentId);
                return;
            }
            
            _agents.Add(agent);
            _logger.LogInformation("Registered agent {AgentId} ({Name}) for domains: {Domains}", 
                agent.AgentId, agent.Name, string.Join(", ", agent.Domains));
        }
        finally
        {
            _agentsSemaphore.Release();
        }
    }

    public async Task<IEnumerable<IAgent>> GetAllAgentsAsync()
    {
        await _agentsSemaphore.WaitAsync();
        try
        {
            return _agents.ToList(); // Return a copy to avoid concurrent modification
        }
        finally
        {
            _agentsSemaphore.Release();
        }
    }

    public async Task<IEnumerable<McpTool>> GetAllAvailableToolsAsync()
    {
        var agents = await GetAllAgentsAsync();
        var allTools = new List<McpTool>();

        foreach (var agent in agents)
        {
            try
            {
                var agentTools = await agent.GetAvailableToolsAsync();
                allTools.AddRange(agentTools);
                _logger.LogDebug("Agent {AgentId} provided {ToolCount} tools", 
                    agent.AgentId, agentTools.Count());
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to get tools from agent {AgentId}", agent.AgentId);
            }
        }

        _logger.LogInformation("Total available tools from all agents: {TotalTools}", allTools.Count);
        return allTools;
    }

    public async Task<McpToolCallResponse> ExecuteToolAsync(McpToolCallRequest request, string? userToken = null)
    {
        _logger.LogInformation("Executing tool {ToolName} via agent manager", request.Name);

        var agents = await GetAllAgentsAsync();
        
        // Find the first agent that can handle this tool
        foreach (var agent in agents)
        {
            try
            {
                if (await agent.CanHandleToolAsync(request.Name))
                {
                    _logger.LogInformation("Agent {AgentId} will handle tool {ToolName}", 
                        agent.AgentId, request.Name);
                    
                    // Initialize agent with user token if provided
                    if (!string.IsNullOrEmpty(userToken))
                    {
                        await agent.InitializeAsync(userToken);
                    }
                    
                    return await agent.ExecuteToolAsync(request);
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Agent {AgentId} failed to check if it can handle tool {ToolName}", 
                    agent.AgentId, request.Name);
            }
        }

        // No agent found for this tool
        _logger.LogWarning("No agent found to handle tool {ToolName}", request.Name);
        return new McpToolCallResponse
        {
            Content = new[]
            {
                new McpContent
                {
                    Type = "text",
                    Text = $"No agent available to handle tool: {request.Name}"
                }
            },
            IsError = true
        };
    }

    public async Task<IAgent?> GetAgentByIdAsync(string agentId)
    {
        var agents = await GetAllAgentsAsync();
        return agents.FirstOrDefault(a => a.AgentId == agentId);
    }

    public async Task<IEnumerable<IAgent>> GetAgentsByDomainAsync(string domain)
    {
        var agents = await GetAllAgentsAsync();
        return agents.Where(a => a.Domains.Contains(domain, StringComparer.OrdinalIgnoreCase));
    }

    public async Task<IEnumerable<AgentHealthStatus>> GetAllAgentHealthAsync()
    {
        var agents = await GetAllAgentsAsync();
        var healthStatuses = new List<AgentHealthStatus>();

        var healthTasks = agents.Select(async agent =>
        {
            try
            {
                return await agent.GetHealthStatusAsync();
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to get health status for agent {AgentId}", agent.AgentId);
                return new AgentHealthStatus
                {
                    AgentId = agent.AgentId,
                    IsHealthy = false,
                    Status = $"Health check failed: {ex.Message}",
                    LastChecked = DateTime.UtcNow
                };
            }
        });

        healthStatuses.AddRange(await Task.WhenAll(healthTasks));
        return healthStatuses;
    }

    public async Task InitializeAllAgentsAsync(string? userToken = null)
    {
        var agents = await GetAllAgentsAsync();
        _logger.LogInformation("Initializing {AgentCount} agents with user token", agents.Count());

        var initializationTasks = agents.Select(async agent =>
        {
            try
            {
                await agent.InitializeAsync(userToken);
                _logger.LogDebug("Successfully initialized agent {AgentId}", agent.AgentId);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to initialize agent {AgentId}", agent.AgentId);
            }
        });

        await Task.WhenAll(initializationTasks);
        _logger.LogInformation("Agent initialization completed");
    }
}
