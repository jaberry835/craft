using MCPServer.Models;

namespace MCPServer.Services.Azure;

public interface IAzureToolService
{
    Task<IEnumerable<McpTool>> GetAvailableToolsAsync();
    Task<McpToolCallResponse> ExecuteToolAsync(McpToolCallRequest request);
    Task InitializeWithUserTokenAsync(string userToken);
}
