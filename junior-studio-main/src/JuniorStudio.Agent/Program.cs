using System.Text.Json;
using System.Collections.Concurrent;
using JuniorStudio.Agent;

// NDJSON over stdio. One JSON object per line in both directions.
// We must NEVER write to stdout except for protocol responses.

Console.OutputEncoding = System.Text.Encoding.UTF8;
Console.InputEncoding = System.Text.Encoding.UTF8;

var host = new AgentHost();
var stdoutLock = new object();
var pendingApprovals = new ConcurrentDictionary<string, TaskCompletionSource<bool>>();

void Write(object payload)
{
    var json = JsonSerializer.Serialize(payload, Protocol.JsonOptions);
    lock (stdoutLock)
    {
        Console.Out.WriteLine(json);
        Console.Out.Flush();
    }
}

void LogErr(string s)
{
    try { Console.Error.WriteLine(s); } catch { }
}

host.WorkspaceFolderCreated += path => Write(new { type = "openWorkspaceFolder", path });

// Wire the approval gate: when a confirm-mode tool runs, emit approvalRequest and
// await the matching approvalResponse from the host. Cancellation (via cancelAgent)
// completes the task as denied so the agent unblocks immediately.
host.ApprovalCallback = (category, description, ct) =>
{
    var id = Guid.NewGuid().ToString("n");
    var tcs = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
    pendingApprovals[id] = tcs;
    var registration = ct.Register(() =>
    {
        if (pendingApprovals.TryRemove(id, out var t))
            t.TrySetResult(false);
    });
    Write(new { type = "approvalRequest", id, category, description });
    return tcs.Task.ContinueWith(t =>
    {
        registration.Dispose();
        return t.Result;
    }, TaskContinuationOptions.ExecuteSynchronously);
};

Write(new { type = "ready" });

string? line;
while ((line = await Console.In.ReadLineAsync()) is not null)
{
    if (string.IsNullOrWhiteSpace(line)) continue;

    InboundMessage? msg;
    try
    {
        msg = JsonSerializer.Deserialize<InboundMessage>(line, Protocol.JsonOptions);
    }
    catch (Exception ex)
    {
        Write(new { type = "error", message = "Invalid JSON: " + ex.Message });
        continue;
    }

    if (msg?.Type is null) continue;

    try
    {
        switch (msg.Type)
        {
            case "configure":
                host.Configure(msg);
                Write(new { type = "configured" });
                break;

            case "sendMessage":
                var text = msg.Text ?? string.Empty;
                var images = msg.Images;
                var files = msg.Files;
                var mode = msg.Mode;
                _ = Task.Run(async () =>
                {
                    try
                    {
                        await foreach (var ev in host.SendMessageAsync(text, images, files, mode))
                        {
                            Write(ev);
                        }
                    }
                    catch (Exception ex)
                    {
                        LogErr(ex.ToString());
                        Write(new { type = "error", message = ex.Message });
                        Write(new { type = "endAssistantMessage" });
                    }
                });
                break;

            case "cancelAgent":
                host.Cancel();
                break;

            case "resetHistory":
                host.ResetHistory();
                Write(new { type = "historyReset" });
                break;

            case "seedHistory":
                {
                    var turns = msg.Turns ?? new List<SeedTurn>();
                    host.SeedHistory(turns
                        .Where(t => !string.IsNullOrEmpty(t?.Text))
                        .Select(t => (t!.Role ?? "user", t.Text!)));
                    Write(new { type = "historySeeded", count = turns.Count });
                }
                break;

            case "approvalResponse":
                if (!string.IsNullOrEmpty(msg.ApprovalId)
                    && pendingApprovals.TryRemove(msg.ApprovalId!, out var pending))
                {
                    var allow = msg.Allow == true;
                    if (allow
                        && string.Equals(msg.Scope, "session", StringComparison.OrdinalIgnoreCase)
                        && !string.IsNullOrEmpty(msg.Category))
                    {
                        host.SetApprovalMode(msg.Category!, ApprovalMode.Auto);
                    }
                    pending.TrySetResult(allow);
                }
                break;

            case "shutdown":
                return;

            default:
                // ignore unknown
                break;
        }
    }
    catch (Exception ex)
    {
        LogErr(ex.ToString());
        Write(new { type = "error", message = ex.Message });
    }
}
