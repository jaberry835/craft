using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using JuniorStudio.VisualStudio.Options;

namespace JuniorStudio.VisualStudio.Services
{
    internal sealed class JuniorAgentSidecar : IDisposable
    {
        private readonly JavaScriptSerializer serializer = new JavaScriptSerializer();
        private readonly object startLock = new object();
        private readonly object writeLock = new object();
        private readonly ConcurrentDictionary<string, TaskCompletionSource<string>> pendingTextRequests = new ConcurrentDictionary<string, TaskCompletionSource<string>>();
        private Process process;
        private StreamWriter stdin;
        private bool configured;
        private bool authSignedIn;
        private string lastConfigurePayload;
        private string lastAuthFingerprint;
        private string lastDiagnosticsPayload;

        public event Action<string> MessageReceived;
        public event Action<string> Failed;

        public bool IsRunning
        {
            get { return process != null && !process.HasExited; }
        }

        public bool IsConfigured
        {
            get { return configured; }
        }

        public bool IsAuthSignedIn
        {
            get { return authSignedIn; }
        }

        public void EnsureStarted()
        {
            lock (startLock)
            {
                if (IsRunning) return;

                var exe = LocateSidecarExe();
                if (!File.Exists(exe))
                {
                    OnFailed("Junior sidecar executable not found at: " + exe);
                    return;
                }

                var psi = new ProcessStartInfo
                {
                    FileName = exe,
                    UseShellExecute = false,
                    RedirectStandardInput = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true,
                    StandardOutputEncoding = Encoding.UTF8,
                    StandardErrorEncoding = Encoding.UTF8,
                    WorkingDirectory = Path.GetDirectoryName(exe)
                };

                try
                {
                    process = Process.Start(psi);
                }
                catch (Exception ex)
                {
                    OnFailed("Failed to launch sidecar: " + ex.Message);
                    return;
                }

                stdin = process.StandardInput;
                stdin.AutoFlush = true;
                configured = false;
                authSignedIn = false;
                lastConfigurePayload = null;
                lastAuthFingerprint = null;
                lastDiagnosticsPayload = null;

                _ = Task.Run(() => PumpStream(process.StandardOutput, false));
                _ = Task.Run(() => PumpStream(process.StandardError, true));

                var pidProcess = process;
                _ = Task.Run(() =>
                {
                    try
                    {
                        pidProcess.WaitForExit();
                        if (pidProcess.ExitCode != 0)
                        {
                            OnFailed("Junior sidecar exited with code " + pidProcess.ExitCode + ". This usually means the .NET 8 Desktop Runtime is not installed. Install it from https://dotnet.microsoft.com/download/dotnet/8.0 then reopen the Junior Chat window.");
                        }
                    }
                    catch { }
                });
            }
        }

        public void Configure(JuniorOptionsPage options, string deploymentOverride = null, string workspaceRoot = null, System.Collections.Generic.IList<System.Collections.Generic.IDictionary<string, object>> diagnostics = null, string permissionLevel = null)
        {
            if (options == null) return;
            EnsureStarted();
            if (!IsRunning) return;

            var deployment = !string.IsNullOrWhiteSpace(deploymentOverride)
                ? deploymentOverride
                : options.ActiveDeployment;
            var resolvedApiKey = JuniorCredentialStore.ResolveSecretReference(options.ApiKey);
            var bypassApprovals = string.Equals(permissionLevel, "bypass", StringComparison.OrdinalIgnoreCase);
            var approvalWrite = bypassApprovals ? "auto" : options.ApprovalWrite.ToString().ToLowerInvariant();
            var approvalDelete = bypassApprovals ? "auto" : options.ApprovalDelete.ToString().ToLowerInvariant();
            var approvalShell = bypassApprovals ? "auto" : options.ApprovalShell.ToString().ToLowerInvariant();

            var payload = new System.Collections.Generic.Dictionary<string, object>
            {
                ["type"] = "configure",
                ["provider"] = options.Provider.ToString(),
                ["endpoint"] = options.Endpoint ?? string.Empty,
                ["apimBaseUrl"] = options.ApimBaseUrl ?? string.Empty,
                ["openAICompatibleBaseUrl"] = options.OpenAICompatibleBaseUrl ?? string.Empty,
                ["apiKey"] = resolvedApiKey ?? string.Empty,
                ["authMode"] = options.AuthMode.ToString(),
                ["bearerToken"] = options.BearerToken ?? string.Empty,
                ["authScopes"] = SplitList(options.AuthScopes),
                ["authTenantId"] = options.AuthTenantId ?? string.Empty,
                ["authClientId"] = options.AuthClientId ?? string.Empty,
                ["authorityHost"] = ResolveAuthorityHost(options),
                ["directAudience"] = ResolveDirectAudience(options),
                ["apiVersion"] = options.ApiVersion ?? string.Empty,
                ["deployment"] = deployment ?? string.Empty,
                ["workspaceRoot"] = workspaceRoot ?? string.Empty,
                ["scratchRoot"] = System.IO.Path.Combine(
                    System.Environment.GetFolderPath(System.Environment.SpecialFolder.UserProfile),
                    "source", "repos"),
                ["approvalWrite"] = approvalWrite,
                ["approvalDelete"] = approvalDelete,
                ["approvalShell"] = approvalShell,
                ["mcpEnabled"] = options.McpEnabled,
                ["mcpServersJson"] = options.McpServersJson ?? string.Empty
            };
            var payloadJson = serializer.Serialize(payload);
            var authFingerprint = BuildAuthFingerprint(options, resolvedApiKey);
            if (configured && string.Equals(lastConfigurePayload, payloadJson, StringComparison.Ordinal))
            {
                DebugLog("CONFIG: unchanged; reusing sidecar configuration and auth client.");
                UpdateDiagnostics(diagnostics);
                return;
            }

            if (!string.Equals(lastAuthFingerprint, authFingerprint, StringComparison.Ordinal))
            {
                authSignedIn = options.AuthMode != JuniorAuthMode.EntraId;
                lastAuthFingerprint = authFingerprint;
            }

            DebugLog("CONFIG: sending updated sidecar configuration.");
            SendRaw(payloadJson);
            configured = true;
            lastConfigurePayload = payloadJson;
            UpdateDiagnostics(diagnostics);
        }

        private static string BuildAuthFingerprint(JuniorOptionsPage options, string resolvedApiKey)
        {
            if (options == null) return string.Empty;
            return string.Join("\u001f", new[]
            {
                options.Provider.ToString(),
                options.Endpoint ?? string.Empty,
                options.ApimBaseUrl ?? string.Empty,
                options.OpenAICompatibleBaseUrl ?? string.Empty,
                options.AuthMode.ToString(),
                resolvedApiKey ?? string.Empty,
                options.BearerToken ?? string.Empty,
                string.Join("\n", SplitList(options.AuthScopes)),
                options.AuthTenantId ?? string.Empty,
                options.AuthClientId ?? string.Empty,
                ResolveAuthorityHost(options),
                ResolveDirectAudience(options)
            });
        }

        private static string[] SplitList(string value)
        {
            if (string.IsNullOrWhiteSpace(value)) return new string[0];
            return value.Split(new[] { ',', '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
        }

        private static string ResolveAuthorityHost(JuniorOptionsPage options)
        {
            if (options == null) return string.Empty;
            switch (options.AzureCloud)
            {
                case JuniorAzureCloud.Government:
                    return "https://login.microsoftonline.us/";
                case JuniorAzureCloud.China:
                    return "https://login.chinacloudapi.cn/";
                case JuniorAzureCloud.Custom:
                    return options.AuthorityHost ?? string.Empty;
                default:
                    return "https://login.microsoftonline.com/";
            }
        }

        private static string ResolveDirectAudience(JuniorOptionsPage options)
        {
            if (options == null) return string.Empty;
            if (!string.IsNullOrWhiteSpace(options.DirectAudience)) return options.DirectAudience.Trim();
            switch (options.AzureCloud)
            {
                case JuniorAzureCloud.Government:
                    return "https://cognitiveservices.azure.us/.default";
                case JuniorAzureCloud.China:
                    return "https://cognitiveservices.azure.cn/.default";
                default:
                    return "https://cognitiveservices.azure.com/.default";
            }
        }

        public void SendMessage(string text, System.Collections.Generic.IList<string> images = null, System.Collections.Generic.IList<System.Collections.Generic.IDictionary<string, object>> files = null, string mode = null)
        {
            if (!configured)
            {
                OnFailed("Junior sidecar is not configured. Open Tools > Options > Junior and fill in provider settings.");
                return;
            }
            var payload = new System.Collections.Generic.Dictionary<string, object>
            {
                ["type"] = "sendMessage",
                ["text"] = text ?? string.Empty
            };
            if (!string.IsNullOrEmpty(mode)) payload["mode"] = mode;
            if (images != null && images.Count > 0) payload["images"] = images;
            if (files != null && files.Count > 0) payload["files"] = files;
            SendRaw(serializer.Serialize(payload));
        }

        public void UpdateDiagnostics(System.Collections.Generic.IList<System.Collections.Generic.IDictionary<string, object>> diagnostics)
        {
            if (!IsRunning) return;
            var list = diagnostics ?? new System.Collections.Generic.List<System.Collections.Generic.IDictionary<string, object>>();
            var diagnosticsJson = serializer.Serialize(list);
            if (string.Equals(lastDiagnosticsPayload, diagnosticsJson, StringComparison.Ordinal)) return;

            var payload = new System.Collections.Generic.Dictionary<string, object>
            {
                ["type"] = "updateDiagnostics",
                ["diagnostics"] = list
            };
            SendRaw(serializer.Serialize(payload));
            lastDiagnosticsPayload = diagnosticsJson;
        }

        public void Cancel()
        {
            if (!IsRunning) return;
            SendRaw("{\"type\":\"cancelAgent\"}");
        }

        public void ResetHistory()
        {
            if (!IsRunning) return;
            SendRaw("{\"type\":\"resetHistory\"}");
        }

        public void SeedHistory(System.Collections.Generic.IEnumerable<System.Collections.Generic.KeyValuePair<string, string>> turns)
        {
            if (!IsRunning || turns == null) return;
            var list = new System.Collections.Generic.List<object>();
            foreach (var kv in turns)
            {
                if (string.IsNullOrEmpty(kv.Value)) continue;
                list.Add(new System.Collections.Generic.Dictionary<string, object>
                {
                    ["role"] = string.IsNullOrEmpty(kv.Key) ? "user" : kv.Key,
                    ["text"] = kv.Value
                });
            }
            if (list.Count == 0) return;
            var payload = new System.Collections.Generic.Dictionary<string, object>
            {
                ["type"] = "seedHistory",
                ["turns"] = list
            };
            SendRaw(serializer.Serialize(payload));
        }

        public void SendApprovalResponse(string id, bool allow, string scope = null, string category = null)
        {
            if (!IsRunning || string.IsNullOrEmpty(id)) return;
            var payload = new System.Collections.Generic.Dictionary<string, object>
            {
                ["type"] = "approvalResponse",
                ["approvalId"] = id,
                ["allow"] = allow
            };
            if (!string.IsNullOrEmpty(scope)) payload["scope"] = scope;
            if (!string.IsNullOrEmpty(category)) payload["category"] = category;
            SendRaw(serializer.Serialize(payload));
        }

        public void RequestMcpTools()
        {
            if (!IsRunning) return;
            SendRaw("{\"type\":\"listMcpTools\"}");
        }

        public void SetMcpToolEnabled(string functionName, bool enabled)
        {
            if (!IsRunning || string.IsNullOrWhiteSpace(functionName)) return;
            var payload = new System.Collections.Generic.Dictionary<string, object>
            {
                ["type"] = "setMcpToolEnabled",
                ["functionName"] = functionName,
                ["enabled"] = enabled
            };
            SendRaw(serializer.Serialize(payload));
        }

        public async Task<string> GenerateTextAsync(JuniorOptionsPage options, string deploymentOverride, string workspaceRoot, string systemPrompt, string prompt, CancellationToken cancellationToken, bool allowInteractiveAuth = true)
        {
            Configure(options, deploymentOverride, workspaceRoot);
            if (!IsRunning) throw new InvalidOperationException("Junior sidecar is not running.");

            var requestId = Guid.NewGuid().ToString("n");
            var pending = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
            pendingTextRequests[requestId] = pending;

            var payload = new Dictionary<string, object>
            {
                ["type"] = "generateText",
                ["requestId"] = requestId,
                ["systemPrompt"] = systemPrompt ?? string.Empty,
                ["prompt"] = prompt ?? string.Empty,
                ["allowInteractiveAuth"] = allowInteractiveAuth
            };

            using (var timeout = new CancellationTokenSource(TimeSpan.FromMinutes(2)))
            using (var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, timeout.Token))
            using (linked.Token.Register(() =>
            {
                if (pendingTextRequests.TryRemove(requestId, out var tcs))
                    tcs.TrySetException(new TimeoutException("Junior text generation timed out."));
            }))
            {
                SendRaw(serializer.Serialize(payload));
                return await pending.Task.ConfigureAwait(false);
            }
        }

        public void WarmAuth(JuniorOptionsPage options, string deploymentOverride = null, string workspaceRoot = null)
        {
            if (options == null) return;
            Configure(options, deploymentOverride, workspaceRoot);
            if (!IsRunning) return;

            var deployment = !string.IsNullOrWhiteSpace(deploymentOverride)
                ? deploymentOverride
                : options.ActiveDeployment;
            var resolvedApiKey = JuniorCredentialStore.ResolveSecretReference(options.ApiKey);
            var payload = new Dictionary<string, object>
            {
                ["type"] = "warmAuth",
                ["provider"] = options.Provider.ToString(),
                ["endpoint"] = options.Endpoint ?? string.Empty,
                ["apimBaseUrl"] = options.ApimBaseUrl ?? string.Empty,
                ["openAICompatibleBaseUrl"] = options.OpenAICompatibleBaseUrl ?? string.Empty,
                ["apiKey"] = resolvedApiKey ?? string.Empty,
                ["authMode"] = options.AuthMode.ToString(),
                ["bearerToken"] = options.BearerToken ?? string.Empty,
                ["authScopes"] = SplitList(options.AuthScopes),
                ["authTenantId"] = options.AuthTenantId ?? string.Empty,
                ["authClientId"] = options.AuthClientId ?? string.Empty,
                ["authorityHost"] = ResolveAuthorityHost(options),
                ["directAudience"] = ResolveDirectAudience(options),
                ["apiVersion"] = options.ApiVersion ?? string.Empty,
                ["deployment"] = deployment ?? string.Empty,
                ["workspaceRoot"] = workspaceRoot ?? string.Empty,
                ["scratchRoot"] = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "source", "repos"),
                ["approvalWrite"] = options.ApprovalWrite.ToString().ToLowerInvariant(),
                ["approvalDelete"] = options.ApprovalDelete.ToString().ToLowerInvariant(),
                ["approvalShell"] = options.ApprovalShell.ToString().ToLowerInvariant(),
                ["mcpEnabled"] = options.McpEnabled,
                ["mcpServersJson"] = options.McpServersJson ?? string.Empty
            };
            SendRaw(serializer.Serialize(payload));
        }

        public void Dispose()
        {
            try
            {
                if (IsRunning)
                {
                    SendRaw("{\"type\":\"shutdown\"}");
                    if (!process.WaitForExit(1500))
                    {
                        process.Kill();
                    }
                }
            }
            catch { }
            try { stdin?.Dispose(); } catch { }
            try { process?.Dispose(); } catch { }
            process = null;
            stdin = null;
        }

        private void SendRaw(string jsonLine)
        {
            try
            {
                lock (writeLock)
                {
                    if (stdin == null) return;
                    stdin.WriteLine(jsonLine);
                }
            }
            catch (Exception ex)
            {
                OnFailed("Sidecar write failed: " + ex.Message);
            }
        }

        private void PumpStream(StreamReader reader, bool isError)
        {
            try
            {
                string line;
                while ((line = reader.ReadLine()) != null)
                {
                    if (string.IsNullOrWhiteSpace(line)) continue;
                    if (isError)
                    {
                        DebugLog("STDERR: " + line);
                        continue;
                    }
                    OnMessageReceived(line);
                }
            }
            catch (Exception ex)
            {
                DebugLog("Pump error: " + ex);
            }
        }

        private void OnMessageReceived(string line)
        {
            TryRecordAuthState(line);
            if (TryHandleTextResponse(line)) return;
            var handler = MessageReceived;
            if (handler != null) handler(line);
        }

        private void TryRecordAuthState(string line)
        {
            try
            {
                var message = serializer.Deserialize<Dictionary<string, object>>(line);
                if (message == null || !message.TryGetValue("type", out var typeValue)) return;
                if (!string.Equals(Convert.ToString(typeValue), "authState", StringComparison.Ordinal)) return;
                var state = message.TryGetValue("state", out var stateValue) ? Convert.ToString(stateValue) : null;
                if (string.Equals(state, "signedIn", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(state, "ready", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(state, "notRequired", StringComparison.OrdinalIgnoreCase))
                {
                    authSignedIn = true;
                    DebugLog("AUTH: signed-in state recorded by VS host.");
                }
                else if (string.Equals(state, "needsSignIn", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(state, "error", StringComparison.OrdinalIgnoreCase))
                {
                    authSignedIn = false;
                }
            }
            catch { }
        }

        private bool TryHandleTextResponse(string line)
        {
            try
            {
                var message = serializer.Deserialize<Dictionary<string, object>>(line);
                if (message == null || !message.TryGetValue("type", out var typeValue)) return false;
                var type = Convert.ToString(typeValue);
                if (!string.Equals(type, "textResponse", StringComparison.Ordinal) && !string.Equals(type, "textError", StringComparison.Ordinal)) return false;
                var requestId = message.TryGetValue("requestId", out var idValue) ? Convert.ToString(idValue) : null;
                if (string.IsNullOrEmpty(requestId) || !pendingTextRequests.TryRemove(requestId, out var pending)) return true;

                if (string.Equals(type, "textError", StringComparison.Ordinal))
                {
                    var error = message.TryGetValue("message", out var errorValue) ? Convert.ToString(errorValue) : "Junior text generation failed.";
                    pending.TrySetException(new InvalidOperationException(error));
                }
                else
                {
                    var text = message.TryGetValue("text", out var textValue) ? Convert.ToString(textValue) : string.Empty;
                    pending.TrySetResult(text ?? string.Empty);
                }
                return true;
            }
            catch
            {
                return false;
            }
        }

        private void OnFailed(string message)
        {
            DebugLog("FAIL: " + message);
            var handler = Failed;
            if (handler != null) handler(message);
        }

        private static string LocateSidecarExe()
        {
            var baseDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            return Path.Combine(baseDir, "Assets", "Agent", "JuniorStudio.Agent.exe");
        }

        private static void DebugLog(string line)
        {
            try
            {
                var path = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "JuniorStudio",
                    "sidecar.log");
                Directory.CreateDirectory(Path.GetDirectoryName(path));
                File.AppendAllText(path, DateTime.Now.ToString("HH:mm:ss.fff") + " " + line + Environment.NewLine);
            }
            catch { }
        }
    }
}
