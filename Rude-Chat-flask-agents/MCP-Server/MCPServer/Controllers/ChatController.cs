using Microsoft.AspNetCore.Mvc;
using MCPServer.Models;
using MCPServer.Services.Azure;
using MCPServer.Services;
using MCPServer.Services.Agents;
using System.Text.Json;
using System.Text;

namespace MCPServer.Controllers;

[ApiController]
[Route("api/[controller]")]
public class ChatController : ControllerBase
{    private readonly IChatHistoryService _chatHistoryService;
    private readonly ILogger<ChatController> _logger;
    private readonly IConfiguration _configuration;
    private readonly IToolService _toolService;
    private readonly ISemanticKernelChatService _semanticKernelChatService;
    private readonly IAgentOrchestrator _agentOrchestrator;

    public ChatController(
        IChatHistoryService chatHistoryService,
        ILogger<ChatController> logger,
        IConfiguration configuration,
        IToolService toolService,
        ISemanticKernelChatService semanticKernelChatService,
        IAgentOrchestrator agentOrchestrator)    {
        _chatHistoryService = chatHistoryService;
        _logger = logger;
        _configuration = configuration;
        _toolService = toolService;
        _semanticKernelChatService = semanticKernelChatService;
        _agentOrchestrator = agentOrchestrator;
    }

    [HttpPost("message")]
    public async Task<ActionResult<string>> SaveMessage([FromBody] ChatMessage message)
    {
        try
        {
            _logger.LogInformation("Saving message for session {SessionId}", message.SessionId);
            
            var messageId = await _chatHistoryService.SaveMessageAsync(message);
            
            return Ok(new { messageId });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error saving message");
            return StatusCode(500, new { error = "Failed to save message" });
        }
    }

    [HttpGet("history")]
    public async Task<ActionResult<ChatHistoryResponse>> GetChatHistory(
        [FromQuery] string userId,
        [FromQuery] string sessionId,
        [FromQuery] int pageSize = 50,
        [FromQuery] string? continuationToken = null)
    {
        try
        {
            _logger.LogInformation("Getting chat history for session {SessionId}", sessionId);
            
            var request = new ChatHistoryRequest
            {
                UserId = userId,
                SessionId = sessionId,
                PageSize = pageSize,
                ContinuationToken = continuationToken
            };

            var response = await _chatHistoryService.GetChatHistoryAsync(request);
            
            return Ok(response);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error retrieving chat history for session {SessionId}", sessionId);
            return StatusCode(500, new { error = "Failed to retrieve chat history" });
        }
    }

    [HttpPost("session")]
    public async Task<ActionResult<string>> CreateSession([FromBody] CreateSessionRequest request)
    {
        try
        {
            _logger.LogInformation("Creating session for user {UserId}", request.UserId);
            
            var sessionId = await _chatHistoryService.CreateSessionAsync(request.UserId, request.Title);
            
            return Ok(new { sessionId });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error creating session for user {UserId}", request.UserId);
            return StatusCode(500, new { error = "Failed to create session" });
        }
    }

    [HttpGet("sessions")]
    public async Task<ActionResult<SessionListResponse>> GetSessions(
        [FromQuery] string userId,
        [FromQuery] int pageSize = 20,
        [FromQuery] string? continuationToken = null,
        [FromQuery] bool includeArchived = false)
    {
        try
        {
            _logger.LogInformation("Getting sessions for user {UserId}", userId);
            
            var request = new SessionListRequest
            {
                UserId = userId,
                PageSize = pageSize,
                ContinuationToken = continuationToken,
                IncludeArchived = includeArchived
            };

            var response = await _chatHistoryService.GetUserSessionsAsync(request);
            
            return Ok(response);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error retrieving sessions for user {UserId}", userId);
            return StatusCode(500, new { error = "Failed to retrieve sessions" });
        }
    }    [HttpPut("session/{sessionId}")]
    public async Task<ActionResult> UpdateSession(string sessionId, [FromBody] ChatSession session)
    {
        try
        {
            if (sessionId != session.Id)
            {
                return BadRequest("Session ID mismatch");
            }

            _logger.LogInformation("Updating session title: {SessionId} -> {Title}", sessionId, session.Title);
            
            // Only update the title to avoid overwriting the Documents array
            await _chatHistoryService.UpdateSessionTitleAsync(session.UserId, sessionId, session.Title);
            
            return Ok();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error updating session {SessionId}", sessionId);
            return StatusCode(500, new { error = "Failed to update session" });
        }
    }

    [HttpDelete("session/{sessionId}")]
    public async Task<ActionResult> DeleteSession(string sessionId, [FromQuery] string userId)
    {
        try
        {
            _logger.LogInformation("Deleting session {SessionId}", sessionId);
            
            await _chatHistoryService.DeleteSessionAsync(userId, sessionId);
            
            return Ok();
        }        catch (Exception ex)
        {
            _logger.LogError(ex, "Error deleting session {SessionId}", sessionId);
            return StatusCode(500, new { error = "Failed to delete session" });
        }
    }    [HttpPost("completions")]
    public async Task<ActionResult> GetChatCompletion([FromBody] ChatCompletionRequest request)
    {        try
        {
            _logger.LogInformation("Processing chat completion with Agent Orchestrator for session {SessionId}", request.SessionId);

            // Use the new Agent Orchestrator
            var (responseMessage, agentInteractions) = await _agentOrchestrator.ProcessChatAsync(request);

            var response = new ChatCompletionResponse
            {
                Message = responseMessage,
                AgentInteractions = agentInteractions
            };

            return Ok(response);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error processing chat completion for session {SessionId}", request.SessionId);            return StatusCode(500, new { error = "Failed to process chat completion" });
        }
    }
}

public class CreateSessionRequest
{
    public string UserId { get; set; } = string.Empty;
    public string Title { get; set; } = string.Empty;
}
