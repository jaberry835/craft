using MCPServer.Models;

namespace MCPServer.Services.Agents;

/// <summary>
/// Base interface for all MCP agents. Each agent represents a domain area 
/// (e.g., ADX, Maps, Documents) and provides specialized functionality.
/// </summary>
public interface IAgent
{
    /// <summary>
    /// Unique identifier for this agent
    /// </summary>
    string AgentId { get; }
    
    /// <summary>
    /// Human-readable name for this agent
    /// </summary>
    string Name { get; }
    
    /// <summary>
    /// Description of what this agent handles
    /// </summary>
    string Description { get; }
    
    /// <summary>
    /// Domain areas this agent is responsible for (e.g., "adx", "maps", "documents")
    /// </summary>
    IEnumerable<string> Domains { get; }
    
    /// <summary>
    /// Initialize the agent with user credentials/tokens
    /// </summary>
    Task InitializeAsync(string? userToken = null);
    
    /// <summary>
    /// Get all tools that this agent can execute
    /// </summary>
    Task<IEnumerable<McpTool>> GetAvailableToolsAsync();
    
    /// <summary>
    /// Execute a tool request. Should only handle tools in the agent's domain.
    /// </summary>
    Task<McpToolCallResponse> ExecuteToolAsync(McpToolCallRequest request);
    
    /// <summary>
    /// Check if this agent can handle the specified tool
    /// </summary>
    Task<bool> CanHandleToolAsync(string toolName);
    
    /// <summary>
    /// Get agent health/status information
    /// </summary>
    Task<AgentHealthStatus> GetHealthStatusAsync();
}

/// <summary>
/// Represents the health status of an agent
/// </summary>
public class AgentHealthStatus
{
    public string AgentId { get; set; } = string.Empty;
    public bool IsHealthy { get; set; }
    public string Status { get; set; } = string.Empty;
    public DateTime LastChecked { get; set; } = DateTime.UtcNow;
    public Dictionary<string, object> Metadata { get; set; } = new();
}
