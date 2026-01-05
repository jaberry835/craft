using Microsoft.AspNetCore.SignalR;

namespace MCPServer.Hubs;

public class AgentActivityHub : Hub
{
    public async Task JoinGroup(string sessionId)
    {
        await Groups.AddToGroupAsync(Context.ConnectionId, sessionId);
    }

    public async Task LeaveGroup(string sessionId)
    {
        await Groups.RemoveFromGroupAsync(Context.ConnectionId, sessionId);
    }
}
