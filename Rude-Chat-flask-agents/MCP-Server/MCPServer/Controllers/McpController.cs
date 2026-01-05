using Microsoft.AspNetCore.Mvc;
using MCPServer.Models;
using MCPServer.Services;

namespace MCPServer.Controllers;

[ApiController]
[Route("api/mcp")]
public class McpController : ControllerBase
{
    private readonly IToolService _toolService;
    private readonly ILogger<McpController> _logger;

    public McpController(IToolService toolService, ILogger<McpController> logger)
    {
        _toolService = toolService;
        _logger = logger;
    }

    [HttpGet("server/info")]
    public ActionResult<McpServerInfo> GetServerInfo()
    {
        var serverInfo = new McpServerInfo
        {
            Name = "Azure MCP Server",
            Version = "1.0.0",
            Capabilities = new McpCapabilities
            {
                Tools = new McpToolCapabilities
                {
                    ListChanged = false
                }
            }
        };

        return Ok(serverInfo);
    }

    [HttpGet("tools/list")]
    public async Task<ActionResult<IEnumerable<McpTool>>> GetTools()
    {
        try
        {
            var tools = await _toolService.GetAvailableToolsAsync();
            return Ok(tools);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error retrieving tools list");
            return StatusCode(500, "Internal server error while retrieving tools");
        }
    }    [HttpPost("tools/call")]
    public async Task<ActionResult<McpToolCallResponse>> CallTool([FromBody] McpToolCallRequest request)
    {
        try
        {
            _logger.LogInformation("Received tool call request: {Request}", System.Text.Json.JsonSerializer.Serialize(request));
            
            if (string.IsNullOrEmpty(request?.Name))
            {
                _logger.LogWarning("Tool name is required but was null or empty");
                return BadRequest("Tool name is required");
            }

            // Extract user's Azure access token from headers
            string? userToken = null;
            if (Request.Headers.TryGetValue("X-User-Token", out var tokenValues))
            {
                userToken = tokenValues.FirstOrDefault();
                _logger.LogInformation("User token received for Azure delegation");
            }
            else
            {
                _logger.LogWarning("No user token provided - Azure tools may not work");
            }

            var response = await _toolService.ExecuteToolAsync(request, userToken);
            
            _logger.LogInformation("Tool call response: {Response}", System.Text.Json.JsonSerializer.Serialize(response));
            
            if (response.IsError)
            {
                return BadRequest(response);
            }

            return Ok(response);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error executing tool {ToolName}", request?.Name);
            return StatusCode(500, new McpToolCallResponse
            {
                Content = new[]
                {
                    new McpContent
                    {
                        Type = "text",
                        Text = $"Internal server error: {ex.Message}"
                    }
                },
                IsError = true
            });
        }
    }[HttpGet("health")]
    public ActionResult GetHealth()
    {
        return Ok(new { status = "healthy", timestamp = DateTime.UtcNow });
    }

    [HttpPost("test")]
    public ActionResult TestPost([FromBody] object request)
    {
        _logger.LogInformation("Test endpoint received: {Request}", System.Text.Json.JsonSerializer.Serialize(request));
        return Ok(new { received = request, timestamp = DateTime.UtcNow });
    }
}
