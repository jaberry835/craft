using MCPServer.Models;

namespace MCPServer.Services.Agents;

public interface IAgentOrchestrator
{
    Task<(ChatMessage message, List<AgentInteraction> interactions)> ProcessChatAsync(ChatCompletionRequest request);
}
