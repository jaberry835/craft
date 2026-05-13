using System.Text.Json;
using System.Text.Json.Serialization;

namespace JuniorStudio.Agent;

internal static class Protocol
{
    public static readonly JsonSerializerOptions JsonOptions = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };
}

internal sealed class InboundMessage
{
    [JsonPropertyName("type")] public string? Type { get; set; }

    // configure
    [JsonPropertyName("endpoint")] public string? Endpoint { get; set; }
    [JsonPropertyName("apimBaseUrl")] public string? ApimBaseUrl { get; set; }
    [JsonPropertyName("openAICompatibleBaseUrl")] public string? OpenAICompatibleBaseUrl { get; set; }
    [JsonPropertyName("provider")] public string? Provider { get; set; }
    [JsonPropertyName("apiKey")] public string? ApiKey { get; set; }
    [JsonPropertyName("apiVersion")] public string? ApiVersion { get; set; }
    [JsonPropertyName("deployment")] public string? Deployment { get; set; }
    [JsonPropertyName("systemPrompt")] public string? SystemPrompt { get; set; }
    [JsonPropertyName("workspaceRoot")] public string? WorkspaceRoot { get; set; }
    [JsonPropertyName("scratchRoot")] public string? ScratchRoot { get; set; }
    /// <summary>Approval policy for write/create file tools: "auto" | "confirm" | "deny" (default: "confirm").</summary>
    [JsonPropertyName("approvalWrite")] public string? ApprovalWrite { get; set; }
    /// <summary>Approval policy for delete tool: "auto" | "confirm" | "deny" (default: "confirm").</summary>
    [JsonPropertyName("approvalDelete")] public string? ApprovalDelete { get; set; }
    /// <summary>Approval policy for shell tool: "auto" | "confirm" | "deny" (default: "confirm").</summary>
    [JsonPropertyName("approvalShell")] public string? ApprovalShell { get; set; }

    // sendMessage
    [JsonPropertyName("text")] public string? Text { get; set; }
    /// <summary>Chat mode for this turn: "agent" (default), "plan", or "ask".</summary>
    [JsonPropertyName("mode")] public string? Mode { get; set; }
    /// <summary>Image attachments as data URIs (e.g. data:image/png;base64,...).</summary>
    [JsonPropertyName("images")] public List<string>? Images { get; set; }
    /// <summary>Text-file attachments forwarded from the host.</summary>
    [JsonPropertyName("files")] public List<AttachedFile>? Files { get; set; }

    // approvalResponse
    /// <summary>Correlation id for an approval request.</summary>
    [JsonPropertyName("approvalId")] public string? ApprovalId { get; set; }
    /// <summary>True if the user allowed the pending action; false otherwise.</summary>
    [JsonPropertyName("allow")] public bool? Allow { get; set; }
    /// <summary>Optional scope hint: "once" (default) or "session" to switch the matching
    /// approval category to Auto for the remainder of the sidecar lifetime.</summary>
    [JsonPropertyName("scope")] public string? Scope { get; set; }
    /// <summary>Tool category for scope=session updates ("write" | "delete" | "shell").</summary>
    [JsonPropertyName("category")] public string? Category { get; set; }

    // seedHistory
    /// <summary>Prior conversation turns to seed the agent's in-memory history with so a
    /// restored session can continue. Each turn carries a role ("user"|"assistant") + text.</summary>
    [JsonPropertyName("turns")] public List<SeedTurn>? Turns { get; set; }
}

internal sealed class SeedTurn
{
    [JsonPropertyName("role")] public string? Role { get; set; }
    [JsonPropertyName("text")] public string? Text { get; set; }
}

internal sealed class AttachedFile
{
    [JsonPropertyName("name")] public string? Name { get; set; }
    [JsonPropertyName("content")] public string? Content { get; set; }
}
