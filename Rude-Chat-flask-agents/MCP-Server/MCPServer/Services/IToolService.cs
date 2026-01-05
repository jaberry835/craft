using MCPServer.Models;

namespace MCPServer.Services;

public interface IToolService
{
    Task<IEnumerable<McpTool>> GetAvailableToolsAsync();
    Task<McpToolCallResponse> ExecuteToolAsync(McpToolCallRequest request, string? userToken = null);
}
