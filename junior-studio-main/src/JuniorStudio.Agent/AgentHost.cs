using System.ClientModel;
using System.ClientModel.Primitives;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Azure.AI.OpenAI;
using Azure.Core;
using Azure.Identity;
using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;
using OpenAI;
using OpenAI.Responses;

namespace JuniorStudio.Agent;

internal sealed class AgentHost
{
    private const int MaxIterationsPerRequest = 40;
    private const int MaxStoredHistoryTurns = 30;

    private readonly Dictionary<string, AIAgent> agents = new(StringComparer.OrdinalIgnoreCase);
    private IChatClient? chatClient;
    private readonly List<ChatMessage> history = new();
    private readonly WorkspaceTools tools = new();
    private readonly McpClient mcpClient = new();
    private string baseSystemPrompt = DefaultAgentSystemPrompt;
    private ProviderAuthMode configuredAuthMode = ProviderAuthMode.ApiKey;
    private string configuredProvider = "Direct";
    private string configuredBaseUrl = string.Empty;
    private string configuredAuthorityHost = string.Empty;
    private string configuredTenantId = string.Empty;
    private string configuredDirectAudience = string.Empty;
    private string[] configuredScopes = Array.Empty<string>();
    private string lastRepoInstructionNoticeKey = string.Empty;
    private string lastTokenDiagnostics = string.Empty;
    private string configuredFingerprint = string.Empty;
    private JuniorEntraTokenCredential? configuredTokenCredential;
    private string configuredTokenCredentialFingerprint = string.Empty;

    private const string DefaultAgentSystemPrompt =
        "You are Junior, an autonomous AI coding assistant running inside Visual Studio. " +
        "You have tools to read, write, and create files in the user's workspace, list directories, search text, and run short shell commands. " +
        "When the user asks you to write code, scaffold a project, or modify files, USE THE TOOLS to make the changes — do not just print code in the chat.\n\n" +
        "AGENT LOOP RULES — these are critical:\n" +
        "1. Keep working autonomously until the user's task is fully complete. Do NOT stop after one or two tool calls and ask the user what to do next.\n" +
        "2. After each tool call, evaluate whether the task is done. If not, immediately make the next tool call.\n" +
        "3. For project scaffolding tasks: create the workspace folder, create EVERY file the project needs (csproj, source files, config files, README, .gitignore as appropriate), and only stop when the project would actually build and run.\n" +
        "4. Only return a final answer (no more tool calls) when the task is complete OR you genuinely need information only the user can provide.\n\n" +
        "OUTPUT STYLE:\n" +
        "- Narrate what you're about to do in ONE short sentence BEFORE each tool call (e.g. 'Scaffolding the project with dotnet new func...').\n" +
        "- End the entire turn with a brief summary of what changed and how to build/run/test it.\n" +
        "- Be concise. No filler.\n\n" +
        "WORKSPACE:\n" +
        "- Always operate inside the workspace root.\n" +
        "- A live workspace file index is provided as a system message at the start of every turn (see the 'Workspace overview' section). Consult it FIRST before listing directories.\n" +
        "- Use FindFiles to locate a file by partial name, ListWorkspaceFiles to enumerate by prefix, and GetWorkspaceTree to refresh your view if files were just added.\n" +
        "- For C# code: prefer FindSymbol to jump to a class/method/property declaration, GetFileOutline to see a file's shape before reading it, and FindSymbolReferences to find usages of an identifier. These are powered by a Roslyn syntax index that stays in sync with edits.\n" +
        "- Use GetDiagnostics to inspect Visual Studio Error List diagnostics before fixing compile errors, red squiggles, or build failures.\n" +
        "- For feature work or bug fixes, call SearchRelevantFiles early to find likely files before broad reading.\n" +
        "- For multi-location edits in one file, prefer ApplyPatch with multiple exact hunks so all preconditions are checked before writing. For one focused span, use ReplaceText; for line-targeted fixes, use ReplaceLines. Use WriteFile only when replacing most of a file or generating a new complete file.\n" +
        "- After creating or editing code, run ValidateWorkspace (or a targeted build/test command through RunShell) before finishing. If validation fails, inspect the diagnostics, fix the issue, and validate again.\n" +
        "- If no workspace is currently open, call CreateWorkspaceFolder('<name>') FIRST to bootstrap one before creating any files.";

    private const string PlanModeSystemPrompt =
        "You are Junior in PLAN MODE. Your job is to produce a clear, actionable implementation plan for the user's request — you must NOT modify the workspace.\n\n" +
        "PLAN MODE RULES:\n" +
        "1. You may use READ-ONLY tools (GetWorkspaceTree, ListWorkspaceFiles, FindFiles, SearchRelevantFiles, GetDiagnostics, ReadFile, ListDir, SearchText, GetWorkspaceRoot, FindSymbol, GetFileOutline, FindSymbolReferences) to investigate the codebase.\n" +
        "2. You MUST NOT call any write/create/delete/shell tools. They are not available in this mode.\n" +
        "3. Investigate first, then output ONE final plan and stop. Do not loop forever.\n\n" +
        "OUTPUT FORMAT:\n" +
        "- Start with a 1-2 sentence summary of what you understood and what the plan will accomplish.\n" +
        "- Follow with a numbered list of concrete steps (file paths, function names, commands the user would run).\n" +
        "- Call out risks, open questions, or assumptions in a final 'Notes' section.\n" +
        "- End by inviting the user to switch to Agent mode to execute the plan.";

    private const string AskModeSystemPrompt =
        "You are Junior in ASK MODE. Answer the user's question conversationally.\n\n" +
        "ASK MODE RULES:\n" +
        "1. You have NO tools. Do not pretend to read files, list directories, or run commands.\n" +
        "2. If the user's question requires inspecting their workspace, tell them to switch to Plan or Agent mode.\n" +
        "3. Keep answers focused and concise. Use code blocks for code, but do not invent file contents you have not been shown.";

    private CancellationTokenSource? currentCts;

    /// <summary>Raised when the agent creates a new workspace folder; payload is the absolute path.</summary>
    public event Action<string>? WorkspaceFolderCreated;

    public AgentHost()
    {
        tools.WorkspaceFolderCreated += path => WorkspaceFolderCreated?.Invoke(path);
    }

    /// <summary>Forwards an approval callback into the tool layer.</summary>
    public Func<string, string, CancellationToken, Task<bool>>? ApprovalCallback
    {
        get => tools.ApprovalCallback;
        set => tools.ApprovalCallback = value;
    }

    /// <summary>Sets the approval policy for a tool category at runtime.</summary>
    public void SetApprovalMode(string category, ApprovalMode mode)
    {
        switch ((category ?? string.Empty).Trim().ToLowerInvariant())
        {
            case "write": tools.ApprovalWrite = mode; break;
            case "delete": tools.ApprovalDelete = mode; break;
            case "shell": tools.ApprovalShell = mode; break;
        }
    }

    /// <summary>Drops in-process conversation history without disturbing the configured client/agents.</summary>
    public void ResetHistory()
    {
        history.Clear();
    }

    /// <summary>Replaces in-process conversation history with the supplied (role, text) turns
    /// so the model can pick up where a saved session left off.</summary>
    public void SeedHistory(IEnumerable<(string role, string text)> turns)
    {
        history.Clear();
        if (turns == null) return;
        foreach (var (role, text) in turns)
        {
            if (string.IsNullOrEmpty(text)) continue;
            var chatRole = string.Equals(role, "assistant", StringComparison.OrdinalIgnoreCase)
                ? ChatRole.Assistant
                : ChatRole.User;
            history.Add(new ChatMessage(chatRole, text));
        }
        TrimHistoryIfNeeded();
    }

    private static ApprovalMode ParseApprovalMode(string? value, ApprovalMode fallback)
    {
        if (string.IsNullOrWhiteSpace(value)) return fallback;
        return value!.Trim().ToLowerInvariant() switch
        {
            "auto" or "allow" or "always" => ApprovalMode.Auto,
            "deny" or "never" or "block" => ApprovalMode.Deny,
            _ => ApprovalMode.Confirm
        };
    }

    private static ProviderAuthMode ParseAuthMode(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return ProviderAuthMode.ApiKey;
        return value.Trim().ToLowerInvariant() switch
        {
            "bearer-token" or "bearertoken" or "bearer" => ProviderAuthMode.BearerToken,
            "entra-id" or "entraid" or "entra" or "aad" or "azure-ad" or "vscode-auth-session" => ProviderAuthMode.EntraId,
            _ => ProviderAuthMode.ApiKey
        };
    }

    private static string RequireValue(string? value, string message)
    {
        if (string.IsNullOrWhiteSpace(value)) throw new InvalidOperationException(message);
        return value.Trim();
    }

    private TokenCredential BuildTokenCredential(InboundMessage cfg)
    {
        var fingerprint = BuildCredentialFingerprint(cfg);
        if (configuredTokenCredential is not null && string.Equals(configuredTokenCredentialFingerprint, fingerprint, StringComparison.Ordinal))
        {
            try { Console.Error.WriteLine("AUTH: reusing warmed Entra credential chain."); } catch { }
            return configuredTokenCredential;
        }

        var tenantId = FirstNonEmpty(cfg.AuthTenantId, GetPseudoScopeValue(cfg.AuthScopes, "VSCODE_TENANT"));
        var clientId = FirstNonEmpty(cfg.AuthClientId, GetPseudoScopeValue(cfg.AuthScopes, "VSCODE_CLIENT_ID"));
        var authorityHost = ResolveAuthorityHost(cfg.AuthorityHost);

        var defaultOptions = new DefaultAzureCredentialOptions
        {
            AuthorityHost = authorityHost,
            TenantId = string.IsNullOrWhiteSpace(tenantId) ? null : tenantId,
            ExcludeInteractiveBrowserCredential = true
        };

        var interactiveOptions = new InteractiveBrowserCredentialOptions
        {
            AuthorityHost = authorityHost,
            TenantId = string.IsNullOrWhiteSpace(tenantId) ? null : tenantId,
            ClientId = string.IsNullOrWhiteSpace(clientId) ? null : clientId,
            TokenCachePersistenceOptions = CreateTokenCacheOptions()
        };

        configuredTokenCredential = new JuniorEntraTokenCredential(
            new DefaultAzureCredential(defaultOptions),
            new InteractiveBrowserCredential(interactiveOptions));
        configuredTokenCredentialFingerprint = fingerprint;
        return configuredTokenCredential;
    }

    private static string BuildCredentialFingerprint(InboundMessage cfg)
    {
        return string.Join("\u001f", new[]
        {
            ResolveAuthorityHost(cfg.AuthorityHost).ToString(),
            FirstNonEmpty(cfg.AuthTenantId, GetPseudoScopeValue(cfg.AuthScopes, "VSCODE_TENANT")) ?? string.Empty,
            FirstNonEmpty(cfg.AuthClientId, GetPseudoScopeValue(cfg.AuthScopes, "VSCODE_CLIENT_ID")) ?? string.Empty
        });
    }

    private static TokenCachePersistenceOptions CreateTokenCacheOptions()
    {
        return new TokenCachePersistenceOptions
        {
            Name = "JuniorStudio"
        };
    }

    private static string[] BuildTokenScopes(InboundMessage cfg)
    {
        var scopes = GetConfiguredScopes(cfg.AuthScopes);

        if (scopes.Length == 0)
            throw new InvalidOperationException("At least one Entra ID scope is required for APIM/OpenAI-compatible bearer authentication.");
        return scopes;
    }

    private static string[] GetConfiguredScopes(List<string>? values)
    {
        return (values ?? new List<string>())
            .Select(s => (s ?? string.Empty).Trim())
            .Where(s => s.Length > 0)
            .Where(s => !s.StartsWith("VSCODE_CLIENT_ID:", StringComparison.OrdinalIgnoreCase))
            .Where(s => !s.StartsWith("VSCODE_TENANT:", StringComparison.OrdinalIgnoreCase))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }

    private static Uri ResolveAuthorityHost(string? authorityHost)
    {
        if (string.IsNullOrWhiteSpace(authorityHost)) return AzureAuthorityHosts.AzurePublicCloud;
        var trimmed = authorityHost.Trim();
        if (!trimmed.EndsWith("/", StringComparison.Ordinal)) trimmed += "/";
        return new Uri(trimmed);
    }

    private static string ResolveDirectAudience(InboundMessage cfg)
    {
        if (!string.IsNullOrWhiteSpace(cfg.DirectAudience))
            return cfg.DirectAudience.Trim();

        var authorityHost = ResolveAuthorityHost(cfg.AuthorityHost).Host;
        if (authorityHost.EndsWith(".us", StringComparison.OrdinalIgnoreCase))
            return "https://cognitiveservices.azure.us/.default";
        if (authorityHost.EndsWith(".cn", StringComparison.OrdinalIgnoreCase))
            return "https://cognitiveservices.azure.cn/.default";
        return "https://cognitiveservices.azure.com/.default";
    }

    private static string? GetPseudoScopeValue(List<string>? values, string key)
    {
        if (values == null) return null;
        var prefix = key + ":";
        foreach (var raw in values)
        {
            var value = (raw ?? string.Empty).Trim();
            if (value.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                return value.Substring(prefix.Length).Trim();
        }
        return null;
    }

    private static string? FirstNonEmpty(params string?[] values)
    {
        foreach (var value in values)
        {
            if (!string.IsNullOrWhiteSpace(value)) return value.Trim();
        }
        return null;
    }

    private string FormatModelRequestError(Exception ex)
    {
        var message = ex.Message;
        if (!LooksUnauthorized(ex)) return message;

        var scopes = configuredScopes.Length == 0 ? "(none configured)" : string.Join(", ", configuredScopes);
        var tenant = string.IsNullOrWhiteSpace(configuredTenantId) ? "(default)" : configuredTenantId;
        var tokenDiagnostics = string.IsNullOrWhiteSpace(lastTokenDiagnostics)
            ? "- Token claims: (not captured)\n"
            : lastTokenDiagnostics;
        return message + "\n\n" +
            "Entra/APIM diagnostics:\n" +
            "- Provider: " + configuredProvider + "\n" +
            "- Base URL: " + configuredBaseUrl + "\n" +
            "- Authority host: " + configuredAuthorityHost + "\n" +
            "- Tenant hint: " + tenant + "\n" +
            "- Direct audience: " + configuredDirectAudience + "\n" +
            "- Scopes: " + scopes + "\n" +
            tokenDiagnostics +
            "- Check that APIM validate-azure-ad-token uses the same tenant/issuer and an audience matching the scope without /user_impersonation.";
    }

    private static void LogModelRequestFailure(Exception ex)
    {
        try
        {
            Console.Error.WriteLine("MODEL_REQUEST_FAILURE: " + ex);
            var responseDetails = TryExtractResponseDetails(ex);
            if (!string.IsNullOrWhiteSpace(responseDetails))
            {
                Console.Error.WriteLine("MODEL_RESPONSE_DETAILS:\n" + responseDetails);
            }
        }
        catch { }
    }

    private static string TryExtractResponseDetails(Exception ex)
    {
        var visited = new HashSet<object>();
        for (Exception? current = ex; current != null; current = current.InnerException)
        {
            var details = TryExtractResponseDetailsFromObject(current, visited);
            if (!string.IsNullOrWhiteSpace(details)) return details;
        }
        return string.Empty;
    }

    private static string TryExtractResponseDetailsFromObject(object value, HashSet<object> visited)
    {
        if (value == null || !visited.Add(value)) return string.Empty;
        var type = value.GetType();
        var response = type.GetProperty("Response", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)?.GetValue(value, null)
            ?? type.GetMethod("GetRawResponse", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic, null, Type.EmptyTypes, null)?.Invoke(value, null);
        if (response == null) return string.Empty;

        var builder = new StringBuilder();
        AppendProperty(builder, response, "Status");
        AppendProperty(builder, response, "StatusCode");
        AppendProperty(builder, response, "ReasonPhrase");
        AppendHeaders(builder, response);
        AppendContent(builder, response);
        return builder.ToString();
    }

    private static void AppendProperty(StringBuilder builder, object value, string propertyName)
    {
        var property = value.GetType().GetProperty(propertyName, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
        if (property == null) return;
        var propertyValue = property.GetValue(value, null);
        if (propertyValue != null) builder.Append(propertyName).Append(": ").AppendLine(Convert.ToString(propertyValue));
    }

    private static void AppendHeaders(StringBuilder builder, object response)
    {
        try
        {
            var headers = response.GetType().GetProperty("Headers", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)?.GetValue(response, null);
            if (headers == null) return;
            builder.AppendLine("Headers:");
            foreach (var header in (System.Collections.IEnumerable)headers)
            {
                var name = header.GetType().GetProperty("Name")?.GetValue(header, null)
                    ?? header.GetType().GetProperty("Key")?.GetValue(header, null);
                if (name == null) continue;
                var headerName = Convert.ToString(name) ?? string.Empty;
                if (headerName.IndexOf("authorization", StringComparison.OrdinalIgnoreCase) >= 0) continue;
                if (headerName.IndexOf("key", StringComparison.OrdinalIgnoreCase) >= 0) continue;
                if (headerName.StartsWith("Set-Cookie", StringComparison.OrdinalIgnoreCase)) continue;
                var headerValue = header.GetType().GetProperty("Value")?.GetValue(header, null);
                builder.Append("  ").Append(headerName).Append(": ").AppendLine(Convert.ToString(headerValue));
            }
        }
        catch { }
    }

    private static void AppendContent(StringBuilder builder, object response)
    {
        try
        {
            var content = response.GetType().GetProperty("Content", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)?.GetValue(response, null);
            if (content != null)
            {
                builder.AppendLine("Content:").AppendLine(TruncateDiagnostic(Convert.ToString(content) ?? string.Empty, 2000));
                return;
            }

            var stream = response.GetType().GetProperty("ContentStream", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)?.GetValue(response, null) as Stream;
            if (stream == null || !stream.CanRead) return;
            if (stream.CanSeek) stream.Position = 0;
            using var reader = new StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: true, bufferSize: 1024, leaveOpen: true);
            builder.AppendLine("Content:").AppendLine(TruncateDiagnostic(reader.ReadToEnd(), 2000));
            if (stream.CanSeek) stream.Position = 0;
        }
        catch { }
    }

    private static string TruncateDiagnostic(string value, int maxLength)
    {
        if (string.IsNullOrEmpty(value) || value.Length <= maxLength) return value;
        return value.Substring(0, maxLength) + "...";
    }

    private static bool LooksUnauthorized(Exception ex)
    {
        var message = ex.Message ?? string.Empty;
        if (message.IndexOf("401", StringComparison.OrdinalIgnoreCase) >= 0) return true;
        if (message.IndexOf("Unauthorized", StringComparison.OrdinalIgnoreCase) >= 0) return true;

        var type = ex.GetType();
        foreach (var propertyName in new[] { "Status", "StatusCode" })
        {
            var property = type.GetProperty(propertyName);
            if (property == null) continue;
            var value = property.GetValue(ex, null);
            if (value != null && string.Equals(Convert.ToString(value), "401", StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
    }

    public void Configure(InboundMessage cfg)
    {
        if (string.IsNullOrWhiteSpace(cfg.Deployment))
            throw new InvalidOperationException("Deployment is required.");

        var provider = (cfg.Provider ?? "Direct").Trim();
        string baseUrl = provider.Equals("Apim", StringComparison.OrdinalIgnoreCase)
            ? (cfg.ApimBaseUrl ?? throw new InvalidOperationException("APIM base URL is required."))
            : provider.Equals("OpenAICompatible", StringComparison.OrdinalIgnoreCase)
                ? (cfg.OpenAICompatibleBaseUrl ?? throw new InvalidOperationException("OpenAI-compatible base URL is required."))
                : (cfg.Endpoint ?? throw new InvalidOperationException("Endpoint is required."));
        tools.SetDiagnostics(cfg.Diagnostics);
        var nextFingerprint = BuildConfigureFingerprint(cfg, provider, baseUrl);
        if (chatClient is not null && string.Equals(configuredFingerprint, nextFingerprint, StringComparison.Ordinal))
        {
            try { Console.Error.WriteLine("AUTH: configuration unchanged; reusing existing model client and credential chain."); } catch { }
            return;
        }

        if (!string.IsNullOrWhiteSpace(cfg.SystemPrompt))
            baseSystemPrompt = cfg.SystemPrompt!;

        if (!string.IsNullOrWhiteSpace(cfg.WorkspaceRoot) && Directory.Exists(cfg.WorkspaceRoot))
        {
            tools.WorkspaceRoot = cfg.WorkspaceRoot!;
        }
        else
        {
            // No solution/folder open. Refuse to fall back to the sidecar's CWD (which is the VS install dir).
            tools.WorkspaceRoot = string.Empty;
        }
        if (!string.IsNullOrWhiteSpace(cfg.ScratchRoot))
            tools.ScratchRoot = cfg.ScratchRoot!;

        tools.ApprovalWrite = ParseApprovalMode(cfg.ApprovalWrite, ApprovalMode.Confirm);
        tools.ApprovalDelete = ParseApprovalMode(cfg.ApprovalDelete, ApprovalMode.Confirm);
        tools.ApprovalShell = ParseApprovalMode(cfg.ApprovalShell, ApprovalMode.Confirm);

        var authMode = ParseAuthMode(cfg.AuthMode);
        var apiKey = cfg.ApiKey ?? string.Empty;
        try { Console.Error.WriteLine("AUTH: applying updated configuration for " + provider + " using " + authMode + "."); } catch { }
        configuredAuthMode = authMode;
        configuredProvider = provider;
        configuredBaseUrl = baseUrl.TrimEnd('/');
        configuredAuthorityHost = ResolveAuthorityHost(cfg.AuthorityHost).ToString();
        configuredTenantId = FirstNonEmpty(cfg.AuthTenantId, GetPseudoScopeValue(cfg.AuthScopes, "VSCODE_TENANT")) ?? string.Empty;
        configuredDirectAudience = ResolveDirectAudience(cfg).ToString();
        configuredScopes = GetConfiguredScopes(cfg.AuthScopes);
        mcpClient.Configure(cfg.McpEnabled == true, cfg.McpServersJson, configuredAuthorityHost, configuredTenantId, FirstNonEmpty(cfg.AuthClientId, GetPseudoScopeValue(cfg.AuthScopes, "VSCODE_CLIENT_ID")) ?? string.Empty);

        IChatClient innerClient;
        if (provider.Equals("Direct", StringComparison.OrdinalIgnoreCase))
        {
            if (authMode == ProviderAuthMode.ApiKey)
            {
                var azureOptions = new AzureOpenAIClientOptions { NetworkTimeout = TimeSpan.FromMinutes(5) };
                var azureClient = new AzureOpenAIClient(new Uri(baseUrl), new ApiKeyCredential(apiKey), azureOptions);
#pragma warning disable OPENAI001
                innerClient = azureClient.GetResponsesClient().AsIChatClient(cfg.Deployment);
#pragma warning restore OPENAI001
            }
            else
            {
                var root = baseUrl.TrimEnd('/');
                if (!root.EndsWith("/openai/v1", StringComparison.OrdinalIgnoreCase))
                {
                    root = root + "/openai/v1";
                }

                var openAiOptions = new OpenAIClientOptions
                {
                    Endpoint = new Uri(root),
                    NetworkTimeout = TimeSpan.FromMinutes(5)
                };

                if (authMode == ProviderAuthMode.BearerToken)
                {
                    openAiOptions.AddPolicy(new StaticBearerTokenPolicy(RequireValue(cfg.BearerToken, "Bearer token is required.")), PipelinePosition.BeforeTransport);
                }
                else
                {
                    openAiOptions.AddPolicy(new EntraBearerTokenPolicy(BuildTokenCredential(cfg), new[] { ResolveDirectAudience(cfg) }, d => lastTokenDiagnostics = d), PipelinePosition.BeforeTransport);
                }

                var openAiClient = new OpenAIClient(new ApiKeyCredential("unused"), openAiOptions);
#pragma warning disable OPENAI001
                innerClient = openAiClient.GetResponsesClient().AsIChatClient(cfg.Deployment);
#pragma warning restore OPENAI001
            }
        }
        else
        {
            var root = baseUrl.TrimEnd('/');
            if (provider.Equals("Apim", StringComparison.OrdinalIgnoreCase) && !root.EndsWith("/openai/v1", StringComparison.OrdinalIgnoreCase))
            {
                root = root + "/openai/v1";
            }

            var openAiOptions = new OpenAIClientOptions
            {
                Endpoint = new Uri(root),
                NetworkTimeout = TimeSpan.FromMinutes(5)
            };

            if (authMode == ProviderAuthMode.BearerToken)
            {
                openAiOptions.AddPolicy(new StaticBearerTokenPolicy(RequireValue(cfg.BearerToken, "Bearer token is required.")), PipelinePosition.BeforeTransport);
            }
            else if (authMode == ProviderAuthMode.EntraId)
            {
                openAiOptions.AddPolicy(new EntraBearerTokenPolicy(BuildTokenCredential(cfg), BuildTokenScopes(cfg), d => lastTokenDiagnostics = d), PipelinePosition.BeforeTransport);
            }
            else if (provider.Equals("Apim", StringComparison.OrdinalIgnoreCase))
            {
                openAiOptions.AddPolicy(new ApimSubscriptionKeyPolicy(apiKey), PipelinePosition.BeforeTransport);
            }

            var credentialKey = authMode == ProviderAuthMode.ApiKey ? apiKey : "unused";
            var openAiClient = new OpenAIClient(new ApiKeyCredential(credentialKey), openAiOptions);
#pragma warning disable OPENAI001
            innerClient = openAiClient.GetResponsesClient().AsIChatClient(cfg.Deployment);
#pragma warning restore OPENAI001
        }

        // Wrap with function-invocation middleware so the agent executes our tool calls.
        // MaximumIterationsPerRequest controls how many model<->tool round-trips we allow
        // before the agent loop is forcibly stopped. The default is small; we raise it so
        // the agent can complete multi-file scaffolding in one shot.
        chatClient = innerClient.AsBuilder()
            .UseFunctionInvocation(configure: c =>
            {
                c.MaximumIterationsPerRequest = MaxIterationsPerRequest;
                c.MaximumConsecutiveErrorsPerRequest = 5;
                c.IncludeDetailedErrors = true;
            })
            .Build();

        // Drop any previously-built per-mode agents so the next turn picks up the new client/tools/workspace.
        agents.Clear();
        history.Clear();
        lastRepoInstructionNoticeKey = string.Empty;
        configuredFingerprint = nextFingerprint;
    }

    public void UpdateDiagnostics(IEnumerable<DiagnosticSnapshotItem>? diagnostics)
    {
        tools.SetDiagnostics(diagnostics);
    }

    private static string BuildConfigureFingerprint(InboundMessage cfg, string provider, string baseUrl)
    {
        var parts = new[]
        {
            provider,
            baseUrl.TrimEnd('/'),
            cfg.Endpoint ?? string.Empty,
            cfg.ApimBaseUrl ?? string.Empty,
            cfg.OpenAICompatibleBaseUrl ?? string.Empty,
            cfg.ApiKey ?? string.Empty,
            cfg.AuthMode ?? string.Empty,
            cfg.BearerToken ?? string.Empty,
            string.Join("\n", (cfg.AuthScopes ?? new List<string>()).Select(s => (s ?? string.Empty).Trim())),
            cfg.AuthTenantId ?? string.Empty,
            cfg.AuthClientId ?? string.Empty,
            ResolveAuthorityHost(cfg.AuthorityHost).ToString(),
            ResolveDirectAudience(cfg).ToString(),
            cfg.ApiVersion ?? string.Empty,
            cfg.Deployment ?? string.Empty,
            cfg.SystemPrompt ?? string.Empty,
            cfg.WorkspaceRoot ?? string.Empty,
            cfg.ScratchRoot ?? string.Empty,
            cfg.ApprovalWrite ?? string.Empty,
            cfg.ApprovalDelete ?? string.Empty,
            cfg.ApprovalShell ?? string.Empty,
            cfg.McpEnabled == true ? "mcp:on" : "mcp:off",
            cfg.McpServersJson ?? string.Empty
        };
        return string.Join("\u001f", parts);
    }

    /// <summary>Builds (or fetches from cache) the agent for a given chat mode.</summary>
    private AIAgent? GetOrBuildAgent(string mode)
    {
        if (chatClient is null) return null;
        var key = (mode ?? "agent").Trim().ToLowerInvariant();
        if (key != "agent" && key != "plan" && key != "ask") key = "agent";

        if (agents.TryGetValue(key, out var cached)) return cached;

        var prompt = key switch
        {
            "plan" => PlanModeSystemPrompt,
            "ask" => AskModeSystemPrompt,
            _ => baseSystemPrompt
        };
        var rooted = prompt + $"\n\nWorkspace root: {tools.WorkspaceRoot}";
        var modeTools = tools.AsAITools(key);
        if (key == "agent" && mcpClient.Enabled)
        {
            try
            {
                mcpClient.EnsureConnectedAsync(CancellationToken.None).GetAwaiter().GetResult();
                foreach (var mcpTool in mcpClient.AsAITools())
                    modeTools.Add(mcpTool);
            }
            catch (Exception ex)
            {
                try { Console.Error.WriteLine("MCP: failed to prepare tools: " + ex.Message); } catch { }
            }
        }
        var newAgent = new ChatClientAgent(chatClient, instructions: rooted, name: "Junior", tools: modeTools);
        agents[key] = newAgent;
        return newAgent;
    }

    public async Task<object> GetMcpToolsMessageAsync(CancellationToken ct = default)
    {
        if (!mcpClient.Enabled)
        {
            return new { type = "mcpTools", enabled = false, configured = false, connectedServerCount = 0, toolCount = 0, tools = Array.Empty<object>() };
        }

        try
        {
            await mcpClient.EnsureConnectedAsync(ct).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            try { Console.Error.WriteLine("MCP: failed to list tools: " + ex.Message); } catch { }
        }

        return new
        {
            type = "mcpTools",
            enabled = true,
            configured = true,
            connectedServerCount = mcpClient.ConnectedServerCount,
            toolCount = mcpClient.ToolCount,
            tools = mcpClient.GetToolSummaries()
        };
    }

    public void SetMcpToolEnabled(string functionName, bool enabled)
    {
        mcpClient.SetToolEnabled(functionName, enabled);
        agents.Clear();
    }

    public async Task<string> GenerateTextAsync(string? systemPrompt, string? prompt, bool allowInteractiveAuth = true, CancellationToken ct = default)
    {
        if (chatClient is null)
            throw new InvalidOperationException("Agent is not configured. Open Tools > Options > Junior and set the provider/endpoint/key/deployment.");

        var messages = new List<ChatMessage>();
        if (!string.IsNullOrWhiteSpace(systemPrompt))
            messages.Add(new ChatMessage(ChatRole.System, systemPrompt));
        messages.Add(new ChatMessage(ChatRole.User, prompt ?? string.Empty));

        using var interactiveAuthScope = JuniorEntraTokenCredential.SetInteractiveAuthAllowed(allowInteractiveAuth);
        var response = await chatClient.GetResponseAsync(messages, cancellationToken: ct).ConfigureAwait(false);
        return response.Text ?? string.Empty;
    }

    public async Task WarmAuthAsync(InboundMessage cfg, CancellationToken ct = default)
    {
        var authMode = ParseAuthMode(cfg.AuthMode);
        if (authMode != ProviderAuthMode.EntraId)
        {
            return;
        }

        var provider = (cfg.Provider ?? "Direct").Trim();
        var scopes = provider.Equals("Direct", StringComparison.OrdinalIgnoreCase)
            ? new[] { ResolveDirectAudience(cfg) }
            : BuildTokenScopes(cfg);
        var credential = BuildTokenCredential(cfg);
        await credential.GetTokenAsync(new TokenRequestContext(scopes), ct).ConfigureAwait(false);
    }

    public async IAsyncEnumerable<object> SendMessageAsync(string text, List<string>? images = null, List<AttachedFile>? files = null, string? mode = null, [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct = default)
    {
        var modeKey = (mode ?? "agent").Trim().ToLowerInvariant();
        if (modeKey != "agent" && modeKey != "plan" && modeKey != "ask") modeKey = "agent";
        var isAutomaticRepairTurn = text.StartsWith("Continue fixing the validation errors", StringComparison.OrdinalIgnoreCase);

        currentCts?.Dispose();
        currentCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var token = currentCts.Token;

        yield return new { type = "agentBegin" };
        if (configuredAuthMode == ProviderAuthMode.EntraId)
        {
            yield return new
            {
                type = "setStatus",
                status = "Signing in with Microsoft Entra ID. A browser window may open; return here after authentication completes."
            };
        }
        if (modeKey == "agent" && mcpClient.Enabled)
        {
            yield return new
            {
                type = "setStatus",
                status = "Preparing MCP tools. If an MCP server uses Microsoft Entra ID, a browser window may open; return here after authentication completes."
            };
        }

        var agent = GetOrBuildAgent(modeKey);
        if (agent is null)
        {
            yield return new { type = "error", message = "Agent is not configured. Open Tools > Options > Junior and set the provider/endpoint/key/deployment." };
            yield break;
        }

        // Compose user-turn content: prepend any attached file contents as fenced
        // blocks, then add the user's text, then attach images as DataContent so
        // the multimodal model can see them.
        var userText = new StringBuilder();
        if (files is { Count: > 0 })
        {
            foreach (var f in files)
            {
                if (string.IsNullOrEmpty(f?.Name) || f!.Content is null) continue;
                userText.Append("### Attached file: ").AppendLine(f.Name);
                userText.AppendLine("```");
                userText.AppendLine(f.Content);
                userText.AppendLine("```");
                userText.AppendLine();
            }
        }
        if (!string.IsNullOrEmpty(text)) userText.Append(text);

        var userContents = new List<AIContent>();
        if (userText.Length > 0) userContents.Add(new TextContent(userText.ToString()));
        if (images is { Count: > 0 })
        {
            foreach (var dataUri in images)
            {
                if (string.IsNullOrEmpty(dataUri)) continue;
                if (TryParseDataUri(dataUri, out var bytes, out var mediaType))
                    userContents.Add(new DataContent(bytes, mediaType));
            }
        }
        if (userContents.Count == 0) userContents.Add(new TextContent(string.Empty));
        var trimmedHistoryThisTurn = 0;
        history.Add(new ChatMessage(ChatRole.User, userContents));
        trimmedHistoryThisTurn += TrimHistoryIfNeeded();

        // Per-turn transient system message giving the model an up-to-date view of
        // the workspace. This is NOT persisted to history (next turn rebuilds it).
        var turnHistory = new List<ChatMessage>(history.Count + 1);
        var overview = BuildWorkspaceOverview(text, out var contextTelemetry);
        if (!string.IsNullOrEmpty(overview))
            turnHistory.Add(new ChatMessage(ChatRole.System, overview));
        turnHistory.AddRange(history);
        if (!string.IsNullOrWhiteSpace(contextTelemetry.RepoInstructionSource))
        {
            var noticeKey = string.Join("\u001f", contextTelemetry.RepoInstructionSource, contextTelemetry.RepoInstructionTruncated.ToString(), string.Join("|", contextTelemetry.RepoInstructionCandidates));
            if (!string.Equals(noticeKey, lastRepoInstructionNoticeKey, StringComparison.Ordinal))
            {
                lastRepoInstructionNoticeKey = noticeKey;
                yield return new
                {
                    type = "repoInstructions",
                    source = contextTelemetry.RepoInstructionSource,
                    truncated = contextTelemetry.RepoInstructionTruncated,
                    candidates = contextTelemetry.RepoInstructionCandidates
                };
            }
        }

        var assistantText = new StringBuilder();
        var narrationBuffer = new StringBuilder();
        var seenCalls = new HashSet<string>(StringComparer.Ordinal);
        var seenResults = new HashSet<string>(StringComparer.Ordinal);
        var toolNames = new HashSet<string>(StringComparer.Ordinal);
        var changedFiles = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var trackedCalls = new Dictionary<string, (string? Name, string? FilePath, bool IsMutation)>(StringComparer.Ordinal);
        var failedToolCount = 0;
        long turnInputTokens = 0;
        long turnOutputTokens = 0;
        long turnTotalTokens = 0;
        long turnReasoningTokens = 0;
        long turnCachedInputTokens = 0;
        bool sawUsage = false;
        bool requestFailed = false;
        string? workingBlockId = null;
        bool workingBlockHasResults = false;
        bool assistantMessageStarted = false;
        bool reasoningOpen = false;
        var enumerator = agent.RunStreamingAsync(turnHistory, options: BuildRunOptions(), cancellationToken: token).GetAsyncEnumerator(token);
        try
        {
            while (true)
            {
                bool hasMore;
                AgentResponseUpdate? update = null;
                string? errorMessage = null;
                try
                {
                    hasMore = await enumerator.MoveNextAsync();
                    if (hasMore) update = enumerator.Current;
                }
                catch (OperationCanceledException)
                {
                    break;
                }
                catch (Exception ex)
                {
                    LogModelRequestFailure(ex);
                    errorMessage = FormatModelRequestError(ex);
                    hasMore = false;
                }

                if (errorMessage is not null)
                {
                    requestFailed = true;
                    if (!assistantMessageStarted)
                    {
                        assistantMessageStarted = true;
                        yield return new { type = "startAssistantMessage", provider = "local" };
                    }
                    yield return new { type = "appendAssistantText", text = $"\n\n_Error:_ {errorMessage}" };
                    break;
                }

                if (!hasMore) break;
                if (update is null) continue;

                // Walk content items so we can emit tool-call and tool-result events.
                if (update.Contents is { Count: > 0 } contents)
                {
                    foreach (var item in contents)
                    {
                        if (item is FunctionCallContent fc && seenCalls.Add(fc.CallId ?? string.Empty))
                        {
                            // Close any open reasoning row — reasoning belongs ABOVE the working block it preceded.
                            if (reasoningOpen)
                            {
                                yield return new { type = "reasoningEnd" };
                                reasoningOpen = false;
                            }

                            // Flush any buffered narration text so it shows ABOVE the working block / next action.
                            if (narrationBuffer.Length > 0)
                            {
                                var narText = narrationBuffer.ToString().Trim();
                                narrationBuffer.Clear();
                                if (narText.Length > 0)
                                    yield return new { type = "narrationText", text = narText };
                            }

                            // If the previous working block already received results, this call is
                            // part of a NEW turn — close the previous block so we render a timeline
                            // of reasoning -> block -> reasoning -> block.
                            if (workingBlockId is not null && workingBlockHasResults)
                            {
                                yield return new
                                {
                                    type = "workingBlockCompleted",
                                    blockId = workingBlockId,
                                    summary = "Done.",
                                    completedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
                                };
                                workingBlockId = null;
                                workingBlockHasResults = false;
                            }

                            if (workingBlockId is null)
                            {
                                workingBlockId = "wb-" + Guid.NewGuid().ToString("N");
                                yield return new
                                {
                                    type = "workingBlockStarted",
                                    block = new { id = workingBlockId, title = "Working", entries = Array.Empty<object>() }
                                };
                            }

                            var entryId = fc.CallId ?? Guid.NewGuid().ToString("N");
                            var (icon, text2, filePath) = DescribeToolCall(fc.Name, fc.Arguments);
                            if (!string.IsNullOrWhiteSpace(fc.Name)) toolNames.Add(fc.Name!);
                            trackedCalls[entryId] = (fc.Name, filePath, IsMutationTool(fc.Name));
                            yield return new
                            {
                                type = "workingActionAdded",
                                blockId = workingBlockId,
                                entry = new
                                {
                                    id = entryId,
                                    kind = "action",
                                    status = "pending",
                                    icon,
                                    text = text2,
                                    filePath
                                }
                            };
                        }
                        else if (item is FunctionResultContent fr && seenResults.Add(fr.CallId ?? string.Empty))
                        {
                            var resultText = fr.Result?.ToString() ?? string.Empty;
                            var failed = resultText.StartsWith("ERROR", StringComparison.Ordinal);
                            if (failed) failedToolCount++;
                            if (!failed
                                && !string.IsNullOrEmpty(fr.CallId)
                                && trackedCalls.TryGetValue(fr.CallId!, out var tracked)
                                && tracked.IsMutation
                                && !string.IsNullOrWhiteSpace(tracked.FilePath))
                            {
                                changedFiles.Add(tracked.FilePath!);
                            }
                            if (workingBlockId is not null)
                            {
                                workingBlockHasResults = true;
                                yield return new
                                {
                                    type = "workingActionUpdated",
                                    blockId = workingBlockId,
                                    entryId = fr.CallId ?? Guid.NewGuid().ToString("N"),
                                    status = failed ? "error" : "done",
                                    detail = failed ? Truncate(resultText, 240) : SummarizeToolResult(resultText)
                                };
                            }
                        }
                        else if (item is TextReasoningContent tr && !string.IsNullOrEmpty(tr.Text))
                        {
                            // If a working block from the previous turn is sitting fully resolved,
                            // close it so this reasoning row appears AFTER it (timeline order).
                            if (workingBlockId is not null && workingBlockHasResults)
                            {
                                yield return new
                                {
                                    type = "workingBlockCompleted",
                                    blockId = workingBlockId,
                                    summary = "Done.",
                                    completedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
                                };
                                workingBlockId = null;
                                workingBlockHasResults = false;
                            }

                            if (!reasoningOpen)
                            {
                                yield return new { type = "reasoningStart" };
                                reasoningOpen = true;
                            }
                            yield return new { type = "reasoningAppend", text = tr.Text };
                        }
                        else if (item is UsageContent uc && uc.Details is not null)
                        {
                            // The streaming pipeline emits UsageContent at the end of each
                            // model call. We sum across calls so multi-iteration tool loops
                            // report the full turn cost.
                            sawUsage = true;
                            if (uc.Details.InputTokenCount is long inTok) turnInputTokens += inTok;
                            if (uc.Details.OutputTokenCount is long outTok) turnOutputTokens += outTok;
                            if (uc.Details.TotalTokenCount is long totTok) turnTotalTokens += totTok;
                            if (uc.Details.ReasoningTokenCount is long rTok) turnReasoningTokens += rTok;
                            if (uc.Details.CachedInputTokenCount is long cTok) turnCachedInputTokens += cTok;
                        }
                    }
                }

                var chunk = update.Text;
                if (!string.IsNullOrEmpty(chunk))
                {
                    // Buffer text. If more tool calls come, it'll be flushed as a narration row above them.
                    // Whatever's left at the end becomes the final assistant message.
                    narrationBuffer.Append(chunk);
                }
            }
        }
        finally
        {
            await enumerator.DisposeAsync();
        }

        if (reasoningOpen)
        {
            yield return new { type = "reasoningEnd" };
            reasoningOpen = false;
        }

        if (workingBlockId is not null)
        {
            yield return new
            {
                type = "workingBlockCompleted",
                blockId = workingBlockId,
                summary = "Done.",
                completedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
            };
        }

        // Flush any remaining buffered text as the final assistant summary.
        if (narrationBuffer.Length > 0)
        {
            var finalText = narrationBuffer.ToString();
            assistantText.Append(finalText);
            if (!assistantMessageStarted)
            {
                assistantMessageStarted = true;
                yield return new { type = "startAssistantMessage", provider = "local" };
            }
            yield return new { type = "appendAssistantText", text = finalText };
        }

        if (assistantText.Length > 0)
            history.Add(new ChatMessage(ChatRole.Assistant, assistantText.ToString()));

        if (assistantMessageStarted)
            yield return new { type = "endAssistantMessage" };

        if (sawUsage)
        {
            // If the provider only reported total, derive missing input/output as best we can.
            var inT = turnInputTokens;
            var outT = turnOutputTokens;
            var totT = turnTotalTokens > 0 ? turnTotalTokens : inT + outT;
            yield return new
            {
                type = "tokenUsage",
                input = inT,
                output = outT,
                total = totT,
                reasoning = turnReasoningTokens,
                cachedInput = turnCachedInputTokens
            };
        }

        if (configuredAuthMode == ProviderAuthMode.EntraId && !requestFailed)
        {
            yield return new { type = "authState", state = "signedIn", message = "Signed in with Microsoft Entra ID." };
        }

        var validationFailed = false;
        var validationFingerprint = string.Empty;
        var validationStatus = "skipped";
        var validationCommand = string.Empty;
        var validationDetail = string.Empty;
        if (modeKey == "agent" && !requestFailed && tools.HasUnvalidatedMutations && !token.IsCancellationRequested)
        {
            validationCommand = tools.DetectDefaultValidationCommand();
            if (!string.IsNullOrWhiteSpace(validationCommand))
            {
                var validationBlockId = "wb-" + Guid.NewGuid().ToString("N");
                var validationEntryId = "validate-" + Guid.NewGuid().ToString("N");
                yield return new
                {
                    type = "workingBlockStarted",
                    block = new { id = validationBlockId, title = "Validation", entries = Array.Empty<object>() }
                };
                yield return new
                {
                    type = "workingActionAdded",
                    blockId = validationBlockId,
                    entry = new
                    {
                        id = validationEntryId,
                        kind = "action",
                        status = "pending",
                        icon = "check",
                        text = "Validating workspace: " + validationCommand,
                        filePath = (string?)null
                    }
                };

                var validationResult = await tools.ValidateWorkspace(validationCommand, token).ConfigureAwait(false);
                validationFailed = !WorkspaceTools.ValidationSucceeded(validationResult);
                validationStatus = validationFailed ? "failed" : "passed";
                validationDetail = validationFailed ? Truncate(validationResult, 240) : "Validation passed.";
                if (validationFailed) validationFingerprint = BuildFailureFingerprint(validationCommand, validationResult);
                yield return new
                {
                    type = "workingActionUpdated",
                    blockId = validationBlockId,
                    entryId = validationEntryId,
                    status = validationFailed ? "error" : "done",
                    detail = validationDetail
                };
                yield return new
                {
                    type = "workingBlockCompleted",
                    blockId = validationBlockId,
                    summary = validationFailed ? "Validation failed." : "Validation passed.",
                    completedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
                };

                if (validationFailed)
                {
                    var repairTargets = tools.BuildRepairTargetSummary(validationResult);
                    var feedback = "Automatic validation failed after the last edits. Fix the reported errors, then validate again.\n\n" +
                                   "Validation command: " + validationCommand + "\n\n" +
                                   repairTargets + "\n" +
                                   "```\n" + Truncate(validationResult, 6000) + "\n```";
                    history.Add(new ChatMessage(ChatRole.User, feedback));
                    trimmedHistoryThisTurn += TrimHistoryIfNeeded();
                    yield return new { type = "startAssistantMessage", provider = "local" };
                    yield return new
                    {
                        type = "appendAssistantText",
                        text = "\n\nAutomatic validation failed. I captured the build/test output so I can continue fixing it if you choose to keep iterating."
                    };
                    yield return new { type = "endAssistantMessage" };
                }
            }
        }

        // If we used a lot of tool calls and the model didn't return a clean final answer,
        // we likely hit MaximumIterationsPerRequest. Ask the user whether to continue.
        var iterationCount = seenCalls.Count;
        var finishedCleanly = assistantText.ToString().Trim().Length > 0
                              && seenResults.Count >= seenCalls.Count;
        if (modeKey == "agent")
        {
            yield return new
            {
                type = "turnSummary",
                changedFiles = changedFiles.OrderBy(f => f, StringComparer.OrdinalIgnoreCase).ToArray(),
                tools = toolNames.OrderBy(t => t, StringComparer.Ordinal).ToArray(),
                toolCallCount = seenCalls.Count,
                failedToolCount,
                autoRepair = isAutomaticRepairTurn,
                context = new
                {
                    workspaceOverview = contextTelemetry.WorkspaceOverview,
                    indexedFiles = contextTelemetry.IndexedFiles,
                    diagnostics = contextTelemetry.DiagnosticsIncluded,
                    relevantFiles = contextTelemetry.RelevantFilesIncluded,
                    repoInstructions = contextTelemetry.RepoInstructionSource,
                    repoInstructionsTruncated = contextTelemetry.RepoInstructionTruncated,
                    repoInstructionCandidates = contextTelemetry.RepoInstructionCandidates,
                    historyTurns = history.Count,
                    historyTrimmed = trimmedHistoryThisTurn > 0,
                    trimmedHistoryTurns = trimmedHistoryThisTurn
                },
                validation = new
                {
                    status = validationStatus,
                    command = string.IsNullOrWhiteSpace(validationCommand) ? null : validationCommand,
                    detail = string.IsNullOrWhiteSpace(validationDetail) ? null : validationDetail
                }
            };
        }
        if (validationFailed)
        {
            yield return new
            {
                type = "continueIteration",
                iterationCount,
                reason = "validationFailed",
                validationFingerprint,
                title = "Validation failed",
                message = "Junior ran validation after editing and found errors. Continue so it can fix them and validate again."
            };
        }
        else if (iterationCount >= MaxIterationsPerRequest || (iterationCount > 0 && !finishedCleanly))
        {
            yield return new { type = "continueIteration", iterationCount };
        }

        yield return new { type = "agentDone" };
    }

    public void Cancel()
    {
        try { currentCts?.Cancel(); } catch { }
    }

    private static (string icon, string text, string? filePath) DescribeToolCall(string? name, IDictionary<string, object?>? args)
    {
        string? GetArg(string key)
        {
            if (args is null) return null;
            if (!args.TryGetValue(key, out var v) || v is null) return null;
            return v.ToString();
        }

        switch (name)
        {
            case "GetWorkspaceRoot":
                return ("search", "Checking workspace", null);
            case "CreateWorkspaceFolder":
            {
                var folder = GetArg("name") ?? "folder";
                return ("create", $"Creating workspace folder {folder}", null);
            }
            case "ListDir":
            {
                var path = GetArg("path");
                var label = string.IsNullOrEmpty(path) || path == "." ? "workspace root" : path!;
                return ("list", $"Listing {label}", path == "." ? null : path);
            }
            case "ReadFile":
            {
                var path = GetArg("path") ?? "file";
                return ("read", $"Reading {path}", path);
            }
            case "WriteFile":
            {
                var path = GetArg("path") ?? "file";
                return ("edit", $"Editing {path}", path);
            }
            case "ApplyPatch":
            {
                var path = GetArg("path") ?? "file";
                return ("edit", $"Applying patch to {path}", path);
            }
            case "ReplaceText":
            {
                var path = GetArg("path") ?? "file";
                return ("edit", $"Patching {path}", path);
            }
            case "ReplaceLines":
            {
                var path = GetArg("path") ?? "file";
                return ("edit", $"Patching lines in {path}", path);
            }
            case "CreateFile":
            {
                var path = GetArg("path") ?? "file";
                return ("create", $"Creating {path}", path);
            }
            case "DeleteFile":
            {
                var path = GetArg("path") ?? "file";
                return ("error", $"Deleting {path}", path);
            }
            case "ListWorkspaceFiles":
            {
                var prefix = GetArg("prefix");
                var label = string.IsNullOrEmpty(prefix) ? "workspace" : prefix!;
                return ("list", $"Listing indexed files in {label}", null);
            }
            case "FindFiles":
            {
                var q = GetArg("query") ?? "";
                return ("search", $"Finding files matching '{q}'", null);
            }
            case "GetWorkspaceTree":
                return ("list", "Reading workspace tree", null);
            case "SearchText":
            {
                var q = GetArg("query") ?? "";
                return ("search", $"Searching for '{q}'", null);
            }
            case "SearchRelevantFiles":
            {
                var q = GetArg("query") ?? "";
                return ("search", $"Finding relevant files for '{Truncate(q, 60)}'", null);
            }
            case "GetDiagnostics":
                return ("check", "Reading Visual Studio diagnostics", null);
            case "ValidateWorkspace":
            {
                var cmd = GetArg("command") ?? "auto-detected validation";
                return ("check", $"Validating: {Truncate(cmd, 80)}", null);
            }
            case "RunShell":
            {
                var cmd = GetArg("command") ?? "";
                return ("run", $"Running: {Truncate(cmd, 80)}", null);
            }
            default:
                return ("run", name ?? "tool", null);
        }
    }

    private static bool IsMutationTool(string? name)
    {
        return name is "WriteFile" or "CreateFile" or "ApplyPatch" or "ReplaceText" or "ReplaceLines" or "DeleteFile";
    }

    private static string? SummarizeToolResult(string result)
    {
        if (string.IsNullOrEmpty(result)) return null;
        var firstLine = result.Split('\n')[0].Trim();
        return Truncate(firstLine, 160);
    }

    private static string Truncate(string s, int max)
    {
        if (string.IsNullOrEmpty(s)) return s;
        return s.Length <= max ? s : s.Substring(0, max) + "...";
    }

    private static string BuildFailureFingerprint(string command, string result)
    {
        var normalized = (command ?? string.Empty).Trim() + "\n" + Truncate(result ?? string.Empty, 4000);
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(normalized));
        return Convert.ToHexString(hash).ToLowerInvariant();
    }

    private sealed class ContextTelemetry
    {
        public bool WorkspaceOverview { get; set; }
        public int IndexedFiles { get; set; }
        public bool DiagnosticsIncluded { get; set; }
        public bool RelevantFilesIncluded { get; set; }
        public string RepoInstructionSource { get; set; } = string.Empty;
        public bool RepoInstructionTruncated { get; set; }
        public string[] RepoInstructionCandidates { get; set; } = Array.Empty<string>();
    }

    /// <summary>Parses a <c>data:</c> URI into raw bytes + media type. Returns false on malformed input.</summary>
    private static bool TryParseDataUri(string dataUri, out byte[] bytes, out string mediaType)
    {
        bytes = Array.Empty<byte>();
        mediaType = "application/octet-stream";
        if (string.IsNullOrEmpty(dataUri) || !dataUri.StartsWith("data:", StringComparison.OrdinalIgnoreCase))
            return false;
        var commaIdx = dataUri.IndexOf(',');
        if (commaIdx < 0) return false;
        var meta = dataUri.Substring(5, commaIdx - 5); // between "data:" and ","
        var payload = dataUri.Substring(commaIdx + 1);
        var isBase64 = meta.EndsWith(";base64", StringComparison.OrdinalIgnoreCase);
        var mt = isBase64 ? meta.Substring(0, meta.Length - 7) : meta;
        if (string.IsNullOrWhiteSpace(mt)) mt = "application/octet-stream";
        try
        {
            bytes = isBase64
                ? Convert.FromBase64String(payload)
                : System.Text.Encoding.UTF8.GetBytes(Uri.UnescapeDataString(payload));
        }
        catch { return false; }
        mediaType = mt;
        return true;
    }

    /// <summary>
    /// Builds a per-turn system message containing the current workspace tree
    /// snapshot (capped). On the first turn we wait briefly for the initial
    /// scan so the model isn't blind.
    /// </summary>
    private int TrimHistoryIfNeeded()
    {
        var removed = 0;
        while (history.Count > MaxStoredHistoryTurns)
        {
            history.RemoveAt(0);
            removed++;
        }
        return removed;
    }

    private string BuildWorkspaceOverview(string? userText, out ContextTelemetry telemetry)
    {
        telemetry = new ContextTelemetry();
        var root = tools.WorkspaceRoot;
        if (string.IsNullOrEmpty(root)) return string.Empty;

        // Block briefly on first call so the model sees a real tree, not "(loading)".
        tools.Index.WaitForInitialScan(2500);

        var tree = tools.Index.BuildTreeSnapshot(120);
        var count = tools.Index.Count;
        telemetry.WorkspaceOverview = true;
        telemetry.IndexedFiles = count;
        var sb = new StringBuilder();
        sb.AppendLine("Workspace overview (auto-refreshed every turn):");
        sb.Append("Root: ").AppendLine(root);
        sb.Append("Indexed files: ").AppendLine(count.ToString());
        sb.AppendLine("Tree:");
        sb.AppendLine("```");
        sb.Append(tree);
        if (!tree.EndsWith("\n")) sb.AppendLine();
        sb.AppendLine("```");
        sb.AppendLine("Use FindFiles / ListWorkspaceFiles / GetWorkspaceTree for deeper exploration; this snapshot is capped.");
        var diagnostics = tools.GetDiagnosticsSummary(12);
        if (!string.IsNullOrWhiteSpace(diagnostics) && !diagnostics.StartsWith("(no Visual Studio diagnostics", StringComparison.OrdinalIgnoreCase))
        {
            telemetry.DiagnosticsIncluded = true;
            sb.AppendLine();
            sb.AppendLine("Current Visual Studio diagnostics:");
            sb.AppendLine("```");
            sb.AppendLine(Truncate(diagnostics, 5000));
            sb.AppendLine("```");
        }
        var instructionInfo = tools.GetRepoInstructionInfo();
        if (!string.IsNullOrWhiteSpace(instructionInfo.Text))
        {
            telemetry.RepoInstructionSource = instructionInfo.Source;
            telemetry.RepoInstructionTruncated = instructionInfo.Truncated;
            telemetry.RepoInstructionCandidates = instructionInfo.Candidates.ToArray();
            sb.AppendLine();
            sb.AppendLine("Repository instructions:");
            sb.AppendLine("```");
            sb.AppendLine(instructionInfo.Text);
            sb.AppendLine("```");
        }
        if (!string.IsNullOrWhiteSpace(userText))
        {
            var relevant = tools.SearchRelevantFiles(userText!, 6);
            if (!string.IsNullOrWhiteSpace(relevant) && !relevant.StartsWith("ERROR", StringComparison.OrdinalIgnoreCase) && !relevant.StartsWith("(no relevant", StringComparison.OrdinalIgnoreCase))
            {
                telemetry.RelevantFilesIncluded = true;
                sb.AppendLine();
                sb.AppendLine("Likely relevant files for this turn:");
                sb.AppendLine("```");
                sb.AppendLine(Truncate(relevant, 6000));
                sb.AppendLine("```");
            }
        }
        return sb.ToString();
    }

#pragma warning disable OPENAI001
    private static ChatClientAgentRunOptions BuildRunOptions()
    {
        return new ChatClientAgentRunOptions
        {
            ChatOptions = new ChatOptions
            {
                RawRepresentationFactory = _ =>
                {
                    var opts = new CreateResponseOptions
                    {
                        ReasoningOptions = new ResponseReasoningOptions
                        {
                            ReasoningEffortLevel = ResponseReasoningEffortLevel.High,
                            ReasoningSummaryVerbosity = ResponseReasoningSummaryVerbosity.Auto
                        }
                    };
                    opts.IncludedProperties.Add(IncludedResponseProperty.ReasoningEncryptedContent);
                    return opts;
                }
            }
        };
    }
#pragma warning restore OPENAI001
}

internal sealed class ApimSubscriptionKeyPolicy : PipelinePolicy
{
    private readonly string key;
    public ApimSubscriptionKeyPolicy(string key) { this.key = key; }

    private void Apply(PipelineMessage message)
    {
        if (string.IsNullOrEmpty(key)) return;
        // APIM-fronted Foundry endpoints expect the AOAI "api-key" header.
        // The OpenAI SDK injects "Authorization: Bearer <key>" by default which APIM rejects (401),
        // so we strip it and replace with api-key. Also set Ocp-Apim-Subscription-Key for APIs
        // that gate on the APIM subscription header.
        message.Request.Headers.Remove("Authorization");
        message.Request.Headers.Set("api-key", key);
        message.Request.Headers.Set("Ocp-Apim-Subscription-Key", key);
    }

    public override void Process(PipelineMessage message, IReadOnlyList<PipelinePolicy> pipeline, int currentIndex)
    {
        Apply(message);
        ProcessNext(message, pipeline, currentIndex);
    }

    public override async ValueTask ProcessAsync(PipelineMessage message, IReadOnlyList<PipelinePolicy> pipeline, int currentIndex)
    {
        Apply(message);
        await ProcessNextAsync(message, pipeline, currentIndex).ConfigureAwait(false);
    }
}

internal sealed class StaticBearerTokenPolicy : PipelinePolicy
{
    private readonly string token;
    public StaticBearerTokenPolicy(string token) { this.token = token; }

    private void Apply(PipelineMessage message)
    {
        message.Request.Headers.Remove("api-key");
        message.Request.Headers.Remove("Ocp-Apim-Subscription-Key");
        message.Request.Headers.Set("Authorization", "Bearer " + token);
    }

    public override void Process(PipelineMessage message, IReadOnlyList<PipelinePolicy> pipeline, int currentIndex)
    {
        Apply(message);
        ProcessNext(message, pipeline, currentIndex);
    }

    public override async ValueTask ProcessAsync(PipelineMessage message, IReadOnlyList<PipelinePolicy> pipeline, int currentIndex)
    {
        Apply(message);
        await ProcessNextAsync(message, pipeline, currentIndex).ConfigureAwait(false);
    }
}

internal sealed class EntraBearerTokenPolicy : PipelinePolicy
{
    private readonly TokenCredential credential;
    private readonly TokenRequestContext requestContext;
    private readonly Action<string>? setDiagnostics;

    public EntraBearerTokenPolicy(TokenCredential credential, string[] scopes, Action<string>? setDiagnostics = null)
    {
        this.credential = credential;
        requestContext = new TokenRequestContext(scopes);
        this.setDiagnostics = setDiagnostics;
    }

    private void Apply(PipelineMessage message, string token)
    {
        message.Request.Headers.Remove("api-key");
        message.Request.Headers.Remove("Ocp-Apim-Subscription-Key");
        message.Request.Headers.Set("Authorization", "Bearer " + token);
        setDiagnostics?.Invoke(BuildTokenDiagnostics(token));
    }

    private static string BuildTokenDiagnostics(string token)
    {
        try
        {
            var parts = token.Split('.');
            if (parts.Length < 2) return "- Token claims: (unrecognized JWT format)\n";
            var payload = parts[1].Replace('-', '+').Replace('_', '/');
            switch (payload.Length % 4)
            {
                case 2: payload += "=="; break;
                case 3: payload += "="; break;
            }

            using var doc = JsonDocument.Parse(Convert.FromBase64String(payload));
            var root = doc.RootElement;
            return "- Token aud: " + GetClaim(root, "aud") + "\n" +
                "- Token iss: " + GetClaim(root, "iss") + "\n" +
                "- Token tid: " + GetClaim(root, "tid") + "\n" +
                "- Token app/client: " + FirstClaim(root, "azp", "appid", "client_id") + "\n" +
                "- Token scopes: " + GetClaim(root, "scp") + "\n";
        }
        catch (Exception ex)
        {
            return "- Token claims: (decode failed: " + ex.Message + ")\n";
        }
    }

    private static string FirstClaim(JsonElement root, params string[] names)
    {
        foreach (var name in names)
        {
            var value = GetClaim(root, name);
            if (value != "(missing)") return value;
        }
        return "(missing)";
    }

    private static string GetClaim(JsonElement root, string name)
    {
        if (!root.TryGetProperty(name, out var value)) return "(missing)";
        return value.ValueKind switch
        {
            JsonValueKind.String => value.GetString() ?? string.Empty,
            JsonValueKind.Array => string.Join(", ", value.EnumerateArray().Select(v => v.ToString())),
            _ => value.ToString()
        };
    }

    public override void Process(PipelineMessage message, IReadOnlyList<PipelinePolicy> pipeline, int currentIndex)
    {
        var token = credential.GetToken(requestContext, message.CancellationToken);
        Apply(message, token.Token);
        ProcessNext(message, pipeline, currentIndex);
    }

    public override async ValueTask ProcessAsync(PipelineMessage message, IReadOnlyList<PipelinePolicy> pipeline, int currentIndex)
    {
        var token = await credential.GetTokenAsync(requestContext, message.CancellationToken).ConfigureAwait(false);
        Apply(message, token.Token);
        await ProcessNextAsync(message, pipeline, currentIndex).ConfigureAwait(false);
    }
}

internal sealed class JuniorEntraTokenCredential : TokenCredential
{
    private static readonly AsyncLocal<bool?> InteractiveAuthAllowed = new();
    private readonly TokenCredential defaultCredential;
    private readonly TokenCredential interactiveCredential;
    private readonly object cacheLock = new();
    private readonly Dictionary<string, AccessToken> cachedTokens = new(StringComparer.Ordinal);

    public JuniorEntraTokenCredential(TokenCredential defaultCredential, TokenCredential interactiveCredential)
    {
        this.defaultCredential = defaultCredential;
        this.interactiveCredential = interactiveCredential;
    }

    public static IDisposable SetInteractiveAuthAllowed(bool allowed)
    {
        var prior = InteractiveAuthAllowed.Value;
        InteractiveAuthAllowed.Value = allowed;
        return new RestoreInteractiveAuthScope(prior);
    }

    public override AccessToken GetToken(TokenRequestContext requestContext, CancellationToken cancellationToken)
    {
        var cacheKey = BuildCacheKey(requestContext);
        if (TryGetCachedToken(cacheKey, out var cached)) return cached;

        if (IsInteractiveAuthAllowed())
        {
            try
            {
                var interactiveToken = interactiveCredential.GetToken(requestContext, cancellationToken);
                StoreToken(cacheKey, interactiveToken);
                return interactiveToken;
            }
            catch (Exception ex)
            {
                try { Console.Error.WriteLine("AUTH: interactive credential unavailable; trying non-interactive credentials: " + ex.Message); } catch { }
            }
        }

        try
        {
            var token = defaultCredential.GetToken(requestContext, cancellationToken);
            StoreToken(cacheKey, token);
            return token;
        }
        catch (Exception ex)
        {
            try { Console.Error.WriteLine("AUTH: non-interactive credential unavailable: " + ex.Message); } catch { }
            if (!IsInteractiveAuthAllowed())
                throw new CredentialUnavailableException("No cached Microsoft Entra ID token is available for this background request. Sign in from Junior Chat first.");
            throw;
        }
    }

    public override async ValueTask<AccessToken> GetTokenAsync(TokenRequestContext requestContext, CancellationToken cancellationToken)
    {
        var cacheKey = BuildCacheKey(requestContext);
        if (TryGetCachedToken(cacheKey, out var cached)) return cached;

        if (IsInteractiveAuthAllowed())
        {
            try
            {
                var interactiveToken = await interactiveCredential.GetTokenAsync(requestContext, cancellationToken).ConfigureAwait(false);
                StoreToken(cacheKey, interactiveToken);
                return interactiveToken;
            }
            catch (Exception ex)
            {
                try { Console.Error.WriteLine("AUTH: interactive credential unavailable; trying non-interactive credentials: " + ex.Message); } catch { }
            }
        }

        try
        {
            var token = await defaultCredential.GetTokenAsync(requestContext, cancellationToken).ConfigureAwait(false);
            StoreToken(cacheKey, token);
            return token;
        }
        catch (Exception ex)
        {
            try { Console.Error.WriteLine("AUTH: non-interactive credential unavailable: " + ex.Message); } catch { }
            if (!IsInteractiveAuthAllowed())
                throw new CredentialUnavailableException("No cached Microsoft Entra ID token is available for this background request. Sign in from Junior Chat first.");
            throw;
        }
    }

    private static bool IsInteractiveAuthAllowed()
    {
        return InteractiveAuthAllowed.Value ?? true;
    }

    private static string BuildCacheKey(TokenRequestContext requestContext)
    {
        return string.Join("\n", requestContext.Scopes ?? Array.Empty<string>());
    }

    private bool TryGetCachedToken(string cacheKey, out AccessToken token)
    {
        lock (cacheLock)
        {
            if (cachedTokens.TryGetValue(cacheKey, out token) && token.ExpiresOn > DateTimeOffset.UtcNow.AddMinutes(5))
                return true;
        }

        token = default;
        return false;
    }

    private void StoreToken(string cacheKey, AccessToken token)
    {
        if (string.IsNullOrEmpty(token.Token)) return;
        lock (cacheLock)
        {
            cachedTokens[cacheKey] = token;
        }
    }

    private sealed class RestoreInteractiveAuthScope : IDisposable
    {
        private readonly bool? prior;

        public RestoreInteractiveAuthScope(bool? prior)
        {
            this.prior = prior;
        }

        public void Dispose()
        {
            InteractiveAuthAllowed.Value = prior;
        }
    }
}

internal enum ProviderAuthMode
{
    ApiKey,
    BearerToken,
    EntraId
}
