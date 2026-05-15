using System;
using System.Collections.Generic;
using System.IO;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Controls;
using JuniorStudio.VisualStudio.Options;
using Microsoft.VisualStudio.Shell;

namespace JuniorStudio.VisualStudio.Services
{
    internal sealed class JuniorWebViewBridge : IDisposable
    {
        private readonly JavaScriptSerializer serializer = new JavaScriptSerializer();
        private readonly JuniorAgentSidecar sidecar = JuniorSidecarService.Shared;
        private readonly JuniorSessionStore sessionStore = new JuniorSessionStore();
        private string selectedDeployment = null;
        private JuniorSession activeSession;
        private System.Text.StringBuilder assistantBuffer;
        private string activeAssistantProvider;
        private string permissionLevel = "default";
        private readonly Dictionary<string, Dictionary<string, object>> liveWorkingBlocks = new Dictionary<string, Dictionary<string, object>>(StringComparer.Ordinal);
        private List<KeyValuePair<string, string>> pendingSeedTurns;
        private readonly System.Windows.Threading.DispatcherTimer diagnosticsTimer;
        private int automaticRepairRemaining;
        private bool pendingAutomaticRepair;
        private string pendingAutomaticRepairFingerprint;
        private string lastAutomaticRepairFingerprint;
        private bool repairChainActive;
        private string repairChainId;
        private readonly HashSet<string> repairChainChangedFiles = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        private int repairChainTurnCount;
        private int repairChainAttemptsUsed;
        private string repairChainLastValidationStatus;
        private string repairChainLastValidationCommand;

        public Func<JuniorOptionsPage> OptionsProvider { get; set; }
        public Func<string> WorkspaceRootProvider { get; set; }

        public event Action<string> SidecarMessage;

        public event Action<string> SidecarFailed
        {
            add { sidecar.Failed += value; }
            remove { sidecar.Failed -= value; }
        }

        public JuniorWebViewBridge()
        {
            sidecar.MessageReceived += OnSidecarMessage;
            diagnosticsTimer = new System.Windows.Threading.DispatcherTimer
            {
                Interval = TimeSpan.FromSeconds(5)
            };
            diagnosticsTimer.Tick += OnDiagnosticsTimerTick;
            diagnosticsTimer.Start();
        }

        [System.Diagnostics.CodeAnalysis.SuppressMessage("Usage", "VSTHRD010:Invoke single-threaded types on Main thread", Justification = "DispatcherTimer.Tick runs on the WPF UI dispatcher, and RefreshDiagnosticsSnapshot asserts the UI thread.")]
        private void OnDiagnosticsTimerTick(object sender, EventArgs e)
        {
            RefreshDiagnosticsSnapshot();
        }

        [System.Diagnostics.CodeAnalysis.SuppressMessage("Usage", "VSTHRD010:Invoke single-threaded types on Main thread", Justification = "Sidecar callbacks may arrive on a background stream reader; this handler only schedules VS service access back onto the UI thread.")]
        private void OnSidecarMessage(string json)
        {
            if (TryHandleAutomaticRepairMessage(json)) return;
            TryRecordAssistantMessage(json);
            var handler = SidecarMessage;
            if (handler != null) handler(json);
            foreach (var followup in ProcessRepairChainMessage(json))
                EmitSidecarMessage(followup);
        }

        [System.Diagnostics.CodeAnalysis.SuppressMessage("Usage", "VSTHRD001:Avoid legacy thread switching APIs", Justification = "The sidecar callback is not awaitable; this queues the repair turn onto the WPF UI dispatcher owned by the bridge.")]
        [System.Diagnostics.CodeAnalysis.SuppressMessage("Usage", "VSTHRD110:Observe result of async calls", Justification = "BeginInvoke is intentionally fire-and-forget because the next repair turn is scheduled after the sidecar completes the current turn.")]
        private bool TryHandleAutomaticRepairMessage(string json)
        {
            if (string.IsNullOrEmpty(json)) return false;
            Dictionary<string, object> msg;
            try { msg = serializer.Deserialize<Dictionary<string, object>>(json); }
            catch { return false; }
            if (msg == null || !msg.TryGetValue("type", out var tv)) return false;
            var type = Convert.ToString(tv);

            if (type == "continueIteration"
                && string.Equals(GetString(msg, "reason"), "validationFailed", StringComparison.OrdinalIgnoreCase))
            {
                var fingerprint = GetString(msg, "validationFingerprint") ?? string.Empty;
                if (automaticRepairRemaining > 0
                    && !string.IsNullOrEmpty(fingerprint)
                    && !string.Equals(fingerprint, lastAutomaticRepairFingerprint, StringComparison.Ordinal))
                {
                    automaticRepairRemaining--;
                    pendingAutomaticRepair = true;
                    pendingAutomaticRepairFingerprint = fingerprint;
                    TryRecordAssistantMessage(ToJson(new Dictionary<string, object> { ["type"] = "startAssistantMessage", ["provider"] = "local" }));
                    TryRecordAssistantMessage(ToJson(new Dictionary<string, object>
                    {
                        ["type"] = "appendAssistantText",
                        ["text"] = "\n\nAutomatic validation failed. Junior will use one automatic repair attempt to continue fixing it."
                    }));
                    TryRecordAssistantMessage(ToJson(new Dictionary<string, object> { ["type"] = "endAssistantMessage" }));
                    var handler = SidecarMessage;
                    if (handler != null)
                    {
                        handler(ToJson(new Dictionary<string, object> { ["type"] = "startAssistantMessage", ["provider"] = "local" }));
                        handler(ToJson(new Dictionary<string, object>
                        {
                            ["type"] = "appendAssistantText",
                            ["text"] = "\n\nAutomatic validation failed. Junior will use one automatic repair attempt to continue fixing it."
                        }));
                        handler(ToJson(new Dictionary<string, object> { ["type"] = "endAssistantMessage" }));
                    }
                    return true;
                }
                var summary = CompleteRepairChain("stopped for user confirmation");
                if (summary != null) EmitSidecarMessage(summary);
                return false;
            }

            if (type == "agentDone" && pendingAutomaticRepair)
            {
                pendingAutomaticRepair = false;
                lastAutomaticRepairFingerprint = pendingAutomaticRepairFingerprint;
                pendingAutomaticRepairFingerprint = null;
                diagnosticsTimer.Dispatcher.BeginInvoke(new Action(StartAutomaticRepairTurn));
                return true;
            }

            return false;
        }

        private IEnumerable<string> ProcessRepairChainMessage(string json)
        {
            if (string.IsNullOrEmpty(json)) yield break;
            Dictionary<string, object> msg;
            try { msg = serializer.Deserialize<Dictionary<string, object>>(json); }
            catch { yield break; }
            if (msg == null || !msg.TryGetValue("type", out var tv)) yield break;
            if (!string.Equals(Convert.ToString(tv), "turnSummary", StringComparison.Ordinal)) yield break;

            var validation = GetDictionary(msg, "validation");
            var status = GetString(validation, "status") ?? "skipped";
            var autoRepair = GetBool(msg, "autoRepair");
            var validationFailed = string.Equals(status, "failed", StringComparison.OrdinalIgnoreCase);
            var validationPassed = string.Equals(status, "passed", StringComparison.OrdinalIgnoreCase);

            if (validationFailed || autoRepair) StartRepairChain();
            if (!repairChainActive) yield break;

            repairChainTurnCount++;
            if (autoRepair) repairChainAttemptsUsed++;
            repairChainLastValidationStatus = status;
            repairChainLastValidationCommand = GetString(validation, "command") ?? repairChainLastValidationCommand;
            foreach (var file in GetStringList(msg, "changedFiles") ?? new List<string>())
            {
                if (!string.IsNullOrWhiteSpace(file)) repairChainChangedFiles.Add(file);
            }

            if (validationPassed)
            {
                var summary = CompleteRepairChain("validation passed");
                if (summary != null) yield return summary;
            }
        }

        private void StartRepairChain()
        {
            if (repairChainActive) return;
            repairChainActive = true;
            repairChainId = "repair-" + Guid.NewGuid().ToString("N");
            repairChainChangedFiles.Clear();
            repairChainTurnCount = 0;
            repairChainAttemptsUsed = 0;
            repairChainLastValidationStatus = null;
            repairChainLastValidationCommand = null;
        }

        private string CompleteRepairChain(string stopReason)
        {
            if (!repairChainActive) return null;
            var payload = new Dictionary<string, object>
            {
                ["type"] = "repairChainSummary",
                ["chainId"] = repairChainId,
                ["changedFiles"] = new List<string>(repairChainChangedFiles),
                ["turnCount"] = repairChainTurnCount,
                ["repairAttempts"] = repairChainAttemptsUsed,
                ["finalValidationStatus"] = repairChainLastValidationStatus ?? "unknown",
                ["stopReason"] = stopReason ?? string.Empty
            };
            if (!string.IsNullOrWhiteSpace(repairChainLastValidationCommand)) payload["validationCommand"] = repairChainLastValidationCommand;
            ResetRepairChain();
            return ToJson(payload);
        }

        private void ResetRepairChain()
        {
            repairChainActive = false;
            repairChainId = null;
            repairChainChangedFiles.Clear();
            repairChainTurnCount = 0;
            repairChainAttemptsUsed = 0;
            repairChainLastValidationStatus = null;
            repairChainLastValidationCommand = null;
        }

        private void EmitSidecarMessage(string json)
        {
            if (string.IsNullOrEmpty(json)) return;
            TryRecordAssistantMessage(json);
            var handler = SidecarMessage;
            if (handler != null) handler(json);
        }

        public IEnumerable<string> GetStartupMessages()
        {
            var options = OptionsProvider != null ? OptionsProvider() : null;
            var models = BuildModelList(options);
            var activeDeployment = options != null && !string.IsNullOrWhiteSpace(options.ActiveDeployment)
                ? options.ActiveDeployment
                : (models.Count > 0 ? (string)((Dictionary<string, object>)models[0])["deploymentId"] : "junior-active");

            yield return ToJson(new Dictionary<string, object>
            {
                ["type"] = "setModels",
                ["models"] = models.ToArray(),
                ["activeDeployment"] = activeDeployment,
                ["reasoning"] = null
            });

            yield return ToJson(new Dictionary<string, object>
            {
                ["type"] = "setChatMode",
                ["mode"] = "agent"
            });

            yield return ToJson(new Dictionary<string, object>
            {
                ["type"] = "setAgentProviders",
                ["activeProvider"] = "local",
                ["providers"] = new object[]
                {
                    new Dictionary<string, object>
                    {
                        ["value"] = "local",
                        ["label"] = "Foundry via APIM",
                        ["available"] = true,
                        ["detail"] = "Microsoft Agent Framework sidecar"
                    }
                }
            });

            yield return ToJson(new Dictionary<string, object>
            {
                ["type"] = "setPermissionLevel",
                ["level"] = "default"
            });

            yield return BuildAuthStateMessage(options);

            // Announce workspace as a fake assistant message so the user can verify the root.
            foreach (var m in BuildWorkspaceBannerMessages())
                yield return m;
        }

        private string BuildAuthStateMessage(JuniorOptionsPage options)
        {
            if (options == null || options.AuthMode != JuniorAuthMode.EntraId)
            {
                return ToJson(new Dictionary<string, object>
                {
                    ["type"] = "authState",
                    ["state"] = "notRequired",
                    ["message"] = string.Empty
                });
            }

            return ToJson(new Dictionary<string, object>
            {
                ["type"] = "authState",
                ["state"] = JuniorSidecarService.Shared.IsAuthSignedIn ? "signedIn" : "needsSignIn",
                ["provider"] = options.Provider.ToString(),
                ["message"] = JuniorSidecarService.Shared.IsAuthSignedIn
                    ? "Signed in with Microsoft Entra ID."
                    : "Junior will sign in with Microsoft Entra ID before the first request."
            });
        }

        public IEnumerable<string> BuildWorkspaceBannerMessages()
        {
            var workspaceRoot = WorkspaceRootProvider != null ? WorkspaceRootProvider() : null;
            var hasWorkspace = !string.IsNullOrWhiteSpace(workspaceRoot);

            var payload = new Dictionary<string, object>
            {
                ["type"] = "showWelcome",
                ["title"] = "Welcome to Junior",
                ["subtitle"] = "Your air-gapped AI coding assistant, powered by Microsoft Agent Framework.",
                ["setupActions"] = new List<object>
                {
                    new Dictionary<string, object> { ["icon"] = "gear", ["text"] = "Open Junior options", ["action"] = "splashOpenSettings" },
                    new Dictionary<string, object> { ["icon"] = "key", ["text"] = "Set API key securely", ["action"] = "splashSetApiKey" }
                }
            };

            if (hasWorkspace)
            {
                payload["workspacePath"] = workspaceRoot;
                payload["promptsLabel"] = "Try one of these";
                payload["prompts"] = new List<object>
                {
                    new Dictionary<string, object> { ["icon"] = "edit",      ["text"] = "Add a new feature to this project",            ["prompt"] = "Add a new feature to this project: " },
                    new Dictionary<string, object> { ["icon"] = "search",    ["text"] = "Explain how this codebase is organized",       ["prompt"] = "Explain how this codebase is organized." },
                    new Dictionary<string, object> { ["icon"] = "play",      ["text"] = "Find and fix a bug",                            ["prompt"] = "Find and fix a bug in " },
                    new Dictionary<string, object> { ["icon"] = "list-tree", ["text"] = "Refactor a file or class",                      ["prompt"] = "Refactor " }
                };
                payload["hint"] = "I can read, write, and search files in this workspace.";
            }
            else
            {
                payload["promptsLabel"] = "Start a new project";
                payload["prompts"] = new List<object>
                {
                    new Dictionary<string, object> { ["icon"] = "new-file", ["text"] = "Create a new C# console app called Acme",        ["prompt"] = "Create a new C# console app called Acme" },
                    new Dictionary<string, object> { ["icon"] = "new-file", ["text"] = "Scaffold an ASP.NET minimal API named OrdersApi", ["prompt"] = "Scaffold an ASP.NET minimal API named OrdersApi" },
                    new Dictionary<string, object> { ["icon"] = "new-file", ["text"] = "Make a Python project called data-tools",        ["prompt"] = "Make a Python project called data-tools" }
                };
                payload["hint"] = "I'll create the folder under %USERPROFILE%\\source\\repos\\ and open it in Visual Studio. You can also open a folder first and then ask me to add to it.";
            }

            yield return ToJson(payload);
        }

        private static List<object> BuildModelList(JuniorOptionsPage options)
        {
            var list = new List<object>();
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            void Add(string id)
            {
                if (string.IsNullOrWhiteSpace(id)) return;
                id = id.Trim();
                if (!seen.Add(id)) return;
                list.Add(new Dictionary<string, object>
                {
                    ["name"] = id,
                    ["deploymentId"] = id,
                    ["supportsReasoning"] = false
                });
            }

            if (options != null)
            {
                if (!string.IsNullOrWhiteSpace(options.ActiveDeployment))
                    Add(options.ActiveDeployment);

                if (!string.IsNullOrWhiteSpace(options.AvailableModels))
                {
                    foreach (var part in options.AvailableModels.Split(new[] { ',', ';', '\n', '\r' }, StringSplitOptions.RemoveEmptyEntries))
                        Add(part);
                }
            }

            if (list.Count == 0)
            {
                list.Add(new Dictionary<string, object>
                {
                    ["name"] = "Junior (configure deployment in Tools > Options)",
                    ["deploymentId"] = "junior-active",
                    ["supportsReasoning"] = false
                });
            }

            return list;
        }

        public IReadOnlyList<string> HandleWebMessage(string json)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            var responses = new List<string>();
            var message = Deserialize(json);
            if (!message.TryGetValue("type", out var typeValue))
            {
                return responses;
            }

            var type = Convert.ToString(typeValue);

            if (type == "sendMessage")
            {
                var text = GetString(message, "text") ?? string.Empty;
                var images = GetStringList(message, "images");
                var files = GetFileList(message, "files");
                var mode = GetString(message, "mode");
                if (string.IsNullOrEmpty(mode)) mode = "agent";

                // Always echo the user's message locally so the UI shows it
                // even when the sidecar fails to launch or isn't configured.
                var echo = new Dictionary<string, object>
                {
                    ["type"] = "addUserMessage",
                    ["text"] = text
                };
                if (images != null && images.Count > 0) echo["images"] = images;
                if (files != null && files.Count > 0)
                {
                    var names = new List<string>();
                    foreach (var f in files)
                        if (f.TryGetValue("name", out var n) && n != null) names.Add(Convert.ToString(n));
                    echo["fileNames"] = names;
                }
                responses.Add(ToJson(echo));

                var options = OptionsProvider != null ? OptionsProvider() : null;
                var deployment = !string.IsNullOrWhiteSpace(selectedDeployment)
                    ? selectedDeployment
                    : options?.ActiveDeployment;

                if (options == null || string.IsNullOrWhiteSpace(deployment) || string.Equals(deployment, "junior-active", StringComparison.OrdinalIgnoreCase))
                {
                    responses.Add(ToJson(new Dictionary<string, object>
                    {
                        ["type"] = "startAssistantMessage",
                        ["provider"] = "local"
                    }));
                    responses.Add(ToJson(new Dictionary<string, object>
                    {
                        ["type"] = "appendAssistantText",
                        ["text"] = "Junior is not configured yet. Open **Tools > Options > Junior** and set:\n\n- **Provider** = Apim or Direct\n- **APIM Base URL** or **Endpoint**\n- **Authentication Mode** plus API key, bearer token, or Entra ID scopes\n- **Active Deployment** (Foundry deployment name)\n- **Available Models** (optional comma-separated list for the picker)\n\nThen try again."
                    }));
                    responses.Add(ToJson(new Dictionary<string, object> { ["type"] = "endAssistantMessage" }));
                    return responses;
                }

                var workspaceRoot = WorkspaceRootProvider?.Invoke();
                var diagnostics = CollectDiagnosticsSnapshot(workspaceRoot);
                ConfigureSidecar(options, deployment, workspaceRoot, diagnostics);
                sidecar.UpdateDiagnostics(diagnostics);
                automaticRepairRemaining = ClampAutomaticRepairAttempts(options.AutomaticRepairAttempts);
                pendingAutomaticRepair = false;
                pendingAutomaticRepairFingerprint = null;
                lastAutomaticRepairFingerprint = null;
                ResetRepairChain();
                // Sidecar will stream startAssistantMessage / appendAssistantText / endAssistantMessage back.
                EnsureActiveSession(text);
                if (pendingSeedTurns != null && pendingSeedTurns.Count > 0)
                {
                    // Configure() just cleared in-process history; seed it with the prior
                    // turns from the restored session so the model has full context.
                    sidecar.SeedHistory(pendingSeedTurns);
                    pendingSeedTurns = null;
                }
                List<string> userFileNames = null;
                if (files != null && files.Count > 0)
                {
                    userFileNames = new List<string>();
                    foreach (var f in files)
                        if (f.TryGetValue("name", out var n) && n != null) userFileNames.Add(Convert.ToString(n));
                }
                AppendUserMessage(text, images, userFileNames);
                sidecar.SendMessage(text, images, files, mode);
                responses.Add(CreateActiveSessionMessage());
                return responses;
            }

            if (type == "warmAuth")
            {
                var options = OptionsProvider != null ? OptionsProvider() : null;
                if (options == null || options.AuthMode != JuniorAuthMode.EntraId)
                {
                    responses.Add(BuildAuthStateMessage(options));
                    return responses;
                }

                var deployment = !string.IsNullOrWhiteSpace(selectedDeployment)
                    ? selectedDeployment
                    : options?.ActiveDeployment;
                if (string.IsNullOrWhiteSpace(deployment) || string.Equals(deployment, "junior-active", StringComparison.OrdinalIgnoreCase))
                {
                    responses.Add(ToJson(new Dictionary<string, object>
                    {
                        ["type"] = "authState",
                        ["state"] = "error",
                        ["message"] = "Junior is not configured yet. Open Tools > Options > Junior and set the provider and active deployment."
                    }));
                    return responses;
                }

                responses.Add(ToJson(new Dictionary<string, object>
                {
                    ["type"] = "authState",
                    ["state"] = "signingIn",
                    ["message"] = "Signing in with Microsoft Entra ID. A browser window may open; return here after authentication completes."
                }));
                sidecar.WarmAuth(options, deployment, WorkspaceRootProvider?.Invoke());
                return responses;
            }

            if (type == "splashSetApiKey")
            {
                SetApiKeyFromSplash(responses);
                return responses;
            }

            if (type == "splashOpenSettings")
            {
                OpenJuniorOptionsPage();
                responses.Add(BuildAuthStateMessage(OptionsProvider != null ? OptionsProvider() : null));
                return responses;
            }

            if (type == "splashDismissed")
            {
                return responses;
            }

            if (type == "selectModelById")
            {
                selectedDeployment = GetString(message, "deploymentId");
                return responses;
            }

            if (type == "selectPermissionLevel")
            {
                var requested = GetString(message, "level");
                permissionLevel = string.Equals(requested, "bypass", StringComparison.OrdinalIgnoreCase)
                    ? "bypass"
                    : "default";
                responses.Add(ToJson(new Dictionary<string, object>
                {
                    ["type"] = "setPermissionLevel",
                    ["level"] = permissionLevel
                }));
                return responses;
            }

            if (type == "cancelAgent")
            {
                sidecar.Cancel();
                return responses;
            }

            if (type == "approvalResponse")
            {
                var id = GetString(message, "id") ?? GetString(message, "approvalId");
                var allow = false;
                if (message.TryGetValue("allow", out var av))
                {
                    if (av is bool bv) allow = bv;
                    else if (av != null && bool.TryParse(Convert.ToString(av), out var pb)) allow = pb;
                }
                var scope = GetString(message, "scope");
                var category = GetString(message, "category");
                if (!string.IsNullOrEmpty(id))
                    sidecar.SendApprovalResponse(id, allow, scope, category);
                return responses;
            }

            if (type == "continueIteration")
            {
                var shouldContinue = false;
                if (message.TryGetValue("shouldContinue", out var sc) && sc is bool b) shouldContinue = b;
                else if (sc != null && bool.TryParse(Convert.ToString(sc), out var pb)) shouldContinue = pb;

                if (shouldContinue)
                {
                    var options = OptionsProvider != null ? OptionsProvider() : null;
                    var deployment = !string.IsNullOrWhiteSpace(selectedDeployment)
                        ? selectedDeployment
                        : options?.ActiveDeployment;
                    if (options != null && !string.IsNullOrWhiteSpace(deployment))
                    {
                        var workspaceRoot = WorkspaceRootProvider?.Invoke();
                        var diagnostics = CollectDiagnosticsSnapshot(workspaceRoot);
                        ConfigureSidecar(options, deployment, workspaceRoot, diagnostics);
                        sidecar.UpdateDiagnostics(diagnostics);
                        sidecar.SendMessage("Continue working on the previous task. Pick up exactly where you left off and finish it.");
                    }
                }
                return responses;
            }

            if (type == "requestSessionList")
            {
                responses.Add(CreateSessionListMessage());
                return responses;
            }

            if (type == "newSession")
            {
                StartNewSessionInternal(responses, resetSidecar: true);
                return responses;
            }

            if (type == "switchSession")
            {
                var sid = GetString(message, "sessionId") ?? GetString(message, "id");
                var session = sessionStore.Load(sid);
                if (session == null)
                {
                    StartNewSessionInternal(responses, resetSidecar: true);
                    return responses;
                }
                activeSession = session;
                assistantBuffer = null;
                liveWorkingBlocks.Clear();
                sidecar.ResetHistory();

                // Stash prior turns so the next user message reseeds the agent's history
                // (Configure() runs on every send and would otherwise wipe a direct seed).
                var seed = new List<KeyValuePair<string, string>>();
                foreach (var item in session.Items ?? new List<JuniorSessionItem>())
                {
                    if ((item.Kind == "user" || item.Kind == "assistant")
                        && item.Payload != null
                        && item.Payload.TryGetValue("text", out var tv0)
                        && tv0 != null)
                    {
                        var ttext = Convert.ToString(tv0);
                        if (!string.IsNullOrWhiteSpace(ttext))
                            seed.Add(new KeyValuePair<string, string>(item.Kind, ttext));
                    }
                }
                pendingSeedTurns = seed.Count > 0 ? seed : null;

                responses.Add(ToJson(new Dictionary<string, object> { ["type"] = "sessionCleared" }));

                var transcriptItems = new List<object>();
                foreach (var item in session.Items ?? new List<JuniorSessionItem>())
                {
                    var dict = new Dictionary<string, object> { ["kind"] = item.Kind };
                    if (item.Payload != null)
                    {
                        foreach (var kv in item.Payload)
                            dict[kv.Key] = kv.Value;
                    }
                    transcriptItems.Add(dict);
                }
                responses.Add(ToJson(new Dictionary<string, object>
                {
                    ["type"] = "restoreTranscript",
                    ["transcript"] = new Dictionary<string, object> { ["items"] = transcriptItems }
                }));
                responses.Add(CreateActiveSessionMessage());
                responses.Add(CreateSessionListMessage());
                return responses;
            }

            if (type == "deleteSession")
            {
                var sid = GetString(message, "sessionId") ?? GetString(message, "id");
                if (!string.IsNullOrEmpty(sid))
                {
                    var wasActive = activeSession != null && string.Equals(activeSession.Id, sid, StringComparison.OrdinalIgnoreCase);
                    sessionStore.Delete(sid);
                    if (wasActive)
                    {
                        StartNewSessionInternal(responses, resetSidecar: true);
                    }
                    else
                    {
                        responses.Add(CreateSessionListMessage());
                    }
                }
                return responses;
            }

            if (type == "attachFile")
            {
                AttachFilesViaDialog(responses);
                return responses;
            }

            if (type == "manageMcpServers")
            {
                var options = OptionsProvider != null ? OptionsProvider() : null;
                var deployment = !string.IsNullOrWhiteSpace(selectedDeployment)
                    ? selectedDeployment
                    : options?.ActiveDeployment;
                if (options == null || string.IsNullOrWhiteSpace(deployment) || string.Equals(deployment, "junior-active", StringComparison.OrdinalIgnoreCase))
                {
                    responses.Add(ToJson(new Dictionary<string, object>
                    {
                        ["type"] = "mcpTools",
                        ["enabled"] = false,
                        ["configured"] = false,
                        ["connectedServerCount"] = 0,
                        ["toolCount"] = 0,
                        ["tools"] = new object[0]
                    }));
                    return responses;
                }

                responses.Add(ToJson(new Dictionary<string, object> { ["type"] = "mcpToolsLoading" }));
                var workspaceRoot = WorkspaceRootProvider?.Invoke();
                var diagnostics = CollectDiagnosticsSnapshot(workspaceRoot);
                ConfigureSidecar(options, deployment, workspaceRoot, diagnostics);
                sidecar.UpdateDiagnostics(diagnostics);
                sidecar.RequestMcpTools();
                return responses;
            }

            if (type == "setMcpToolEnabled")
            {
                var functionName = GetString(message, "functionName");
                var enabled = true;
                if (message.TryGetValue("enabled", out var enabledValue))
                {
                    if (enabledValue is bool boolValue) enabled = boolValue;
                    else if (enabledValue != null && bool.TryParse(Convert.ToString(enabledValue), out var parsed)) enabled = parsed;
                }
                sidecar.SetMcpToolEnabled(functionName, enabled);
                return responses;
            }

            return responses;
        }

        private void SetApiKeyFromSplash(List<string> responses)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            var options = OptionsProvider != null ? OptionsProvider() : null;
            if (options == null)
            {
                responses.Add(CreateErrorMessage("Junior options are not available yet."));
                return;
            }

            var deployment = !string.IsNullOrWhiteSpace(selectedDeployment)
                ? selectedDeployment
                : options.ActiveDeployment;
            var target = JuniorCredentialStore.CreateApiKeyTarget(options.Provider.ToString(), deployment);
            var title = "Set Junior API Key";
            var prompt = "Store the API key in Windows Credential Manager for " + options.Provider + " / " + (string.IsNullOrWhiteSpace(deployment) ? "default" : deployment) + ".";
            var apiKey = PromptForSecret(title, prompt);
            if (apiKey == null) return;
            if (string.IsNullOrWhiteSpace(apiKey))
            {
                responses.Add(CreateErrorMessage("API key was empty; nothing was stored."));
                return;
            }

            JuniorCredentialStore.WriteSecret(target, apiKey);
            options.ApiKey = JuniorCredentialStore.ToReference(target);
            options.AuthMode = JuniorAuthMode.ApiKey;
            options.SaveSettingsToStorage();
            JuniorSidecarService.Shared.ResetHistory();

            responses.Add(ToJson(new Dictionary<string, object>
            {
                ["type"] = "secureSecretState",
                ["state"] = "stored",
                ["message"] = "API key stored securely."
            }));
            responses.Add(BuildAuthStateMessage(options));
        }

        private static string PromptForSecret(string title, string prompt)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            var window = new System.Windows.Window
            {
                Title = title,
                Width = 430,
                Height = 190,
                ResizeMode = ResizeMode.NoResize,
                WindowStartupLocation = WindowStartupLocation.CenterScreen,
                ShowInTaskbar = false
            };

            var root = new Grid { Margin = new Thickness(14) };
            root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

            var label = new TextBlock
            {
                Text = prompt,
                TextWrapping = TextWrapping.Wrap,
                Margin = new Thickness(0, 0, 0, 10)
            };
            Grid.SetRow(label, 0);
            root.Children.Add(label);

            var passwordBox = new PasswordBox
            {
                MinWidth = 360,
                Margin = new Thickness(0, 0, 0, 8)
            };
            Grid.SetRow(passwordBox, 1);
            root.Children.Add(passwordBox);

            var hint = new TextBlock
            {
                Text = "The key is saved as a Windows Generic Credential; VS settings store only a cred: reference.",
                TextWrapping = TextWrapping.Wrap,
                FontSize = 11,
                Opacity = 0.75,
                Margin = new Thickness(0, 0, 0, 12)
            };
            Grid.SetRow(hint, 2);
            root.Children.Add(hint);

            var buttons = new StackPanel
            {
                Orientation = Orientation.Horizontal,
                HorizontalAlignment = HorizontalAlignment.Right
            };
            var okButton = new Button { Content = "Store", Width = 80, IsDefault = true, Margin = new Thickness(0, 0, 8, 0) };
            var cancelButton = new Button { Content = "Cancel", Width = 80, IsCancel = true };
            okButton.Click += (s, e) => { window.DialogResult = true; window.Close(); };
            cancelButton.Click += (s, e) => { window.DialogResult = false; window.Close(); };
            buttons.Children.Add(okButton);
            buttons.Children.Add(cancelButton);
            Grid.SetRow(buttons, 3);
            root.Children.Add(buttons);

            window.Content = root;
            passwordBox.Focus();
            return window.ShowDialog() == true ? passwordBox.Password : null;
        }

        private static void OpenJuniorOptionsPage()
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            try
            {
                JuniorStudioPackage.Instance?.ShowOptionPage(typeof(JuniorOptionsPage));
            }
            catch { }
        }

        /// <summary>
        /// Open a native file picker, read each selected file, and emit the
        /// matching webview events: text files become <c>fileAttached</c> with
        /// inline content; images become <c>imageAttached</c> with a base64
        /// data URI. All work runs synchronously on the WPF UI thread.
        /// </summary>
        private void AttachFilesViaDialog(List<string> responses)
        {
            try
            {
                var dlg = new Microsoft.Win32.OpenFileDialog
                {
                    Title = "Attach files to Junior",
                    Multiselect = true,
                    CheckFileExists = true,
                    Filter = "All supported|*.txt;*.md;*.json;*.xml;*.yaml;*.yml;*.csv;*.log;*.cs;*.ts;*.tsx;*.js;*.jsx;*.py;*.java;*.go;*.rs;*.rb;*.php;*.c;*.cpp;*.h;*.hpp;*.html;*.css;*.scss;*.sql;*.sh;*.ps1;*.bicep;*.tf;*.csproj;*.sln;*.png;*.jpg;*.jpeg;*.gif;*.bmp;*.webp|Text files|*.txt;*.md;*.json;*.xml;*.yaml;*.yml;*.csv;*.log;*.cs;*.ts;*.tsx;*.js;*.jsx;*.py;*.java;*.go;*.rs;*.rb;*.php;*.c;*.cpp;*.h;*.hpp;*.html;*.css;*.scss;*.sql;*.sh;*.ps1;*.bicep;*.tf;*.csproj;*.sln|Images|*.png;*.jpg;*.jpeg;*.gif;*.bmp;*.webp|All files|*.*"
                };
                var ok = dlg.ShowDialog();
                if (ok != true || dlg.FileNames == null) return;

                const long maxImageBytes = 20L * 1024 * 1024;
                const long maxTextBytes = 1L * 1024 * 1024;

                foreach (var path in dlg.FileNames)
                {
                    try
                    {
                        var info = new System.IO.FileInfo(path);
                        var ext = System.IO.Path.GetExtension(path).ToLowerInvariant();
                        var isImage = ext == ".png" || ext == ".jpg" || ext == ".jpeg" || ext == ".gif" || ext == ".bmp" || ext == ".webp";

                        if (isImage)
                        {
                            if (info.Length > maxImageBytes)
                            {
                                responses.Add(ToJson(new Dictionary<string, object> { ["type"] = "error", ["message"] = "Image too large (max 20 MB): " + info.Name }));
                                continue;
                            }
                            var bytes = System.IO.File.ReadAllBytes(path);
                            var mime = ext == ".jpg" ? "image/jpeg" : ("image/" + ext.TrimStart('.'));
                            var dataUri = "data:" + mime + ";base64," + Convert.ToBase64String(bytes);
                            responses.Add(ToJson(new Dictionary<string, object>
                            {
                                ["type"] = "imageAttached",
                                ["name"] = info.Name,
                                ["dataUri"] = dataUri
                            }));
                        }
                        else
                        {
                            if (info.Length > maxTextBytes)
                            {
                                responses.Add(ToJson(new Dictionary<string, object> { ["type"] = "error", ["message"] = "File too large (max 1 MB): " + info.Name }));
                                continue;
                            }
                            string content;
                            try { content = System.IO.File.ReadAllText(path); }
                            catch (Exception ex)
                            {
                                responses.Add(ToJson(new Dictionary<string, object> { ["type"] = "error", ["message"] = "Could not read " + info.Name + ": " + ex.Message }));
                                continue;
                            }
                            responses.Add(ToJson(new Dictionary<string, object>
                            {
                                ["type"] = "fileAttached",
                                ["name"] = info.Name,
                                ["content"] = content
                            }));
                        }
                    }
                    catch (Exception ex)
                    {
                        responses.Add(ToJson(new Dictionary<string, object> { ["type"] = "error", ["message"] = "Attach failed: " + ex.Message }));
                    }
                }
            }
            catch (Exception ex)
            {
                responses.Add(ToJson(new Dictionary<string, object> { ["type"] = "error", ["message"] = "File picker failed: " + ex.Message }));
            }
        }

        public string CreateErrorMessage(string text)
        {
            return ToJson(new Dictionary<string, object> { ["type"] = "error", ["message"] = text });
        }

        private void RefreshDiagnosticsSnapshot()
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            if (!sidecar.IsRunning) return;
            sidecar.UpdateDiagnostics(CollectDiagnosticsSnapshot(WorkspaceRootProvider?.Invoke()));
        }

        private void StartAutomaticRepairTurn()
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            var options = OptionsProvider != null ? OptionsProvider() : null;
            var deployment = !string.IsNullOrWhiteSpace(selectedDeployment)
                ? selectedDeployment
                : options?.ActiveDeployment;
            if (options == null || string.IsNullOrWhiteSpace(deployment)) return;

            var workspaceRoot = WorkspaceRootProvider?.Invoke();
            var diagnostics = CollectDiagnosticsSnapshot(workspaceRoot);
            ConfigureSidecar(options, deployment, workspaceRoot, diagnostics);
            sidecar.UpdateDiagnostics(diagnostics);
            sidecar.SendMessage("Continue fixing the validation errors from the previous attempt. Start with the captured Repair targets list, then use GetDiagnostics and the validation output as needed. Make the smallest safe changes, then validate again.", mode: "agent");
        }

        private void ConfigureSidecar(JuniorOptionsPage options, string deployment, string workspaceRoot, IList<IDictionary<string, object>> diagnostics)
        {
            sidecar.Configure(options, deployment, workspaceRoot, diagnostics, permissionLevel);
        }

        private static int ClampAutomaticRepairAttempts(int value)
        {
            if (value < 0) return 0;
            if (value > 3) return 3;
            return value;
        }

        private static List<IDictionary<string, object>> CollectDiagnosticsSnapshot(string workspaceRoot)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            var result = new List<IDictionary<string, object>>();
            try
            {
                var dte = Package.GetGlobalService(typeof(EnvDTE.DTE));
                var toolWindows = GetProperty(dte, "ToolWindows");
                var errorList = GetProperty(toolWindows, "ErrorList");
                var items = GetProperty(errorList, "ErrorItems");
                if (items == null) return result;

                var root = string.IsNullOrWhiteSpace(workspaceRoot) ? null : Path.GetFullPath(workspaceRoot.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar);
                var count = Math.Min(ToInt(GetProperty(items, "Count")), 200);
                for (var i = 1; i <= count; i++)
                {
                    object item = null;
                    try { item = InvokeMethod(items, "Item", i); }
                    catch { continue; }
                    if (item == null) continue;

                    var message = Convert.ToString(GetProperty(item, "Description")) ?? string.Empty;
                    if (string.IsNullOrWhiteSpace(message)) continue;
                    var file = NormalizeDiagnosticPath(Convert.ToString(GetProperty(item, "FileName")) ?? string.Empty, root);
                    var severity = MapDiagnosticSeverity(Convert.ToString(GetProperty(item, "ErrorLevel")) ?? string.Empty);

                    result.Add(new Dictionary<string, object>
                    {
                        ["severity"] = severity,
                        ["file"] = file,
                        ["line"] = ToInt(GetProperty(item, "Line")),
                        ["column"] = ToInt(GetProperty(item, "Column")),
                        ["code"] = string.Empty,
                        ["message"] = message,
                        ["project"] = Convert.ToString(GetProperty(item, "Project")) ?? string.Empty
                    });
                }
            }
            catch { }
            return result;
        }

        private static string NormalizeDiagnosticPath(string fileName, string root)
        {
            if (string.IsNullOrWhiteSpace(fileName)) return string.Empty;
            try
            {
                var full = Path.IsPathRooted(fileName) ? Path.GetFullPath(fileName) : fileName;
                if (!string.IsNullOrWhiteSpace(root) && Path.IsPathRooted(full) && full.StartsWith(root, StringComparison.OrdinalIgnoreCase))
                {
                    return full.Substring(root.Length).Replace('\\', '/');
                }
                return full.Replace('\\', '/');
            }
            catch { return fileName.Replace('\\', '/'); }
        }

        private static string MapDiagnosticSeverity(string raw)
        {
            if (string.IsNullOrWhiteSpace(raw)) return "Message";
            if (raw.IndexOf("High", StringComparison.OrdinalIgnoreCase) >= 0 || raw.IndexOf("Error", StringComparison.OrdinalIgnoreCase) >= 0) return "Error";
            if (raw.IndexOf("Medium", StringComparison.OrdinalIgnoreCase) >= 0 || raw.IndexOf("Warning", StringComparison.OrdinalIgnoreCase) >= 0) return "Warning";
            return "Message";
        }

        private static object GetProperty(object value, string propertyName)
        {
            if (value == null || string.IsNullOrEmpty(propertyName)) return null;
            try { return value.GetType().InvokeMember(propertyName, System.Reflection.BindingFlags.GetProperty, null, value, null); }
            catch { return null; }
        }

        private static object InvokeMethod(object value, string methodName, params object[] args)
        {
            if (value == null || string.IsNullOrEmpty(methodName)) return null;
            try { return value.GetType().InvokeMember(methodName, System.Reflection.BindingFlags.InvokeMethod, null, value, args); }
            catch { return null; }
        }

        private static int ToInt(object value)
        {
            try { return value == null ? 0 : Convert.ToInt32(value); }
            catch { return 0; }
        }

        // ── Session lifecycle ───────────────────────────────────────────────

        /// <summary>Lists persisted sessions with the active id (may be null).</summary>
        public string CreateSessionListMessage()
        {
            var sessions = sessionStore.ListSessions();
            var arr = new List<object>(sessions.Count);
            foreach (var s in sessions)
            {
                arr.Add(new Dictionary<string, object>
                {
                    ["id"] = s.Id,
                    ["title"] = s.Title,
                    ["createdAt"] = s.CreatedAt,
                    ["updatedAt"] = s.UpdatedAt,
                    ["messageCount"] = s.MessageCount
                });
            }
            return ToJson(new Dictionary<string, object>
            {
                ["type"] = "sessionList",
                ["sessions"] = arr,
                ["activeId"] = activeSession?.Id
            });
        }

        private string CreateActiveSessionMessage()
        {
            return ToJson(new Dictionary<string, object>
            {
                ["type"] = "activeSession",
                ["id"] = activeSession?.Id,
                ["title"] = activeSession?.Title
            });
        }

        private void StartNewSessionInternal(List<string> responses, bool resetSidecar)
        {
            activeSession = null;
            assistantBuffer = null;
            activeAssistantProvider = null;
            liveWorkingBlocks.Clear();
            pendingSeedTurns = null;
            if (resetSidecar) sidecar.ResetHistory();
            responses.Add(ToJson(new Dictionary<string, object> { ["type"] = "sessionCleared" }));
            foreach (var m in BuildWorkspaceBannerMessages()) responses.Add(m);
            responses.Add(CreateActiveSessionMessage());
            responses.Add(CreateSessionListMessage());
        }

        private void EnsureActiveSession(string firstUserText)
        {
            if (activeSession != null) return;
            activeSession = sessionStore.CreateNew(firstUserText);
            sessionStore.Save(activeSession);
        }

        private void AppendItem(string kind, Dictionary<string, object> payload)
        {
            if (activeSession == null) return;
            activeSession.Items.Add(new JuniorSessionItem { Kind = kind, Payload = payload ?? new Dictionary<string, object>() });
            sessionStore.Save(activeSession);
        }

        private void AppendUserMessage(string text, List<string> images, List<string> fileNames)
        {
            if (activeSession == null) return;
            var payload = new Dictionary<string, object> { ["text"] = text ?? string.Empty };
            if (images != null && images.Count > 0) payload["images"] = images;
            if (fileNames != null && fileNames.Count > 0) payload["fileNames"] = fileNames;
            AppendItem("user", payload);
        }

        private void TryRecordAssistantMessage(string json)
        {
            // Best-effort: capture assistant text, narration, and working blocks into the
            // active session for later replay. Failures here must never break streaming.
            if (activeSession == null || string.IsNullOrEmpty(json)) return;
            try
            {
                var msg = serializer.Deserialize<Dictionary<string, object>>(json);
                if (msg == null || !msg.TryGetValue("type", out var tv)) return;
                var type = Convert.ToString(tv);
                switch (type)
                {
                    case "startAssistantMessage":
                        assistantBuffer = new System.Text.StringBuilder();
                        activeAssistantProvider = msg.TryGetValue("provider", out var p) ? Convert.ToString(p) : null;
                        break;
                    case "appendAssistantText":
                        if (assistantBuffer == null) assistantBuffer = new System.Text.StringBuilder();
                        if (msg.TryGetValue("text", out var t) && t != null)
                            assistantBuffer.Append(Convert.ToString(t));
                        break;
                    case "endAssistantMessage":
                        if (assistantBuffer != null && assistantBuffer.Length > 0)
                        {
                            var payload = new Dictionary<string, object>
                            {
                                ["text"] = assistantBuffer.ToString()
                            };
                            if (!string.IsNullOrEmpty(activeAssistantProvider)) payload["provider"] = activeAssistantProvider;
                            AppendItem("assistant", payload);
                        }
                        assistantBuffer = null;
                        activeAssistantProvider = null;
                        break;
                    case "narrationText":
                        if (msg.TryGetValue("text", out var nt) && nt != null)
                        {
                            var ntxt = Convert.ToString(nt);
                            if (!string.IsNullOrWhiteSpace(ntxt))
                                AppendItem("narration", new Dictionary<string, object> { ["text"] = ntxt });
                        }
                        break;
                    case "workingBlockStarted":
                        if (msg.TryGetValue("block", out var bv) && bv is Dictionary<string, object> bd)
                        {
                            var id = bd.TryGetValue("id", out var bidv) ? Convert.ToString(bidv) : null;
                            if (!string.IsNullOrEmpty(id))
                            {
                                var block = new Dictionary<string, object>
                                {
                                    ["id"] = id,
                                    ["title"] = bd.TryGetValue("title", out var btv) ? Convert.ToString(btv) : "Working",
                                    ["status"] = "running",
                                    ["entries"] = new List<object>(),
                                    ["startedAt"] = JuniorSessionStore.NowMs()
                                };
                                liveWorkingBlocks[id] = block;
                            }
                        }
                        break;
                    case "workingActionAdded":
                        {
                            var blockId = msg.TryGetValue("blockId", out var bidv2) ? Convert.ToString(bidv2) : null;
                            if (!string.IsNullOrEmpty(blockId) && liveWorkingBlocks.TryGetValue(blockId, out var block))
                            {
                                var entries = (List<object>)block["entries"];
                                if (msg.TryGetValue("entry", out var ev) && ev is Dictionary<string, object> ed)
                                {
                                    entries.Add(CloneDict(ed));
                                }
                            }
                        }
                        break;
                    case "workingActionUpdated":
                        {
                            var blockId = msg.TryGetValue("blockId", out var bidv3) ? Convert.ToString(bidv3) : null;
                            var entryId = msg.TryGetValue("entryId", out var eidv) ? Convert.ToString(eidv) : null;
                            if (!string.IsNullOrEmpty(blockId) && !string.IsNullOrEmpty(entryId)
                                && liveWorkingBlocks.TryGetValue(blockId, out var block))
                            {
                                var entries = (List<object>)block["entries"];
                                foreach (var entryObj in entries)
                                {
                                    if (entryObj is Dictionary<string, object> entry
                                        && entry.TryGetValue("id", out var eidv2)
                                        && string.Equals(Convert.ToString(eidv2), entryId, StringComparison.Ordinal))
                                    {
                                        if (msg.TryGetValue("status", out var sv)) entry["status"] = sv;
                                        if (msg.TryGetValue("detail", out var dv)) entry["detail"] = dv;
                                        break;
                                    }
                                }
                            }
                        }
                        break;
                    case "workingTextAppended":
                        {
                            var blockId = msg.TryGetValue("blockId", out var bidv4) ? Convert.ToString(bidv4) : null;
                            if (!string.IsNullOrEmpty(blockId) && liveWorkingBlocks.TryGetValue(blockId, out var block))
                            {
                                var entries = (List<object>)block["entries"];
                                if (msg.TryGetValue("entry", out var ev2) && ev2 is Dictionary<string, object> ed2)
                                {
                                    entries.Add(CloneDict(ed2));
                                }
                            }
                        }
                        break;
                    case "workingBlockCompleted":
                        {
                            var blockId = msg.TryGetValue("blockId", out var bidv5) ? Convert.ToString(bidv5) : null;
                            if (!string.IsNullOrEmpty(blockId) && liveWorkingBlocks.TryGetValue(blockId, out var block))
                            {
                                block["status"] = "completed";
                                if (msg.TryGetValue("summary", out var sv2)) block["summary"] = sv2;
                                if (msg.TryGetValue("completedAt", out var cv)) block["completedAt"] = cv;
                                else block["completedAt"] = JuniorSessionStore.NowMs();
                                AppendItem("working-block", new Dictionary<string, object> { ["block"] = block });
                                liveWorkingBlocks.Remove(blockId);
                            }
                        }
                        break;
                    case "turnSummary":
                        {
                            var payload = CloneDict(msg);
                            payload.Remove("type");
                            AppendItem("turn-summary", payload);
                        }
                        break;
                    case "repoInstructions":
                        {
                            var payload = CloneDict(msg);
                            payload.Remove("type");
                            AppendItem("repo-instructions", payload);
                        }
                        break;
                    case "repairChainSummary":
                        {
                            var payload = CloneDict(msg);
                            payload.Remove("type");
                            AppendItem("repair-chain-summary", payload);
                        }
                        break;
                }
            }
            catch { /* swallow */ }
        }

        private static Dictionary<string, object> CloneDict(Dictionary<string, object> source)
        {
            var copy = new Dictionary<string, object>(source.Count, StringComparer.Ordinal);
            foreach (var kv in source) copy[kv.Key] = kv.Value;
            return copy;
        }

        public void Dispose()
        {
            diagnosticsTimer.Stop();
            sidecar.MessageReceived -= OnSidecarMessage;
        }

        private Dictionary<string, object> Deserialize(string json)
        {
            try
            {
                return serializer.Deserialize<Dictionary<string, object>>(json) ?? new Dictionary<string, object>();
            }
            catch
            {
                return new Dictionary<string, object>();
            }
        }

        private string ToJson(Dictionary<string, object> message)
        {
            return serializer.Serialize(message);
        }

        private static string GetString(Dictionary<string, object> message, string key)
        {
            if (message == null) return null;
            return message.TryGetValue(key, out var value) ? Convert.ToString(value) : null;
        }

        private static Dictionary<string, object> GetDictionary(Dictionary<string, object> message, string key)
        {
            if (message == null || !message.TryGetValue(key, out var value) || value == null) return null;
            return value as Dictionary<string, object>;
        }

        private static bool GetBool(Dictionary<string, object> message, string key)
        {
            if (message == null || !message.TryGetValue(key, out var value) || value == null) return false;
            if (value is bool b) return b;
            return bool.TryParse(Convert.ToString(value), out var parsed) && parsed;
        }

        private static List<string> GetStringList(Dictionary<string, object> message, string key)
        {
            if (!message.TryGetValue(key, out var value) || value == null) return null;
            var list = new List<string>();
            if (value is System.Collections.IEnumerable e && !(value is string))
            {
                foreach (var item in e)
                {
                    if (item == null) continue;
                    list.Add(Convert.ToString(item));
                }
            }
            return list.Count == 0 ? null : list;
        }

        private static List<IDictionary<string, object>> GetFileList(Dictionary<string, object> message, string key)
        {
            if (!message.TryGetValue(key, out var value) || value == null) return null;
            var list = new List<IDictionary<string, object>>();
            if (value is System.Collections.IEnumerable e && !(value is string))
            {
                foreach (var item in e)
                {
                    if (item is IDictionary<string, object> d)
                    {
                        var name = d.TryGetValue("name", out var n) ? Convert.ToString(n) : null;
                        var content = d.TryGetValue("content", out var c) ? Convert.ToString(c) : null;
                        if (string.IsNullOrEmpty(name) || content == null) continue;
                        list.Add(new Dictionary<string, object>
                        {
                            ["name"] = name,
                            ["content"] = content
                        });
                    }
                }
            }
            return list.Count == 0 ? null : list;
        }
    }
}
