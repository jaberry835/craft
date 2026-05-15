using System;
using System.ComponentModel.Design;
using System.IO;
using EnvDTE;
using JuniorStudio.VisualStudio.Editor;
using JuniorStudio.VisualStudio.Services;
using JuniorStudio.VisualStudio.ToolWindows;
using Microsoft.VisualStudio.Shell;
using Task = System.Threading.Tasks.Task;

namespace JuniorStudio.VisualStudio.Commands
{
    internal sealed class EditorSelectionCommands
    {
        public const int ExplainSelectionCommandId = 0x0110;
        public const int ReviewSelectionCommandId = 0x0111;
        public const int FixSelectionCommandId = 0x0112;
        public const int DiffReviewSelectionCommandId = 0x0113;
        public const int InlineCompletionCommandId = 0x0114;
        public const int AcceptGhostTextCommandId = 0x0115;

        private readonly AsyncPackage package;

        private EditorSelectionCommands(AsyncPackage package, OleMenuCommandService commandService)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            this.package = package ?? throw new ArgumentNullException(nameof(package));
            commandService = commandService ?? throw new ArgumentNullException(nameof(commandService));

            AddCommand(commandService, ExplainSelectionCommandId, "Explain this code in detail.", "Explain");
            AddCommand(commandService, ReviewSelectionCommandId, "Review this code for bugs, security issues, and improvements.", "Review");
            AddCommand(commandService, FixSelectionCommandId, "Fix any issues in this code. Apply the fix to the workspace file when you are confident, and explain what changed.", "Fix");
            AddSelectionCommand(commandService, DiffReviewSelectionCommandId, ExecuteDiffReview);
            AddInlineCompletionCommand(commandService);
            AddGhostTextCommand(commandService);
        }

        public static EditorSelectionCommands Instance { get; private set; }

        public static async Task InitializeAsync(AsyncPackage package)
        {
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync(package.DisposalToken);
            var commandService = await package.GetServiceAsync(typeof(IMenuCommandService)) as OleMenuCommandService;
            Instance = new EditorSelectionCommands(package, commandService);
        }

        private void AddCommand(OleMenuCommandService commandService, int commandId, string instruction, string label)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            var menuCommandId = new CommandID(OpenJuniorChatCommand.CommandSet, commandId);
            var command = new OleMenuCommand((s, e) => Execute(instruction), menuCommandId);
            command.BeforeQueryStatus += (s, e) =>
            {
                ThreadHelper.ThrowIfNotOnUIThread();
                var menu = (OleMenuCommand)s;
                menu.Enabled = TryGetEditorSelection(out var selection) && !string.IsNullOrWhiteSpace(selection.SelectedText);
            };
            commandService.AddCommand(command);
        }

        private void AddGhostTextCommand(OleMenuCommandService commandService)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            var menuCommandId = new CommandID(OpenJuniorChatCommand.CommandSet, AcceptGhostTextCommandId);
            var command = new OleMenuCommand((s, e) => AcceptGhostText(), menuCommandId);
            command.BeforeQueryStatus += (s, e) =>
            {
                ThreadHelper.ThrowIfNotOnUIThread();
                var menu = (OleMenuCommand)s;
                menu.Enabled = JuniorGhostTextController.ActiveController != null && JuniorGhostTextController.ActiveController.HasSuggestion;
            };
            commandService.AddCommand(command);
        }

        private void AddSelectionCommand(OleMenuCommandService commandService, int commandId, Action execute)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            var menuCommandId = new CommandID(OpenJuniorChatCommand.CommandSet, commandId);
            var command = new OleMenuCommand((s, e) => execute(), menuCommandId);
            command.BeforeQueryStatus += (s, e) =>
            {
                ThreadHelper.ThrowIfNotOnUIThread();
                var menu = (OleMenuCommand)s;
                menu.Enabled = TryGetEditorSelection(out var selection) && !string.IsNullOrWhiteSpace(selection.SelectedText);
            };
            commandService.AddCommand(command);
        }

        private void AddInlineCompletionCommand(OleMenuCommandService commandService)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            var menuCommandId = new CommandID(OpenJuniorChatCommand.CommandSet, InlineCompletionCommandId);
            var command = new OleMenuCommand((s, e) => ExecuteInlineCompletion(), menuCommandId);
            command.BeforeQueryStatus += (s, e) =>
            {
                ThreadHelper.ThrowIfNotOnUIThread();
                var menu = (OleMenuCommand)s;
                menu.Enabled = TryGetEditorContext(out var context);
            };
            commandService.AddCommand(command);
        }

        private void Execute(string instruction)
        {
            package.JoinableTaskFactory.RunAsync(async delegate
            {
                await package.JoinableTaskFactory.SwitchToMainThreadAsync(package.DisposalToken);
                if (!TryGetEditorSelection(out var selection) || string.IsNullOrWhiteSpace(selection.SelectedText))
                {
                    VsShellUtilities.ShowMessageBox(
                        package,
                        "Select code in the active editor first, then run the Junior selection command.",
                        "Junior",
                        Microsoft.VisualStudio.Shell.Interop.OLEMSGICON.OLEMSGICON_INFO,
                        Microsoft.VisualStudio.Shell.Interop.OLEMSGBUTTON.OLEMSGBUTTON_OK,
                        Microsoft.VisualStudio.Shell.Interop.OLEMSGDEFBUTTON.OLEMSGDEFBUTTON_FIRST);
                    return;
                }

                var window = await package.ShowToolWindowAsync(typeof(JuniorChatToolWindow), 0, true, package.DisposalToken);
                if (window?.Content is JuniorChatToolWindowControl control)
                {
                    control.SubmitEditorSelectionPrompt(BuildPrompt(instruction, selection));
                }
            }).FileAndForget("JuniorStudio/EditorSelectionCommand");
        }

        private void ExecuteDiffReview()
        {
            package.JoinableTaskFactory.RunAsync(async delegate
            {
                await package.JoinableTaskFactory.SwitchToMainThreadAsync(package.DisposalToken);
                if (!TryGetEditorSelection(out var selection) || string.IsNullOrWhiteSpace(selection.SelectedText))
                {
                    ShowInfo("Select code in the active editor first, then run Junior: Preview Fix as Diff.");
                    return;
                }

                var language = GuessLanguage(selection.FilePath);
                var prompt = "Return a complete replacement for the selected code. Fix correctness, clarity, and maintainability issues. Return only the replacement code, with no markdown fences or explanation." + Environment.NewLine + Environment.NewLine +
                    "File: " + selection.FilePath + Environment.NewLine +
                    "Selection: lines " + selection.StartLine + "-" + selection.EndLine + Environment.NewLine + Environment.NewLine +
                    "```" + language + Environment.NewLine + selection.SelectedText + Environment.NewLine + "```";

                string proposed;
                try
                {
                    proposed = await GenerateEditorTextAsync("You produce precise code replacements for Visual Studio diff preview. Output only code.", prompt);
                }
                catch (Exception ex)
                {
                    ShowInfo(ex.Message);
                    return;
                }

                proposed = ExtractCode(proposed).TrimEnd() + Environment.NewLine;
                if (string.IsNullOrWhiteSpace(proposed))
                {
                    ShowInfo("Junior did not return a proposed replacement.");
                    return;
                }

                await package.JoinableTaskFactory.SwitchToMainThreadAsync(package.DisposalToken);
                OpenDiff(selection, proposed);
            }).FileAndForget("JuniorStudio/DiffReviewSelectionCommand");
        }

        private void ExecuteInlineCompletion()
        {
            package.JoinableTaskFactory.RunAsync(async delegate
            {
                await package.JoinableTaskFactory.SwitchToMainThreadAsync(package.DisposalToken);
                if (!TryGetEditorContext(out var context))
                {
                    ShowInfo("Open a text editor and place the caret where Junior should complete code.");
                    return;
                }

                var prompt = "Complete the code at the caret. Return only the text that should be inserted at the caret, with no markdown fences, no explanation, and no repeated prefix." + Environment.NewLine + Environment.NewLine +
                    "File: " + context.FilePath + Environment.NewLine +
                    "Language: " + GuessLanguage(context.FilePath) + Environment.NewLine + Environment.NewLine +
                    "Prefix before caret:" + Environment.NewLine + "```" + GuessLanguage(context.FilePath) + Environment.NewLine + context.Prefix + Environment.NewLine + "```" + Environment.NewLine + Environment.NewLine +
                    "Suffix after caret:" + Environment.NewLine + "```" + GuessLanguage(context.FilePath) + Environment.NewLine + context.Suffix + Environment.NewLine + "```";

                string completion;
                try
                {
                    completion = await GenerateEditorTextAsync("You are an inline code completion engine. Output only insertable code text.", prompt);
                }
                catch (Exception ex)
                {
                    ShowInfo(ex.Message);
                    return;
                }

                completion = ExtractCode(completion);
                if (string.IsNullOrWhiteSpace(completion)) return;

                await package.JoinableTaskFactory.SwitchToMainThreadAsync(package.DisposalToken);
                context.Selection.Insert(completion, (int)vsInsertFlags.vsInsertFlagsInsertAtEnd);
            }).FileAndForget("JuniorStudio/InlineCompletionCommand");
        }

        private void AcceptGhostText()
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            JuniorGhostTextController.ActiveController?.AcceptSuggestion();
        }

        private async System.Threading.Tasks.Task<string> GenerateEditorTextAsync(string systemPrompt, string prompt)
        {
            await package.JoinableTaskFactory.SwitchToMainThreadAsync(package.DisposalToken);
            var options = JuniorStudioPackage.Instance?.GetJuniorOptions();
            var deployment = options?.ActiveDeployment;
            if (options == null || string.IsNullOrWhiteSpace(deployment) || string.Equals(deployment, "junior-active", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Junior is not configured yet. Open Tools > Options > Junior and set the provider and active deployment.");

            return await JuniorEditorGenerationService.GenerateAsync(systemPrompt, prompt, package.DisposalToken).ConfigureAwait(false);
        }

        private void OpenDiff(EditorSelection selection, string proposed)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            var dir = Path.Combine(Path.GetTempPath(), "JuniorStudio", "Diffs");
            Directory.CreateDirectory(dir);
            var extension = Path.GetExtension(selection.FilePath);
            if (string.IsNullOrEmpty(extension)) extension = ".txt";
            var stamp = DateTime.UtcNow.ToString("yyyyMMddHHmmssfff");
            var originalPath = Path.Combine(dir, "original-" + stamp + extension);
            var proposedPath = Path.Combine(dir, "junior-proposed-" + stamp + extension);
            File.WriteAllText(originalPath, selection.SelectedText, System.Text.Encoding.UTF8);
            File.WriteAllText(proposedPath, proposed, System.Text.Encoding.UTF8);

            var dte = Package.GetGlobalService(typeof(DTE)) as DTE;
            dte?.ExecuteCommand("Tools.DiffFiles", Quote(originalPath) + " " + Quote(proposedPath));
        }

        private void ShowInfo(string message)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            VsShellUtilities.ShowMessageBox(
                package,
                message,
                "Junior",
                Microsoft.VisualStudio.Shell.Interop.OLEMSGICON.OLEMSGICON_INFO,
                Microsoft.VisualStudio.Shell.Interop.OLEMSGBUTTON.OLEMSGBUTTON_OK,
                Microsoft.VisualStudio.Shell.Interop.OLEMSGDEFBUTTON.OLEMSGDEFBUTTON_FIRST);
        }

        private static string BuildPrompt(string instruction, EditorSelection selection)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            var language = GuessLanguage(selection.FilePath);
            var prompt = instruction + Environment.NewLine + Environment.NewLine;
            if (!string.IsNullOrWhiteSpace(selection.FilePath))
            {
                prompt += "File: " + selection.FilePath + Environment.NewLine;
            }
            if (selection.StartLine > 0 && selection.EndLine > 0)
            {
                prompt += "Selection: lines " + selection.StartLine + "-" + selection.EndLine + Environment.NewLine;
            }
            prompt += Environment.NewLine + "```" + language + Environment.NewLine + selection.SelectedText + Environment.NewLine + "```";
            return prompt;
        }

        private static bool TryGetEditorSelection(out EditorSelection selection)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            selection = null;
            try
            {
                var dte = Package.GetGlobalService(typeof(DTE)) as DTE;
                var document = dte?.ActiveDocument;
                var textSelection = document?.Selection as TextSelection;
                if (textSelection == null) return false;

                var selectedText = textSelection.Text;
                if (string.IsNullOrWhiteSpace(selectedText)) return false;

                var start = textSelection.TopPoint;
                var end = textSelection.BottomPoint;
                selection = new EditorSelection
                {
                    FilePath = document.FullName ?? string.Empty,
                    SelectedText = selectedText,
                    StartLine = start?.Line ?? 0,
                    EndLine = end?.Line ?? 0
                };
                return true;
            }
            catch
            {
                return false;
            }
        }

        private static bool TryGetEditorContext(out EditorContext context)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            context = null;
            try
            {
                var dte = Package.GetGlobalService(typeof(DTE)) as DTE;
                var document = dte?.ActiveDocument;
                var textDocument = document?.Object("TextDocument") as TextDocument;
                var textSelection = document?.Selection as TextSelection;
                if (textDocument == null || textSelection == null) return false;

                var start = textDocument.StartPoint.CreateEditPoint();
                var text = start.GetText(textDocument.EndPoint);
                var offset = Math.Max(0, (textSelection.ActivePoint?.AbsoluteCharOffset ?? 1) - 1);
                if (offset > text.Length) offset = text.Length;
                const int maxContext = 5000;
                var prefixStart = Math.Max(0, offset - maxContext);
                var suffixLength = Math.Min(maxContext, text.Length - offset);
                context = new EditorContext
                {
                    FilePath = document.FullName ?? string.Empty,
                    Prefix = text.Substring(prefixStart, offset - prefixStart),
                    Suffix = text.Substring(offset, suffixLength),
                    Selection = textSelection
                };
                return true;
            }
            catch
            {
                return false;
            }
        }

        private static string ExtractCode(string text)
        {
            if (string.IsNullOrWhiteSpace(text)) return string.Empty;
            var trimmed = text.Trim();
            if (!trimmed.StartsWith("```", StringComparison.Ordinal)) return trimmed;
            var firstLineEnd = trimmed.IndexOf('\n');
            if (firstLineEnd < 0) return trimmed.Trim('`').Trim();
            var endFence = trimmed.LastIndexOf("```", StringComparison.Ordinal);
            if (endFence <= firstLineEnd) return trimmed.Substring(firstLineEnd + 1).Trim();
            return trimmed.Substring(firstLineEnd + 1, endFence - firstLineEnd - 1).Trim('\r', '\n');
        }

        private static string Quote(string path)
        {
            return "\"" + (path ?? string.Empty).Replace("\"", "\\\"") + "\"";
        }

        private static string GuessLanguage(string filePath)
        {
            var ext = Path.GetExtension(filePath ?? string.Empty).TrimStart('.').ToLowerInvariant();
            switch (ext)
            {
                case "cs": return "csharp";
                case "vb": return "vbnet";
                case "fs": return "fsharp";
                case "js": return "javascript";
                case "ts": return "typescript";
                case "tsx": return "tsx";
                case "jsx": return "jsx";
                case "py": return "python";
                case "json": return "json";
                case "jsonc": return "jsonc";
                case "xml": return "xml";
                case "xaml": return "xml";
                case "html": return "html";
                case "css": return "css";
                case "sql": return "sql";
                case "ps1": return "powershell";
                case "md": return "markdown";
                default: return ext.Length > 0 ? ext : string.Empty;
            }
        }

        private sealed class EditorSelection
        {
            public string FilePath { get; set; }
            public string SelectedText { get; set; }
            public int StartLine { get; set; }
            public int EndLine { get; set; }
        }

        private sealed class EditorContext
        {
            public string FilePath { get; set; }
            public string Prefix { get; set; }
            public string Suffix { get; set; }
            public TextSelection Selection { get; set; }
        }
    }
}
