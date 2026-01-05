using System.Text.Json.Serialization;
using Newtonsoft.Json;

namespace MCPServer.Models;

public class ChatMessage
{
    [JsonPropertyName("id")]
    [JsonProperty("id")]
    public string Id { get; set; } = Guid.NewGuid().ToString();
    
    [JsonPropertyName("userId")]
    [JsonProperty("userId")]
    public string UserId { get; set; } = string.Empty;
    
    [JsonPropertyName("sessionId")]
    [JsonProperty("sessionId")]
    public string SessionId { get; set; } = string.Empty;
    
    [JsonPropertyName("role")]
    [JsonProperty("role")]
    public string Role { get; set; } = string.Empty; // "user" or "assistant"
    
    [JsonPropertyName("content")]
    [JsonProperty("content")]
    public string Content { get; set; } = string.Empty;
    
    [JsonPropertyName("timestamp")]
    [JsonProperty("timestamp")]
    public DateTime Timestamp { get; set; } = DateTime.UtcNow;
    
    [JsonPropertyName("parentMessageId")]
    [JsonProperty("parentMessageId")]
    public string? ParentMessageId { get; set; }
    
    [JsonPropertyName("metadata")]
    [JsonProperty("metadata")]
    public Dictionary<string, object>? Metadata { get; set; }
    
    [JsonPropertyName("_partitionKey")]
    [JsonProperty("_partitionKey")]
    public string PartitionKey => UserId;
}

public class ChatSession
{
    [JsonPropertyName("id")]
    [JsonProperty("id")]
    public string Id { get; set; } = Guid.NewGuid().ToString();
    
    [JsonPropertyName("userId")]
    [JsonProperty("userId")]
    public string UserId { get; set; } = string.Empty;
    
    [JsonPropertyName("title")]
    [JsonProperty("title")]
    public string Title { get; set; } = string.Empty;
    
    [JsonPropertyName("createdAt")]
    [JsonProperty("createdAt")]
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    
    [JsonPropertyName("lastMessageAt")]
    [JsonProperty("lastMessageAt")]
    public DateTime LastMessageAt { get; set; } = DateTime.UtcNow;
    
    [JsonPropertyName("messageCount")]
    [JsonProperty("messageCount")]
    public int MessageCount { get; set; } = 0;
      [JsonPropertyName("isArchived")]
    [JsonProperty("isArchived")]
    public bool IsArchived { get; set; } = false;
    
    [JsonPropertyName("documents")]
    [JsonProperty("documents")]
    public List<SessionDocument> Documents { get; set; } = new();
    
    [JsonPropertyName("_partitionKey")]
    [JsonProperty("_partitionKey")]
    public string PartitionKey => UserId;
}

public class ChatHistoryRequest
{
    public string UserId { get; set; } = string.Empty;
    public string SessionId { get; set; } = string.Empty;
    public int PageSize { get; set; } = 50;
    public string? ContinuationToken { get; set; }
}

public class ChatHistoryResponse
{
    public List<ChatMessage> Messages { get; set; } = new();
    public string? ContinuationToken { get; set; }
    public bool HasMore { get; set; }
    public int TotalCount { get; set; }
}

public class SessionListRequest
{
    public string UserId { get; set; } = string.Empty;
    public int PageSize { get; set; } = 20;
    public string? ContinuationToken { get; set; }
    public bool IncludeArchived { get; set; } = false;
}

public class SessionListResponse
{
    public List<ChatSession> Sessions { get; set; } = new();
    public string? ContinuationToken { get; set; }    public bool HasMore { get; set; }
}

public class SessionDocument
{
    [JsonPropertyName("documentId")]
    [JsonProperty("documentId")]
    public string DocumentId { get; set; } = string.Empty;
    
    [JsonPropertyName("fileName")]
    [JsonProperty("fileName")]
    public string FileName { get; set; } = string.Empty;
    
    [JsonPropertyName("fileSize")]
    [JsonProperty("fileSize")]
    public long FileSize { get; set; }
    
    [JsonPropertyName("blobUrl")]
    [JsonProperty("blobUrl")]
    public string BlobUrl { get; set; } = string.Empty;
    
    [JsonPropertyName("uploadDate")]
    [JsonProperty("uploadDate")]
    public DateTime UploadDate { get; set; } = DateTime.UtcNow;
    
    [JsonPropertyName("status")]
    [JsonProperty("status")]
    public int Status { get; set; } // DocumentStatus enum value
}

public class ChatCompletionRequest
{
    [JsonPropertyName("messages")]
    [JsonProperty("messages")]
    public List<ChatMessage> Messages { get; set; } = new();
    
    [JsonPropertyName("userId")]
    [JsonProperty("userId")]
    public string UserId { get; set; } = string.Empty;
    
    [JsonPropertyName("sessionId")]
    [JsonProperty("sessionId")]
    public string SessionId { get; set; } = string.Empty;
    
    [JsonPropertyName("useRAG")]
    [JsonProperty("useRAG")]
    public bool UseRAG { get; set; } = false;
    
    [JsonPropertyName("useMCPTools")]
    [JsonProperty("useMCPTools")]
    public bool UseMCPTools { get; set; } = false;
}

public class ChatCompletionResponse
{
    [JsonPropertyName("message")]
    [JsonProperty("message")]
    public ChatMessage Message { get; set; } = new();
    
    [JsonPropertyName("sources")]
    [JsonProperty("sources")]
    public List<object>? Sources { get; set; }
    
    [JsonPropertyName("toolCalls")]
    [JsonProperty("toolCalls")]
    public List<object>? ToolCalls { get; set; }
    
    [JsonPropertyName("agentInteractions")]
    [JsonProperty("agentInteractions")]
    public List<AgentInteraction>? AgentInteractions { get; set; }
}

public class AgentInteraction
{
    [JsonPropertyName("id")]
    [JsonProperty("id")]
    public string Id { get; set; } = Guid.NewGuid().ToString();
    
    [JsonPropertyName("agentName")]
    [JsonProperty("agentName")]
    public string AgentName { get; set; } = string.Empty;
    
    [JsonPropertyName("action")]
    [JsonProperty("action")]
    public string Action { get; set; } = string.Empty;
    
    [JsonPropertyName("result")]
    [JsonProperty("result")]
    public string Result { get; set; } = string.Empty;
    
    [JsonPropertyName("timestamp")]
    [JsonProperty("timestamp")]
    public DateTime Timestamp { get; set; } = DateTime.UtcNow;
    
    [JsonPropertyName("status")]
    [JsonProperty("status")]
    public string Status { get; set; } = "success"; // success, error, in-progress
    
    [JsonPropertyName("duration")]
    [JsonProperty("duration")]
    public TimeSpan? Duration { get; set; }
}
