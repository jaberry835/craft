using Microsoft.AspNetCore.SignalR;
using MCPServer.Hubs;
using MCPServer.Models;

namespace MCPServer.Services;

public interface IAgentActivityBroadcastService
{
    Task BroadcastAgentInteractionAsync(string sessionId, AgentInteraction interaction);
    Task BroadcastAgentStartedAsync(string sessionId, string agentName, string action);
    Task BroadcastAgentCompletedAsync(string sessionId, string agentName, string action, string? result = null, double? duration = null);
    Task BroadcastAgentErrorAsync(string sessionId, string agentName, string action, string error);
}

public class AgentActivityBroadcastService : IAgentActivityBroadcastService
{
    private readonly IHubContext<AgentActivityHub> _hubContext;
    private readonly ILogger<AgentActivityBroadcastService> _logger;

    public AgentActivityBroadcastService(
        IHubContext<AgentActivityHub> hubContext,
        ILogger<AgentActivityBroadcastService> logger)
    {
        _hubContext = hubContext;
        _logger = logger;
    }    public async Task BroadcastAgentInteractionAsync(string sessionId, AgentInteraction interaction)
    {
        try
        {
            _logger.LogInformation("Broadcasting agent interaction to SignalR clients in group {SessionId}: {AgentName} - {Action}", 
                sessionId, interaction.AgentName, interaction.Action);
            await _hubContext.Clients.Group(sessionId).SendAsync("AgentInteraction", interaction);
            _logger.LogDebug("Successfully broadcasted agent interaction for session {SessionId}: {AgentName} - {Action}", 
                sessionId, interaction.AgentName, interaction.Action);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to broadcast agent interaction for session {SessionId}", sessionId);
        }
    }

    public async Task BroadcastAgentStartedAsync(string sessionId, string agentName, string action)
    {
        var interaction = new AgentInteraction
        {
            Id = Guid.NewGuid().ToString(),
            AgentName = agentName,
            Action = action,
            Status = "in-progress",
            Timestamp = DateTime.UtcNow
        };

        await BroadcastAgentInteractionAsync(sessionId, interaction);
    }    public async Task BroadcastAgentCompletedAsync(string sessionId, string agentName, string action, string? result = null, double? duration = null)
    {
        var interaction = new AgentInteraction
        {
            Id = Guid.NewGuid().ToString(),
            AgentName = agentName,
            Action = action,
            Status = "completed",
            Timestamp = DateTime.UtcNow,
            Result = result ?? string.Empty,
            Duration = duration.HasValue ? TimeSpan.FromMilliseconds(duration.Value) : null
        };

        await BroadcastAgentInteractionAsync(sessionId, interaction);
    }

    public async Task BroadcastAgentErrorAsync(string sessionId, string agentName, string action, string error)
    {
        var interaction = new AgentInteraction
        {
            Id = Guid.NewGuid().ToString(),
            AgentName = agentName,
            Action = action,
            Status = "error",
            Timestamp = DateTime.UtcNow,
            Result = error
        };

        await BroadcastAgentInteractionAsync(sessionId, interaction);
    }
}
