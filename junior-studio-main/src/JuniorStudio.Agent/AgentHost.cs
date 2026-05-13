using System.ClientModel;
using System.ClientModel.Primitives;
using System.Text;
using Azure.AI.OpenAI;
using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;
using OpenAI;
using OpenAI.Responses;

namespace JuniorStudio.Agent;

internal sealed class AgentHost
{
    private const int MaxIterationsPerRequest = 40;

    private readonly Dictionary<string, AIAgent> agents = new(StringComparer.OrdinalIgnoreCase);
    private IChatClient? chatClient;
    private readonly List<ChatMessage> history = new();
    private readonly WorkspaceTools tools = new();
    private string baseSystemPrompt = DefaultAgentSystemPrompt;

    private const string DefaultAgentSystemPrompt =
        "You are Junior Studio, an autonomous AI coding assistant running inside Visual Studio. " +
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
        "- If no workspace is currently open, call CreateWorkspaceFolder('<name>') FIRST to bootstrap one before creating any files.";

    private const string PlanModeSystemPrompt =
        "You are Junior Studio in PLAN MODE. Your job is to produce a clear, actionable implementation plan for the user's request — you must NOT modify the workspace.\n\n" +
        "PLAN MODE RULES:\n" +
        "1. You may use READ-ONLY tools (GetWorkspaceTree, ListWorkspaceFiles, FindFiles, ReadFile, ListDir, SearchText, GetWorkspaceRoot, FindSymbol, GetFileOutline, FindSymbolReferences) to investigate the codebase.\n" +
        "2. You MUST NOT call any write/create/delete/shell tools. They are not available in this mode.\n" +
        "3. Investigate first, then output ONE final plan and stop. Do not loop forever.\n\n" +
        "OUTPUT FORMAT:\n" +
        "- Start with a 1-2 sentence summary of what you understood and what the plan will accomplish.\n" +
        "- Follow with a numbered list of concrete steps (file paths, function names, commands the user would run).\n" +
        "- Call out risks, open questions, or assumptions in a final 'Notes' section.\n" +
        "- End by inviting the user to switch to Agent mode to execute the plan.";

    private const string AskModeSystemPrompt =
        "You are Junior Studio in ASK MODE. Answer the user's question conversationally.\n\n" +
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

        var apiKey = cfg.ApiKey ?? string.Empty;

        IChatClient innerClient;
        if (provider.Equals("Direct", StringComparison.OrdinalIgnoreCase))
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
            if (provider.Equals("Apim", StringComparison.OrdinalIgnoreCase) && !root.EndsWith("/openai/v1", StringComparison.OrdinalIgnoreCase))
            {
                root = root + "/openai/v1";
            }

            var openAiOptions = new OpenAIClientOptions
            {
                Endpoint = new Uri(root),
                NetworkTimeout = TimeSpan.FromMinutes(5)
            };

            if (provider.Equals("Apim", StringComparison.OrdinalIgnoreCase))
            {
                openAiOptions.AddPolicy(new ApimSubscriptionKeyPolicy(apiKey), PipelinePosition.PerCall);
            }

            var openAiClient = new OpenAIClient(new ApiKeyCredential(apiKey), openAiOptions);
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
        var newAgent = new ChatClientAgent(chatClient, instructions: rooted, name: "Junior", tools: modeTools);
        agents[key] = newAgent;
        return newAgent;
    }

    public async IAsyncEnumerable<object> SendMessageAsync(string text, List<string>? images = null, List<AttachedFile>? files = null, string? mode = null, [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct = default)
    {
        var modeKey = (mode ?? "agent").Trim().ToLowerInvariant();
        if (modeKey != "agent" && modeKey != "plan" && modeKey != "ask") modeKey = "agent";
        var agent = GetOrBuildAgent(modeKey);
        if (agent is null)
        {
            yield return new { type = "error", message = "Agent is not configured. Open Tools > Options > Junior Studio and set the provider/endpoint/key/deployment." };
            yield break;
        }

        currentCts?.Dispose();
        currentCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var token = currentCts.Token;

        yield return new { type = "agentBegin" };

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
        history.Add(new ChatMessage(ChatRole.User, userContents));

        // Per-turn transient system message giving the model an up-to-date view of
        // the workspace. This is NOT persisted to history (next turn rebuilds it).
        var turnHistory = new List<ChatMessage>(history.Count + 1);
        var overview = BuildWorkspaceOverview();
        if (!string.IsNullOrEmpty(overview))
            turnHistory.Add(new ChatMessage(ChatRole.System, overview));
        turnHistory.AddRange(history);

        var assistantText = new StringBuilder();
        var narrationBuffer = new StringBuilder();
        var seenCalls = new HashSet<string>(StringComparer.Ordinal);
        var seenResults = new HashSet<string>(StringComparer.Ordinal);
        long turnInputTokens = 0;
        long turnOutputTokens = 0;
        long turnTotalTokens = 0;
        long turnReasoningTokens = 0;
        long turnCachedInputTokens = 0;
        bool sawUsage = false;
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
                    errorMessage = ex.Message;
                    hasMore = false;
                }

                if (errorMessage is not null)
                {
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

        // If we used a lot of tool calls and the model didn't return a clean final answer,
        // we likely hit MaximumIterationsPerRequest. Ask the user whether to continue.
        var iterationCount = seenCalls.Count;
        var finishedCleanly = assistantText.ToString().Trim().Length > 0
                              && seenResults.Count >= seenCalls.Count;
        if (iterationCount >= MaxIterationsPerRequest || (iterationCount > 0 && !finishedCleanly))
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
            case "RunShell":
            {
                var cmd = GetArg("command") ?? "";
                return ("run", $"Running: {Truncate(cmd, 80)}", null);
            }
            default:
                return ("run", name ?? "tool", null);
        }
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
    private string BuildWorkspaceOverview()
    {
        var root = tools.WorkspaceRoot;
        if (string.IsNullOrEmpty(root)) return string.Empty;

        // Block briefly on first call so the model sees a real tree, not "(loading)".
        tools.Index.WaitForInitialScan(2500);

        var tree = tools.Index.BuildTreeSnapshot(120);
        var count = tools.Index.Count;
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
