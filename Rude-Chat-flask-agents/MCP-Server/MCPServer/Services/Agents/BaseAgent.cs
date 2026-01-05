using MCPServer.Models;

namespace MCPServer.Services.Agents;

/// <summary>
/// Base abstract class for all agents providing common functionality
/// </summary>
public abstract class BaseAgent : IAgent
{
    protected readonly ILogger _logger;
    protected readonly IConfiguration _configuration;
    protected string? _userToken;
    protected DateTime _lastHealthCheck = DateTime.MinValue;
    protected AgentHealthStatus? _cachedHealthStatus;

    protected BaseAgent(ILogger logger, IConfiguration configuration)
    {
        _logger = logger;
        _configuration = configuration;
    }

    public abstract string AgentId { get; }
    public abstract string Name { get; }
    public abstract string Description { get; }
    public abstract IEnumerable<string> Domains { get; }

    public virtual async Task InitializeAsync(string? userToken = null)
    {
        _userToken = userToken;
        _logger.LogInformation("Initializing agent {AgentId} with user token", AgentId);
        await OnInitializeAsync(userToken);
    }

    public abstract Task<IEnumerable<McpTool>> GetAvailableToolsAsync();
    
    public abstract Task<McpToolCallResponse> ExecuteToolAsync(McpToolCallRequest request);

    public virtual async Task<bool> CanHandleToolAsync(string toolName)
    {
        var availableTools = await GetAvailableToolsAsync();
        return availableTools.Any(tool => tool.Name == toolName);
    }

    public virtual async Task<AgentHealthStatus> GetHealthStatusAsync()
    {
        // Cache health status for 30 seconds to avoid excessive health checks
        if (_cachedHealthStatus != null && 
            DateTime.UtcNow.Subtract(_lastHealthCheck).TotalSeconds < 30)
        {
            return _cachedHealthStatus;
        }

        try
        {
            var isHealthy = await PerformHealthCheckAsync();
            _cachedHealthStatus = new AgentHealthStatus
            {
                AgentId = AgentId,
                IsHealthy = isHealthy,
                Status = isHealthy ? "Healthy" : "Unhealthy",
                LastChecked = DateTime.UtcNow,
                Metadata = await GetHealthMetadataAsync()
            };
            _lastHealthCheck = DateTime.UtcNow;
            
            return _cachedHealthStatus;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Health check failed for agent {AgentId}", AgentId);
            _cachedHealthStatus = new AgentHealthStatus
            {
                AgentId = AgentId,
                IsHealthy = false,
                Status = $"Error: {ex.Message}",
                LastChecked = DateTime.UtcNow
            };
            _lastHealthCheck = DateTime.UtcNow;
            
            return _cachedHealthStatus;
        }
    }

    /// <summary>
    /// Override this method to perform agent-specific initialization
    /// </summary>
    protected virtual Task OnInitializeAsync(string? userToken) => Task.CompletedTask;

    /// <summary>
    /// Override this method to perform agent-specific health checks
    /// </summary>
    protected virtual Task<bool> PerformHealthCheckAsync() => Task.FromResult(true);

    /// <summary>
    /// Override this method to provide agent-specific health metadata
    /// </summary>
    protected virtual Task<Dictionary<string, object>> GetHealthMetadataAsync() => 
        Task.FromResult(new Dictionary<string, object>());

    /// <summary>
    /// Helper method to create standardized error responses
    /// </summary>
    protected McpToolCallResponse CreateErrorResponse(string message, Exception? ex = null)
    {
        var errorMessage = ex != null ? $"{message}: {ex.Message}" : message;
        _logger.LogError(ex, "Agent {AgentId} error: {Message}", AgentId, message);
        
        return new McpToolCallResponse
        {
            Content = new[]
            {
                new McpContent
                {
                    Type = "text",
                    Text = errorMessage
                }
            },
            IsError = true
        };
    }

    /// <summary>
    /// Helper method to create standardized success responses
    /// </summary>
    protected McpToolCallResponse CreateSuccessResponse(string message)
    {
        return new McpToolCallResponse
        {
            Content = new[]
            {
                new McpContent
                {
                    Type = "text",
                    Text = message
                }
            },
            IsError = false
        };
    }
}
