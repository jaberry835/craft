using System;
using System.Collections.Concurrent;
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
        private Process process;
        private StreamWriter stdin;
        private bool configured;

        public event Action<string> MessageReceived;
        public event Action<string> Failed;

        public bool IsRunning
        {
            get { return process != null && !process.HasExited; }
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

                Task.Run(() => PumpStream(process.StandardOutput, false));
                Task.Run(() => PumpStream(process.StandardError, true));

                var pidProcess = process;
                Task.Run(() =>
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

        public void Configure(JuniorOptionsPage options, string deploymentOverride = null, string workspaceRoot = null)
        {
            if (options == null) return;
            EnsureStarted();
            if (!IsRunning) return;

            var deployment = !string.IsNullOrWhiteSpace(deploymentOverride)
                ? deploymentOverride
                : options.ActiveDeployment;

            var payload = new System.Collections.Generic.Dictionary<string, object>
            {
                ["type"] = "configure",
                ["provider"] = options.Provider.ToString(),
                ["endpoint"] = options.Endpoint ?? string.Empty,
                ["apimBaseUrl"] = options.ApimBaseUrl ?? string.Empty,
                ["openAICompatibleBaseUrl"] = options.OpenAICompatibleBaseUrl ?? string.Empty,
                ["apiKey"] = options.ApiKey ?? string.Empty,
                ["apiVersion"] = options.ApiVersion ?? string.Empty,
                ["deployment"] = deployment ?? string.Empty,
                ["workspaceRoot"] = workspaceRoot ?? string.Empty,
                ["scratchRoot"] = System.IO.Path.Combine(
                    System.Environment.GetFolderPath(System.Environment.SpecialFolder.UserProfile),
                    "source", "repos"),
                ["approvalWrite"] = options.ApprovalWrite.ToString().ToLowerInvariant(),
                ["approvalDelete"] = options.ApprovalDelete.ToString().ToLowerInvariant(),
                ["approvalShell"] = options.ApprovalShell.ToString().ToLowerInvariant()
            };
            SendRaw(serializer.Serialize(payload));
            configured = true;
        }

        public void SendMessage(string text, System.Collections.Generic.IList<string> images = null, System.Collections.Generic.IList<System.Collections.Generic.IDictionary<string, object>> files = null, string mode = null)
        {
            if (!configured)
            {
                OnFailed("Junior sidecar is not configured. Open Tools > Options > Junior Studio and fill in provider settings.");
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
            var handler = MessageReceived;
            if (handler != null) handler(line);
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
