using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Azure.Core;
using Azure.Identity;
using Microsoft.Extensions.AI;

namespace JuniorStudio.Agent;

internal sealed class McpClient : IDisposable
{
    private const string ProtocolVersion = "2024-11-05";
    private readonly Dictionary<string, McpConnection> connections = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, (string ServerName, string ToolName)> toolNameMap = new(StringComparer.Ordinal);
    private readonly HashSet<string> disabledToolNames = new(StringComparer.Ordinal);
    private readonly JsonSerializerOptions jsonOptions = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    private string serversJson = string.Empty;
    private string authorityHost = "https://login.microsoftonline.com/";
    private string tenantId = string.Empty;
    private string clientId = string.Empty;
    private bool enabled;
    private bool connected;

    public bool Enabled => enabled;
    public int ConnectedServerCount => connections.Count;
    public int ToolCount => connections.Values.Sum(c => c.Tools.Count);

    public void Configure(bool isEnabled, string? mcpServersJson, string? authorityHost, string? tenantId, string? clientId)
    {
        var nextJson = mcpServersJson?.Trim() ?? string.Empty;
        var nextAuthority = string.IsNullOrWhiteSpace(authorityHost) ? "https://login.microsoftonline.com/" : authorityHost!.Trim();
        var nextTenant = tenantId?.Trim() ?? string.Empty;
        var nextClient = clientId?.Trim() ?? string.Empty;

        if (enabled == isEnabled
            && string.Equals(serversJson, nextJson, StringComparison.Ordinal)
            && string.Equals(this.authorityHost, nextAuthority, StringComparison.OrdinalIgnoreCase)
            && string.Equals(this.tenantId, nextTenant, StringComparison.OrdinalIgnoreCase)
            && string.Equals(this.clientId, nextClient, StringComparison.OrdinalIgnoreCase))
        {
            Log("MCP: configuration unchanged; reusing existing connections and auth state.");
            return;
        }

        Log("MCP: configuration changed; reconnecting servers.");
        DisconnectAll();
        enabled = isEnabled;
        serversJson = nextJson;
        this.authorityHost = nextAuthority;
        this.tenantId = nextTenant;
        this.clientId = nextClient;
        connected = false;
    }

    public IList<AITool> AsAITools()
    {
        var tools = new List<AITool>();
        foreach (var entry in BuildToolEntries())
        {
            if (disabledToolNames.Contains(entry.FunctionName)) continue;
            tools.Add(new McpAITool(this, entry.FunctionName, entry.ServerName, entry.Tool));
        }

        return tools;
    }

    public object[] GetToolSummaries()
    {
        return BuildToolEntries()
            .Select(entry => new
            {
                functionName = entry.FunctionName,
                serverName = entry.ServerName,
                name = entry.Tool.Name,
                description = entry.Tool.Description,
                enabled = !disabledToolNames.Contains(entry.FunctionName)
            })
            .Cast<object>()
            .ToArray();
    }

    public void SetToolEnabled(string functionName, bool isEnabled)
    {
        if (string.IsNullOrWhiteSpace(functionName)) return;
        if (isEnabled) disabledToolNames.Remove(functionName.Trim());
        else disabledToolNames.Add(functionName.Trim());
    }

    private List<McpToolEntry> BuildToolEntries()
    {
        toolNameMap.Clear();
        var usedNames = new HashSet<string>(StringComparer.Ordinal);
        var entries = new List<McpToolEntry>();

        foreach (var conn in connections.Values.OrderBy(c => c.ServerName, StringComparer.OrdinalIgnoreCase))
        {
            foreach (var tool in conn.Tools.OrderBy(t => t.Name, StringComparer.OrdinalIgnoreCase))
            {
                var functionName = MakeFunctionName(conn.ServerName, tool.Name, usedNames);
                toolNameMap[functionName] = (conn.ServerName, tool.Name);
                entries.Add(new McpToolEntry(functionName, conn.ServerName, tool));
            }
        }

        return entries;
    }

    public async Task EnsureConnectedAsync(CancellationToken ct)
    {
        if (!enabled || connected) return;
        connected = true;

        var servers = ParseServers(serversJson);
        foreach (var (name, config) in servers)
        {
            ct.ThrowIfCancellationRequested();
            try
            {
                await ConnectServerAsync(name, config, ct).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                Log($"MCP: failed to connect '{name}': {ex.Message}");
            }
        }

        Log($"MCP: connected {connections.Count} server(s), {ToolCount} tool(s).");
    }

    private async Task<string> CallToolAsync(string functionName, IReadOnlyDictionary<string, object?> args, CancellationToken ct)
    {
        if (!toolNameMap.TryGetValue(functionName, out var mapped))
        {
            return $"ERROR: MCP tool '{functionName}' is not mapped.";
        }

        if (!connections.TryGetValue(mapped.ServerName, out var conn))
        {
            return $"ERROR: MCP server '{mapped.ServerName}' is not connected.";
        }

        try
        {
            var result = await SendRequestAsync(conn, "tools/call", new
            {
                name = mapped.ToolName,
                arguments = NormalizeJsonValue(args)
            }, TimeSpan.FromSeconds(30), ct).ConfigureAwait(false);

            if (result.ValueKind == JsonValueKind.Undefined || result.ValueKind == JsonValueKind.Null)
                return "No response";

            if (result.TryGetProperty("content", out var content) && content.ValueKind == JsonValueKind.Array)
            {
                var text = new StringBuilder();
                foreach (var item in content.EnumerateArray())
                {
                    if (item.TryGetProperty("type", out var type)
                        && string.Equals(type.GetString(), "text", StringComparison.OrdinalIgnoreCase)
                        && item.TryGetProperty("text", out var textNode))
                    {
                        if (text.Length > 0) text.AppendLine();
                        text.Append(textNode.GetString());
                    }
                }

                if (text.Length > 0) return text.ToString();
            }

            return result.GetRawText();
        }
        catch (Exception ex)
        {
            return "ERROR: MCP tool call failed: " + ex.Message;
        }
    }

    private async Task ConnectServerAsync(string name, McpServerConfig config, CancellationToken ct)
    {
        if (!string.IsNullOrWhiteSpace(config.Url))
        {
            await ConnectHttpServerAsync(name, config, ct).ConfigureAwait(false);
            return;
        }

        if (!string.IsNullOrWhiteSpace(config.Command))
        {
            await ConnectStdioServerAsync(name, config, ct).ConfigureAwait(false);
            return;
        }

        throw new InvalidOperationException("MCP server config must include either 'url' or 'command'.");
    }

    private async Task ConnectHttpServerAsync(string name, McpServerConfig config, CancellationToken ct)
    {
        var conn = new HttpMcpConnection(name, config.Url!.TrimEnd('/'));
        conn.Headers = await ResolveHttpHeadersAsync(name, config, ct).ConfigureAwait(false);
        connections[name] = conn;

        try
        {
            await InitializeAsync(conn, ct).ConfigureAwait(false);
            Log($"MCP: '{name}' connected over HTTP with {conn.Tools.Count} tool(s).");
        }
        catch
        {
            connections.Remove(name);
            throw;
        }
    }

    private async Task ConnectStdioServerAsync(string name, McpServerConfig config, CancellationToken ct)
    {
        var spawn = NormalizeStdioSpawn(config.Command!, config.Args ?? Array.Empty<string>());
        var startInfo = new ProcessStartInfo
        {
            FileName = spawn.Command,
            UseShellExecute = false,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
            WorkingDirectory = string.IsNullOrWhiteSpace(config.Cwd) ? Directory.GetCurrentDirectory() : config.Cwd
        };

        foreach (var arg in spawn.Args) startInfo.ArgumentList.Add(arg);
        foreach (var pair in config.Env ?? new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase))
            startInfo.Environment[pair.Key] = pair.Value;

        var process = Process.Start(startInfo) ?? throw new InvalidOperationException("Failed to start MCP server process.");
        var conn = new StdioMcpConnection(name, process);
        connections[name] = conn;

        _ = Task.Run(() => PumpStderrAsync(conn), CancellationToken.None);
        _ = Task.Run(() => PumpStdoutAsync(conn), CancellationToken.None);

        try
        {
            await InitializeAsync(conn, ct).ConfigureAwait(false);
            Log($"MCP: '{name}' connected over stdio with {conn.Tools.Count} tool(s).");
        }
        catch
        {
            DisconnectServer(name);
            throw;
        }
    }

    private async Task InitializeAsync(McpConnection conn, CancellationToken ct)
    {
        await SendRequestAsync(conn, "initialize", new
        {
            protocolVersion = ProtocolVersion,
            capabilities = new { },
            clientInfo = new { name = "Junior", version = "1.0.0" }
        }, TimeSpan.FromSeconds(30), ct).ConfigureAwait(false);

        await SendNotificationAsync(conn, "initialized", new { }, ct).ConfigureAwait(false);

        var toolsResult = await SendRequestAsync(conn, "tools/list", new { }, TimeSpan.FromSeconds(15), ct).ConfigureAwait(false);
        if (toolsResult.ValueKind != JsonValueKind.Object || !toolsResult.TryGetProperty("tools", out var toolsNode) || toolsNode.ValueKind != JsonValueKind.Array)
            return;

        foreach (var toolNode in toolsNode.EnumerateArray())
        {
            var toolName = toolNode.TryGetProperty("name", out var nameNode) ? nameNode.GetString() : null;
            if (string.IsNullOrWhiteSpace(toolName)) continue;

            var description = toolNode.TryGetProperty("description", out var descriptionNode) ? descriptionNode.GetString() ?? string.Empty : string.Empty;
            JsonElement schema;
            if (toolNode.TryGetProperty("inputSchema", out var schemaNode) && schemaNode.ValueKind == JsonValueKind.Object)
                schema = schemaNode.Clone();
            else
                schema = CreateDefaultSchema();

            conn.Tools.Add(new McpToolInfo(toolName!, description, schema));
        }
    }

    private Task<JsonElement> SendRequestAsync(McpConnection conn, string method, object parameters, TimeSpan timeout, CancellationToken ct)
    {
        return conn switch
        {
            HttpMcpConnection http => SendHttpRequestAsync(http, method, parameters, timeout, ct),
            StdioMcpConnection stdio => SendStdioRequestAsync(stdio, method, parameters, timeout, ct),
            _ => throw new InvalidOperationException("Unknown MCP connection type.")
        };
    }

    private Task SendNotificationAsync(McpConnection conn, string method, object parameters, CancellationToken ct)
    {
        return conn switch
        {
            HttpMcpConnection http => SendHttpNotificationAsync(http, method, parameters, ct),
            StdioMcpConnection stdio => SendStdioNotificationAsync(stdio, method, parameters, ct),
            _ => throw new InvalidOperationException("Unknown MCP connection type.")
        };
    }

    private async Task<JsonElement> SendHttpRequestAsync(HttpMcpConnection conn, string method, object parameters, TimeSpan timeout, CancellationToken ct)
    {
        var id = conn.NextId++;
        var payload = JsonSerializer.Serialize(new JsonRpcRequest(id, method, parameters), jsonOptions);
        var response = await HttpPostAsync(conn, payload, timeout, ct).ConfigureAwait(false);
        return ParseHttpResponse(conn.ServerName, response.Body, response.ContentType, id);
    }

    private async Task SendHttpNotificationAsync(HttpMcpConnection conn, string method, object parameters, CancellationToken ct)
    {
        var payload = JsonSerializer.Serialize(new JsonRpcNotification(method, parameters), jsonOptions);
        try { await HttpPostAsync(conn, payload, TimeSpan.FromSeconds(5), ct).ConfigureAwait(false); }
        catch (Exception ex) { Log($"MCP: notification '{method}' to '{conn.ServerName}' failed: {ex.Message}"); }
    }

    private async Task<HttpPostResult> HttpPostAsync(HttpMcpConnection conn, string payload, TimeSpan timeout, CancellationToken ct)
    {
        using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        linkedCts.CancelAfter(timeout);

        using var handler = new HttpClientHandler();
        handler.AutomaticDecompression = DecompressionMethods.All;
        using var client = new HttpClient(handler) { Timeout = timeout };
        using var request = new HttpRequestMessage(HttpMethod.Post, conn.BaseUrl);
        request.Content = new StringContent(payload, Encoding.UTF8, "application/json");
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("text/event-stream"));
        if (!string.IsNullOrWhiteSpace(conn.SessionId)) request.Headers.TryAddWithoutValidation("Mcp-Session-Id", conn.SessionId);

        foreach (var pair in conn.Headers)
        {
            if (!request.Headers.TryAddWithoutValidation(pair.Key, pair.Value))
                request.Content.Headers.TryAddWithoutValidation(pair.Key, pair.Value);
        }

        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, linkedCts.Token).ConfigureAwait(false);
        if (response.Headers.TryGetValues("Mcp-Session-Id", out var sessionIds))
            conn.SessionId = sessionIds.FirstOrDefault();

        var body = await response.Content.ReadAsStringAsync(linkedCts.Token).ConfigureAwait(false);
        var contentType = response.Content.Headers.ContentType?.MediaType ?? string.Empty;
        if (!response.IsSuccessStatusCode)
            throw new InvalidOperationException($"HTTP {(int)response.StatusCode}: {Truncate(body, 500)}");

        return new HttpPostResult(body, contentType);
    }

    private JsonElement ParseHttpResponse(string serverName, string body, string contentType, int requestId)
    {
        if (contentType.IndexOf("text/event-stream", StringComparison.OrdinalIgnoreCase) >= 0)
            return ParseSseResponse(serverName, body, requestId);

        using var doc = JsonDocument.Parse(body);
        var root = doc.RootElement;
        if (root.TryGetProperty("error", out var error) && error.ValueKind != JsonValueKind.Null)
            throw new InvalidOperationException(GetJsonRpcErrorMessage(error));
        if (root.TryGetProperty("result", out var result)) return result.Clone();
        return root.Clone();
    }

    private JsonElement ParseSseResponse(string serverName, string body, int requestId)
    {
        JsonElement? fallback = null;
        using var docHolder = new JsonDocumentHolder();
        foreach (var rawLine in body.Split('\n'))
        {
            var line = rawLine.TrimEnd('\r');
            if (!line.StartsWith("data:", StringComparison.OrdinalIgnoreCase)) continue;
            var data = line.Substring(5).Trim();
            if (data.Length == 0 || string.Equals(data, "[DONE]", StringComparison.OrdinalIgnoreCase)) continue;

            try
            {
                using var doc = JsonDocument.Parse(data);
                var root = doc.RootElement;
                if (root.TryGetProperty("id", out var idNode) && idNode.ValueKind == JsonValueKind.Number && idNode.GetInt32() == requestId)
                {
                    if (root.TryGetProperty("error", out var error) && error.ValueKind != JsonValueKind.Null)
                        throw new InvalidOperationException(GetJsonRpcErrorMessage(error));
                    if (root.TryGetProperty("result", out var result)) return result.Clone();
                    return root.Clone();
                }

                if (root.TryGetProperty("result", out var fallbackResult)) fallback = fallbackResult.Clone();
                else if (root.TryGetProperty("tools", out _) || root.TryGetProperty("capabilities", out _)) fallback = root.Clone();
            }
            catch (JsonException)
            {
                Log($"MCP: '{serverName}' skipped non-JSON SSE data: {Truncate(data, 120)}");
            }
        }

        return fallback ?? CreateDefaultObject();
    }

    private Task<JsonElement> SendStdioRequestAsync(StdioMcpConnection conn, string method, object parameters, TimeSpan timeout, CancellationToken ct)
    {
        var id = conn.NextId++;
        var payload = JsonSerializer.Serialize(new JsonRpcRequest(id, method, parameters), jsonOptions) + "\n";
        var pending = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
        conn.Pending[id] = pending;

        var bytes = Encoding.UTF8.GetBytes(payload);
        try
        {
            conn.Process.StandardInput.BaseStream.Write(bytes, 0, bytes.Length);
            conn.Process.StandardInput.BaseStream.Flush();
        }
        catch (Exception ex)
        {
            conn.Pending.TryRemove(id, out _);
            throw new InvalidOperationException("Failed to write to MCP stdio server: " + ex.Message, ex);
        }

        return AwaitPendingAsync(conn, id, pending, timeout, ct);
    }

    private Task SendStdioNotificationAsync(StdioMcpConnection conn, string method, object parameters, CancellationToken ct)
    {
        var payload = JsonSerializer.Serialize(new JsonRpcNotification(method, parameters), jsonOptions) + "\n";
        var bytes = Encoding.UTF8.GetBytes(payload);
        conn.Process.StandardInput.BaseStream.Write(bytes, 0, bytes.Length);
        conn.Process.StandardInput.BaseStream.Flush();
        return Task.CompletedTask;
    }

    private static async Task<JsonElement> AwaitPendingAsync(StdioMcpConnection conn, int id, TaskCompletionSource<JsonElement> pending, TimeSpan timeout, CancellationToken ct)
    {
        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var delayTask = Task.Delay(timeout, timeoutCts.Token);
        var completed = await Task.WhenAny(pending.Task, delayTask).ConfigureAwait(false);
        if (completed == pending.Task)
        {
            timeoutCts.Cancel();
            return await pending.Task.ConfigureAwait(false);
        }

        conn.Pending.TryRemove(id, out _);
        ct.ThrowIfCancellationRequested();
        throw new TimeoutException("Request timed out.");
    }

    private async Task PumpStdoutAsync(StdioMcpConnection conn)
    {
        var buffer = new byte[8192];
        try
        {
            while (!conn.Process.HasExited)
            {
                var read = await conn.Process.StandardOutput.BaseStream.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false);
                if (read <= 0) break;
                ProcessStdioBytes(conn, buffer.AsSpan(0, read).ToArray());
            }
        }
        catch (Exception ex)
        {
            Log($"MCP: stdout pump for '{conn.ServerName}' failed: {ex.Message}");
        }
    }

    private async Task PumpStderrAsync(StdioMcpConnection conn)
    {
        try
        {
            while (!conn.Process.HasExited)
            {
                var line = await conn.Process.StandardError.ReadLineAsync().ConfigureAwait(false);
                if (line is null) break;
                Log($"MCP[{conn.ServerName} stderr]: {line}");
            }
        }
        catch { }
    }

    private void ProcessStdioBytes(StdioMcpConnection conn, byte[] bytes)
    {
        lock (conn.BufferLock)
        {
            conn.Buffer.AddRange(bytes);
            while (conn.Buffer.Count > 0)
            {
                var header = Encoding.ASCII.GetBytes("Content-Length:");
                if (StartsWith(conn.Buffer, header))
                {
                    if (!TryReadContentLengthMessage(conn, out var contentMessage)) break;
                    HandleStdioMessage(conn, contentMessage);
                    continue;
                }

                var newline = conn.Buffer.IndexOf((byte)'\n');
                if (newline < 0) break;
                var lineBytes = conn.Buffer.Take(newline).ToArray();
                conn.Buffer.RemoveRange(0, newline + 1);
                var line = Encoding.UTF8.GetString(lineBytes).TrimEnd('\r').Trim();
                if (line.Length > 0) HandleStdioMessage(conn, line);
            }
        }
    }

    private static bool StartsWith(List<byte> buffer, byte[] prefix)
    {
        if (buffer.Count < prefix.Length) return false;
        for (var i = 0; i < prefix.Length; i++)
            if (buffer[i] != prefix[i]) return false;
        return true;
    }

    private static bool TryReadContentLengthMessage(StdioMcpConnection conn, out string message)
    {
        message = string.Empty;
        var buffer = conn.Buffer;
        var separator = IndexOf(buffer, Encoding.ASCII.GetBytes("\r\n\r\n"));
        var separatorLength = 4;
        if (separator < 0)
        {
            separator = IndexOf(buffer, Encoding.ASCII.GetBytes("\n\n"));
            separatorLength = 2;
        }
        if (separator < 0) return false;

        var headerText = Encoding.ASCII.GetString(buffer.Take(separator).ToArray());
        var lengthLine = headerText.Split(new[] { "\r\n", "\n" }, StringSplitOptions.None)
            .FirstOrDefault(l => l.StartsWith("Content-Length:", StringComparison.OrdinalIgnoreCase));
        if (lengthLine is null || !int.TryParse(lengthLine.Substring("Content-Length:".Length).Trim(), out var contentLength))
        {
            buffer.RemoveRange(0, separator + separatorLength);
            return true;
        }

        var bodyStart = separator + separatorLength;
        if (buffer.Count < bodyStart + contentLength) return false;
        message = Encoding.UTF8.GetString(buffer.Skip(bodyStart).Take(contentLength).ToArray());
        buffer.RemoveRange(0, bodyStart + contentLength);
        return true;
    }

    private static int IndexOf(List<byte> buffer, byte[] needle)
    {
        for (var i = 0; i <= buffer.Count - needle.Length; i++)
        {
            var found = true;
            for (var j = 0; j < needle.Length; j++)
            {
                if (buffer[i + j] == needle[j]) continue;
                found = false;
                break;
            }
            if (found) return i;
        }
        return -1;
    }

    private void HandleStdioMessage(StdioMcpConnection conn, string body)
    {
        try
        {
            using var doc = JsonDocument.Parse(body);
            var root = doc.RootElement;
            if (root.TryGetProperty("id", out var idNode) && idNode.ValueKind == JsonValueKind.Number)
            {
                var id = idNode.GetInt32();
                if (conn.Pending.TryRemove(id, out var pending))
                {
                    if (root.TryGetProperty("error", out var error) && error.ValueKind != JsonValueKind.Null)
                        pending.TrySetException(new InvalidOperationException(GetJsonRpcErrorMessage(error)));
                    else if (root.TryGetProperty("result", out var result))
                        pending.TrySetResult(result.Clone());
                    else
                        pending.TrySetResult(CreateDefaultObject());
                }
                return;
            }

            Log($"MCP[{conn.ServerName}]: notification {Truncate(body, 300)}");
        }
        catch (Exception ex)
        {
            Log($"MCP[{conn.ServerName}]: failed to parse message: {ex.Message}; {Truncate(body, 200)}");
        }
    }

    private async Task<Dictionary<string, string>> ResolveHttpHeadersAsync(string name, McpServerConfig config, CancellationToken ct)
    {
        var headers = new Dictionary<string, string>(config.Headers ?? new Dictionary<string, string>(), StringComparer.OrdinalIgnoreCase);
        if (headers.ContainsKey("Authorization") || config.AuthSession is null) return headers;

        var scopes = GetConfiguredScopes(config.AuthSession.Scopes).ToArray();
        if (scopes.Length == 0)
        {
            Log($"MCP: authSession for '{name}' has no usable scopes; continuing without auth header.");
            return headers;
        }

        if (!IsMicrosoftAuthProvider(config.AuthSession.ProviderId))
        {
            Log($"MCP: authSession provider '{config.AuthSession.ProviderId}' for '{name}' is not supported in Visual Studio sidecar; continuing without auth header.");
            return headers;
        }

        var credential = BuildCredential(config.AuthSession);
        var token = await credential.GetTokenAsync(new TokenRequestContext(scopes), ct).ConfigureAwait(false);
        var header = string.IsNullOrWhiteSpace(config.AuthSession.TokenHeader) ? "Authorization" : config.AuthSession.TokenHeader!.Trim();
        var scheme = config.AuthSession.TokenScheme ?? "Bearer";
        headers[header] = string.IsNullOrWhiteSpace(scheme) ? token.Token : scheme + " " + token.Token;
        Log($"MCP: using Entra authSession for '{name}' ({string.Join(", ", scopes)}).");
        return headers;
    }

    private TokenCredential BuildCredential(McpAuthSessionConfig auth)
    {
        var authTenant = FirstNonEmpty(GetPseudoScopeValue(auth.Scopes, "VSCODE_TENANT"), tenantId);
        var authClient = FirstNonEmpty(GetPseudoScopeValue(auth.Scopes, "VSCODE_CLIENT_ID"), clientId);
        var authority = ResolveAuthorityHost(authorityHost);

        var defaultOptions = new DefaultAzureCredentialOptions
        {
            AuthorityHost = authority,
            TenantId = string.IsNullOrWhiteSpace(authTenant) ? null : authTenant,
            ExcludeInteractiveBrowserCredential = true
        };

        if (auth.CreateIfNone == false)
            return new DefaultAzureCredential(defaultOptions);

        var interactiveOptions = new InteractiveBrowserCredentialOptions
        {
            AuthorityHost = authority,
            TenantId = string.IsNullOrWhiteSpace(authTenant) ? null : authTenant,
            ClientId = string.IsNullOrWhiteSpace(authClient) ? null : authClient,
            TokenCachePersistenceOptions = CreateTokenCacheOptions()
        };

        return new JuniorEntraTokenCredential(new DefaultAzureCredential(defaultOptions), new InteractiveBrowserCredential(interactiveOptions));
    }

    private static TokenCachePersistenceOptions CreateTokenCacheOptions()
    {
        return new TokenCachePersistenceOptions
        {
            Name = "JuniorStudio"
        };
    }

    private static Uri ResolveAuthorityHost(string value)
    {
        var trimmed = string.IsNullOrWhiteSpace(value) ? "https://login.microsoftonline.com/" : value.Trim();
        if (!trimmed.EndsWith("/", StringComparison.Ordinal)) trimmed += "/";
        return new Uri(trimmed);
    }

    private static bool IsMicrosoftAuthProvider(string? providerId)
    {
        if (string.IsNullOrWhiteSpace(providerId)) return true;
        return providerId.Equals("microsoft", StringComparison.OrdinalIgnoreCase)
            || providerId.Equals("microsoft-sovereign-cloud", StringComparison.OrdinalIgnoreCase)
            || providerId.Equals("azure", StringComparison.OrdinalIgnoreCase)
            || providerId.Equals("entra", StringComparison.OrdinalIgnoreCase);
    }

    private static IEnumerable<string> GetConfiguredScopes(IEnumerable<string>? scopes)
    {
        return (scopes ?? Array.Empty<string>())
            .Select(s => (s ?? string.Empty).Trim())
            .Where(s => s.Length > 0)
            .Where(s => !s.StartsWith("VSCODE_CLIENT_ID:", StringComparison.OrdinalIgnoreCase))
            .Where(s => !s.StartsWith("VSCODE_TENANT:", StringComparison.OrdinalIgnoreCase))
            .Distinct(StringComparer.OrdinalIgnoreCase);
    }

    private static string? GetPseudoScopeValue(IEnumerable<string>? scopes, string key)
    {
        var prefix = key + ":";
        return scopes?
            .Select(s => (s ?? string.Empty).Trim())
            .FirstOrDefault(s => s.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            ?[prefix.Length..]
            .Trim();
    }

    private static string FirstNonEmpty(params string?[] values)
    {
        foreach (var value in values)
            if (!string.IsNullOrWhiteSpace(value)) return value.Trim();
        return string.Empty;
    }

    private Dictionary<string, McpServerConfig> ParseServers(string json)
    {
        if (string.IsNullOrWhiteSpace(json)) return new Dictionary<string, McpServerConfig>(StringComparer.OrdinalIgnoreCase);
        try
        {
            var readOptions = new JsonSerializerOptions(jsonOptions)
            {
                ReadCommentHandling = JsonCommentHandling.Skip,
                AllowTrailingCommas = true
            };
            return JsonSerializer.Deserialize<Dictionary<string, McpServerConfig>>(json, readOptions)
                ?? new Dictionary<string, McpServerConfig>(StringComparer.OrdinalIgnoreCase);
        }
        catch (Exception ex)
        {
            Log("MCP: failed to parse MCP Servers JSON: " + ex.Message);
            return new Dictionary<string, McpServerConfig>(StringComparer.OrdinalIgnoreCase);
        }
    }

    private static StdioSpawnSpec NormalizeStdioSpawn(string command, IReadOnlyList<string> args)
    {
        if (!OperatingSystem.IsWindows()) return new StdioSpawnSpec(command, args.ToArray());
        var resolved = ResolveWindowsCommandPath(command);
        var extension = Path.GetExtension(resolved).ToLowerInvariant();
        if (extension is ".cmd" or ".bat")
            return new StdioSpawnSpec(Environment.GetEnvironmentVariable("ComSpec") ?? "cmd.exe", new[] { "/d", "/s", "/c", BuildWindowsCommandLine(resolved, args) });
        if (extension is ".ps1" or ".psm1")
            return new StdioSpawnSpec("powershell.exe", new[] { "-NoProfile", "-NoLogo", "-File", resolved }.Concat(args).ToArray());
        return new StdioSpawnSpec(resolved, args.ToArray());
    }

    private static string ResolveWindowsCommandPath(string command)
    {
        if (command.Contains('\\') || command.Contains('/') || (command.Length > 1 && command[1] == ':'))
            return ResolveWindowsPathCandidate(command) ?? command;

        foreach (var entry in (Environment.GetEnvironmentVariable("PATH") ?? string.Empty).Split(';', StringSplitOptions.RemoveEmptyEntries))
        {
            var candidate = ResolveWindowsPathCandidate(Path.Combine(entry, command));
            if (candidate is not null) return candidate;
        }
        return command;
    }

    private static string? ResolveWindowsPathCandidate(string basePath)
    {
        var extension = Path.GetExtension(basePath);
        var candidates = string.IsNullOrWhiteSpace(extension)
            ? new[] { basePath + ".exe", basePath + ".com", basePath + ".cmd", basePath + ".bat", basePath + ".ps1", basePath + ".psm1", basePath }
            : new[] { basePath };
        return candidates.FirstOrDefault(File.Exists);
    }

    private static string BuildWindowsCommandLine(string command, IEnumerable<string> args)
    {
        return string.Join(" ", new[] { command }.Concat(args).Select(QuoteWindowsArg));
    }

    private static string QuoteWindowsArg(string arg)
    {
        if (arg.Length == 0) return "\"\"";
        return arg.IndexOfAny(new[] { ' ', '\t', '"' }) < 0 ? arg : "\"" + arg.Replace("\"", "\\\"") + "\"";
    }

    private static object? NormalizeJsonValue(object? value)
    {
        if (value is null) return null;
        if (value is JsonElement element) return NormalizeJsonElement(element);
        if (value is string or bool or int or long or float or double or decimal) return value;
        if (value is IReadOnlyDictionary<string, object?> roDict)
            return roDict.ToDictionary(p => p.Key, p => NormalizeJsonValue(p.Value), StringComparer.Ordinal);
        if (value is IDictionary<string, object?> dict)
            return dict.ToDictionary(p => p.Key, p => NormalizeJsonValue(p.Value), StringComparer.Ordinal);
        if (value is IEnumerable<KeyValuePair<string, object?>> pairs)
            return pairs.ToDictionary(p => p.Key, p => NormalizeJsonValue(p.Value), StringComparer.Ordinal);
        if (value is IEnumerable<object?> list && value is not string)
            return list.Select(NormalizeJsonValue).ToArray();
        return value.ToString();
    }

    private static object? NormalizeJsonElement(JsonElement element)
    {
        return element.ValueKind switch
        {
            JsonValueKind.Object => element.EnumerateObject().ToDictionary(p => p.Name, p => NormalizeJsonElement(p.Value), StringComparer.Ordinal),
            JsonValueKind.Array => element.EnumerateArray().Select(NormalizeJsonElement).ToArray(),
            JsonValueKind.String => element.GetString(),
            JsonValueKind.Number => element.TryGetInt64(out var l) ? l : element.GetDouble(),
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            _ => null
        };
    }

    private static string GetJsonRpcErrorMessage(JsonElement error)
    {
        if (error.ValueKind == JsonValueKind.Object && error.TryGetProperty("message", out var message))
            return message.GetString() ?? error.GetRawText();
        return error.GetRawText();
    }

    private static JsonElement CreateDefaultSchema()
    {
        using var doc = JsonDocument.Parse("{\"type\":\"object\",\"properties\":{}}");
        return doc.RootElement.Clone();
    }

    private static JsonElement CreateDefaultObject()
    {
        using var doc = JsonDocument.Parse("{}");
        return doc.RootElement.Clone();
    }

    private static string MakeFunctionName(string serverName, string toolName, HashSet<string> usedNames)
    {
        var baseName = "mcp_" + SanitizeFunctionNamePart(serverName) + "_" + SanitizeFunctionNamePart(toolName);
        var candidate = baseName;
        var index = 2;
        while (!usedNames.Add(candidate)) candidate = baseName + "_" + index++;
        return candidate;
    }

    private static string SanitizeFunctionNamePart(string value)
    {
        var chars = value.Select(ch => char.IsLetterOrDigit(ch) || ch is '_' or '-' or '.' ? ch : '_').ToArray();
        var result = new string(chars).Trim('_');
        return result.Length == 0 ? "tool" : result;
    }

    private static string Truncate(string value, int max)
    {
        if (string.IsNullOrEmpty(value) || value.Length <= max) return value;
        return value.Substring(0, max) + "...";
    }

    private static void Log(string message)
    {
        try { Console.Error.WriteLine(message); } catch { }
    }

    private void DisconnectServer(string name)
    {
        if (!connections.Remove(name, out var conn)) return;
        if (conn is StdioMcpConnection stdio)
        {
            foreach (var pending in stdio.Pending.Values)
                pending.TrySetException(new InvalidOperationException("MCP server disconnected."));
            try { if (!stdio.Process.HasExited) stdio.Process.Kill(); } catch { }
            stdio.Process.Dispose();
        }
    }

    private void DisconnectAll()
    {
        foreach (var name in connections.Keys.ToArray()) DisconnectServer(name);
        toolNameMap.Clear();
    }

    public void Dispose() => DisconnectAll();

    private sealed class McpAITool : AIFunction
    {
        private readonly McpClient owner;
        private readonly JsonElement schema;

        public McpAITool(McpClient owner, string functionName, string serverName, McpToolInfo tool)
        {
            this.owner = owner;
            Name = functionName;
            Description = "[MCP: " + serverName + "] " + tool.Description;
            schema = tool.InputSchema.Clone();
        }

        public override string Name { get; }
        public override string Description { get; }
        public override JsonElement JsonSchema => schema;

        protected override async ValueTask<object?> InvokeCoreAsync(AIFunctionArguments arguments, CancellationToken cancellationToken)
        {
            var dict = arguments.ToDictionary(p => p.Key, p => p.Value, StringComparer.Ordinal);
            return await owner.CallToolAsync(Name, dict, cancellationToken).ConfigureAwait(false);
        }
    }

    private abstract class McpConnection
    {
        protected McpConnection(string serverName) => ServerName = serverName;
        public string ServerName { get; }
        public int NextId { get; set; } = 1;
        public List<McpToolInfo> Tools { get; } = new();
    }

    private sealed class HttpMcpConnection : McpConnection
    {
        public HttpMcpConnection(string serverName, string baseUrl) : base(serverName) => BaseUrl = baseUrl;
        public string BaseUrl { get; }
        public Dictionary<string, string> Headers { get; set; } = new(StringComparer.OrdinalIgnoreCase);
        public string? SessionId { get; set; }
    }

    private sealed class StdioMcpConnection : McpConnection
    {
        public StdioMcpConnection(string serverName, Process process) : base(serverName) => Process = process;
        public Process Process { get; }
        public ConcurrentDictionary<int, TaskCompletionSource<JsonElement>> Pending { get; } = new();
        public List<byte> Buffer { get; } = new();
        public object BufferLock { get; } = new();
    }

    private sealed record McpToolInfo(string Name, string Description, JsonElement InputSchema);
    private sealed record McpToolEntry(string FunctionName, string ServerName, McpToolInfo Tool);
    private sealed record StdioSpawnSpec(string Command, string[] Args);
    private sealed record HttpPostResult(string Body, string ContentType);
    private sealed record JsonRpcRequest(int Id, string Method, object Params)
    {
        [JsonPropertyName("jsonrpc")] public string JsonRpc => "2.0";
        [JsonPropertyName("id")] public int Id { get; } = Id;
        [JsonPropertyName("method")] public string Method { get; } = Method;
        [JsonPropertyName("params")] public object Params { get; } = Params;
    }
    private sealed record JsonRpcNotification(string Method, object Params)
    {
        [JsonPropertyName("jsonrpc")] public string JsonRpc => "2.0";
        [JsonPropertyName("method")] public string Method { get; } = Method;
        [JsonPropertyName("params")] public object Params { get; } = Params;
    }

    private sealed class McpServerConfig
    {
        [JsonPropertyName("command")] public string? Command { get; set; }
        [JsonPropertyName("args")] public string[]? Args { get; set; }
        [JsonPropertyName("env")] public Dictionary<string, string>? Env { get; set; }
        [JsonPropertyName("cwd")] public string? Cwd { get; set; }
        [JsonPropertyName("url")] public string? Url { get; set; }
        [JsonPropertyName("headers")] public Dictionary<string, string>? Headers { get; set; }
        [JsonPropertyName("authSession")] public McpAuthSessionConfig? AuthSession { get; set; }
    }

    private sealed class McpAuthSessionConfig
    {
        [JsonPropertyName("providerId")] public string? ProviderId { get; set; }
        [JsonPropertyName("scopes")] public string[]? Scopes { get; set; }
        [JsonPropertyName("tokenHeader")] public string? TokenHeader { get; set; }
        [JsonPropertyName("tokenScheme")] public string? TokenScheme { get; set; }
        [JsonPropertyName("createIfNone")] public bool? CreateIfNone { get; set; }
    }

    private sealed class JsonDocumentHolder : IDisposable
    {
        public void Dispose() { }
    }
}
