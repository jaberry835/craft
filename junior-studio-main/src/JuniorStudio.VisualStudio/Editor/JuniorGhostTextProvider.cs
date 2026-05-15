using System;
using System.ComponentModel.Composition;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using EnvDTE;
using JuniorStudio.VisualStudio.Services;
using Microsoft.VisualStudio;
using Microsoft.VisualStudio.Editor;
using Microsoft.VisualStudio.OLE.Interop;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Text;
using Microsoft.VisualStudio.Text.Editor;
using Microsoft.VisualStudio.Text.Formatting;
using Microsoft.VisualStudio.TextManager.Interop;
using Microsoft.VisualStudio.Utilities;

namespace JuniorStudio.VisualStudio.Editor
{
    internal sealed class JuniorGhostTextAdornmentLayer
    {
        public const string LayerName = "JuniorGhostText";

        [Export(typeof(AdornmentLayerDefinition))]
        [Name(LayerName)]
        [Order(After = PredefinedAdornmentLayers.Caret)]
#pragma warning disable 0649
        public AdornmentLayerDefinition Definition;
#pragma warning restore 0649
    }

    [Export(typeof(IWpfTextViewCreationListener))]
    [ContentType("text")]
    [TextViewRole(PredefinedTextViewRoles.Editable)]
    internal sealed class JuniorGhostTextProvider : IWpfTextViewCreationListener
    {
        [Import]
        internal IVsEditorAdaptersFactoryService EditorAdaptersFactoryService { get; set; }

        public void TextViewCreated(IWpfTextView textView)
        {
            if (textView == null) return;
            if (!textView.Properties.ContainsProperty(typeof(JuniorGhostTextController)))
            {
                var viewAdapter = EditorAdaptersFactoryService?.GetViewAdapter(textView);
                textView.Properties.AddProperty(typeof(JuniorGhostTextController), new JuniorGhostTextController(textView, viewAdapter));
            }
        }
    }

    internal sealed class JuniorGhostTextController : IDisposable
    {
        private const int MaxContextChars = 5000;
        private const int DebounceMs = 900;
        private readonly IWpfTextView textView;
        private readonly IAdornmentLayer layer;
        private readonly JuniorGhostTextCommandFilter commandFilter;
        private CancellationTokenSource debounceCts;
        private int requestInFlight;
        private SnapshotPoint? suggestionPoint;
        private string suggestionText;
        private bool disposed;

        public static JuniorGhostTextController ActiveController { get; private set; }

        public JuniorGhostTextController(IWpfTextView textView, IVsTextView viewAdapter)
        {
            this.textView = textView;
            layer = textView.GetAdornmentLayer(JuniorGhostTextAdornmentLayer.LayerName);
            commandFilter = new JuniorGhostTextCommandFilter(this);
            if (viewAdapter != null)
            {
                viewAdapter.AddCommandFilter(commandFilter, out var nextCommandTarget);
                commandFilter.Next = nextCommandTarget;
            }
            textView.Caret.PositionChanged += OnCaretPositionChanged;
            textView.TextBuffer.Changed += OnTextBufferChanged;
            textView.LayoutChanged += OnLayoutChanged;
            textView.Closed += OnClosed;
            textView.VisualElement.GotKeyboardFocus += OnGotKeyboardFocus;
            textView.VisualElement.GotFocus += OnGotKeyboardFocus;
        }

        public bool HasSuggestion
        {
            get { return !string.IsNullOrWhiteSpace(suggestionText) && suggestionPoint.HasValue; }
        }

        public void AcceptSuggestion()
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            if (!HasSuggestion) return;
            var point = suggestionPoint.Value;
            var text = suggestionText;
            ClearSuggestion();
            using (var edit = textView.TextBuffer.CreateEdit())
            {
                edit.Insert(point.Position, text);
                edit.Apply();
            }
            var newPoint = new SnapshotPoint(textView.TextBuffer.CurrentSnapshot, Math.Min(point.Position + text.Length, textView.TextBuffer.CurrentSnapshot.Length));
            textView.Caret.MoveTo(newPoint);
        }

        public void DismissSuggestion()
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            ClearSuggestion();
        }

        private void OnGotKeyboardFocus(object sender, RoutedEventArgs e)
        {
            ActiveController = this;
        }

        private void OnCaretPositionChanged(object sender, CaretPositionChangedEventArgs e)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            ActiveController = this;
            ClearSuggestion();
            ScheduleSuggestion();
        }

        private void OnTextBufferChanged(object sender, TextContentChangedEventArgs e)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            ClearSuggestion();
            ScheduleSuggestion();
        }

        private void OnLayoutChanged(object sender, TextViewLayoutChangedEventArgs e)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            RenderSuggestion();
        }

        private void OnClosed(object sender, EventArgs e)
        {
            Dispose();
        }

        private void ScheduleSuggestion()
        {
            if (disposed) return;
            debounceCts?.Cancel();
            debounceCts?.Dispose();
            debounceCts = new CancellationTokenSource();
            var token = debounceCts.Token;

            _ = Task.Run(async () =>
            {
                try
                {
                    await Task.Delay(DebounceMs, token).ConfigureAwait(false);
                    await RequestSuggestionAsync(token).ConfigureAwait(false);
                }
                catch (OperationCanceledException) { }
                catch { }
            }, token);
        }

        private async Task RequestSuggestionAsync(CancellationToken token)
        {
            if (Interlocked.Exchange(ref requestInFlight, 1) == 1) return;
            try
            {
                await RequestSuggestionCoreAsync(token).ConfigureAwait(false);
            }
            finally
            {
                Interlocked.Exchange(ref requestInFlight, 0);
            }
        }

        private async Task RequestSuggestionCoreAsync(CancellationToken token)
        {
            EditorContext context = null;
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync(token);
            if (!TryBuildContext(out context)) return;
            var requestSnapshot = textView.TextBuffer.CurrentSnapshot;
            var requestPoint = textView.Caret.Position.BufferPosition;
            var language = GuessLanguage(context.FilePath);
            var prompt = "Complete the code at the caret. Return only text to insert at the caret. Do not include markdown fences, explanations, or repeated prefix text. Prefer a short, high-confidence completion." + Environment.NewLine + Environment.NewLine +
                "File: " + context.FilePath + Environment.NewLine +
                "Language: " + language + Environment.NewLine + Environment.NewLine +
                "Prefix before caret:" + Environment.NewLine + "```" + language + Environment.NewLine + context.Prefix + Environment.NewLine + "```" + Environment.NewLine + Environment.NewLine +
                "Suffix after caret:" + Environment.NewLine + "```" + language + Environment.NewLine + context.Suffix + Environment.NewLine + "```";

            var generated = await JuniorEditorGenerationService.GenerateGhostSuggestionAsync("You are a low-latency inline completion engine. Output only insertable code text.", prompt, token).ConfigureAwait(false);
            generated = ExtractCode(generated);
            if (string.IsNullOrWhiteSpace(generated)) return;
            generated = TrimUnsafeCompletion(generated);
            if (string.IsNullOrWhiteSpace(generated)) return;

            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync(token);
            if (textView.IsClosed || textView.TextBuffer.CurrentSnapshot != requestSnapshot) return;
            if (textView.Caret.Position.BufferPosition != requestPoint) return;
            suggestionPoint = requestPoint;
            suggestionText = generated;
            RenderSuggestion();
        }

        private bool TryBuildContext(out EditorContext context)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            context = null;
            try
            {
                var snapshot = textView.TextBuffer.CurrentSnapshot;
                var caret = textView.Caret.Position.BufferPosition;
                if (caret.Snapshot != snapshot) caret = caret.TranslateTo(snapshot, PointTrackingMode.Positive);
                if (snapshot.Length == 0) return false;

                var line = caret.GetContainingLine();
                var linePrefix = snapshot.GetText(line.Start.Position, caret.Position - line.Start.Position);
                if (string.IsNullOrWhiteSpace(linePrefix)) return false;
                if (!LooksLikeCompletionTrigger(linePrefix)) return false;

                var prefixStart = Math.Max(0, caret.Position - MaxContextChars);
                var suffixLength = Math.Min(MaxContextChars, snapshot.Length - caret.Position);
                context = new EditorContext
                {
                    FilePath = GetActiveFilePath(),
                    Prefix = snapshot.GetText(prefixStart, caret.Position - prefixStart),
                    Suffix = snapshot.GetText(caret.Position, suffixLength)
                };
                return true;
            }
            catch
            {
                return false;
            }
        }

        private void RenderSuggestion()
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            layer.RemoveAllAdornments();
            if (!HasSuggestion || textView.IsClosed) return;

            var point = suggestionPoint.Value;
            if (point.Snapshot != textView.TextBuffer.CurrentSnapshot)
                point = point.TranslateTo(textView.TextBuffer.CurrentSnapshot, PointTrackingMode.Positive);
            if (!textView.TextViewLines.FormattedSpan.Contains(point)) return;

            IWpfTextViewLine line;
            try
            {
                line = textView.GetTextViewLineContainingBufferPosition(point);
            }
            catch
            {
                return;
            }

            var bounds = line.GetExtendedCharacterBounds(point);
            var textBlock = new TextBlock
            {
                Text = FirstVisualLine(suggestionText),
                FontFamily = textView.FormattedLineSource.DefaultTextProperties.Typeface.FontFamily,
                FontSize = textView.FormattedLineSource.DefaultTextProperties.FontRenderingEmSize,
                FontWeight = FontWeights.SemiBold,
                Foreground = new SolidColorBrush(Color.FromArgb(230, 170, 170, 170)),
                Opacity = 0.95,
                IsHitTestVisible = false
            };

            Canvas.SetLeft(textBlock, bounds.Right + 1.0);
            Canvas.SetTop(textBlock, line.TextTop);
            layer.AddAdornment(AdornmentPositioningBehavior.TextRelative, new SnapshotSpan(point, 0), this, textBlock, null);
        }

        private void ClearSuggestion()
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            suggestionPoint = null;
            suggestionText = null;
            layer.RemoveAllAdornments();
        }

        private static bool LooksLikeCompletionTrigger(string linePrefix)
        {
            if (string.IsNullOrEmpty(linePrefix)) return false;
            var last = linePrefix[linePrefix.Length - 1];
            if (char.IsLetterOrDigit(last) || last == '_' || last == '.' || last == ')' || last == ']' || last == '}' || last == '"' || last == '\'') return true;
            return false;
        }

        private static string FirstVisualLine(string text)
        {
            if (string.IsNullOrEmpty(text)) return string.Empty;
            var normalized = text.Replace("\r\n", "\n").Replace('\r', '\n');
            var newline = normalized.IndexOf('\n');
            return newline >= 0 ? normalized.Substring(0, newline) : normalized;
        }

        private static string TrimUnsafeCompletion(string text)
        {
            if (string.IsNullOrWhiteSpace(text)) return string.Empty;
            var trimmed = text.TrimEnd();
            if (trimmed.Length > 500) trimmed = trimmed.Substring(0, 500);
            return trimmed;
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

        private static string GetActiveFilePath()
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            try
            {
                var dte = Package.GetGlobalService(typeof(DTE)) as DTE;
                return dte?.ActiveDocument?.FullName ?? string.Empty;
            }
            catch
            {
                return string.Empty;
            }
        }

        public void Dispose()
        {
            if (disposed) return;
            disposed = true;
            debounceCts?.Cancel();
            debounceCts?.Dispose();
            textView.Caret.PositionChanged -= OnCaretPositionChanged;
            textView.TextBuffer.Changed -= OnTextBufferChanged;
            textView.LayoutChanged -= OnLayoutChanged;
            textView.Closed -= OnClosed;
            textView.VisualElement.GotKeyboardFocus -= OnGotKeyboardFocus;
            textView.VisualElement.GotFocus -= OnGotKeyboardFocus;
            layer.RemoveAllAdornments();
            if (ActiveController == this) ActiveController = null;
        }

        private sealed class JuniorGhostTextCommandFilter : IOleCommandTarget
        {
            private readonly JuniorGhostTextController controller;

            public JuniorGhostTextCommandFilter(JuniorGhostTextController controller)
            {
                this.controller = controller;
            }

            public IOleCommandTarget Next { get; set; }

            public int QueryStatus(ref Guid pguidCmdGroup, uint cCmds, OLECMD[] prgCmds, IntPtr pCmdText)
            {
                ThreadHelper.ThrowIfNotOnUIThread();
                if (cCmds > 0 && prgCmds != null && prgCmds.Length > 0 && IsHandledCommand(pguidCmdGroup, prgCmds[0].cmdID) && controller.HasSuggestion)
                {
                    prgCmds[0].cmdf = (uint)(OLECMDF.OLECMDF_SUPPORTED | OLECMDF.OLECMDF_ENABLED);
                    return VSConstants.S_OK;
                }

                return Next != null ? Next.QueryStatus(ref pguidCmdGroup, cCmds, prgCmds, pCmdText) : (int)Microsoft.VisualStudio.OLE.Interop.Constants.OLECMDERR_E_NOTSUPPORTED;
            }

            public int Exec(ref Guid pguidCmdGroup, uint nCmdID, uint nCmdexecopt, IntPtr pvaIn, IntPtr pvaOut)
            {
                ThreadHelper.ThrowIfNotOnUIThread();
                if (IsAcceptCommand(pguidCmdGroup, nCmdID) && controller.HasSuggestion)
                {
                    controller.AcceptSuggestion();
                    return VSConstants.S_OK;
                }

                if (IsDismissCommand(pguidCmdGroup, nCmdID) && controller.HasSuggestion)
                {
                    controller.DismissSuggestion();
                    return VSConstants.S_OK;
                }

                return Next != null ? Next.Exec(ref pguidCmdGroup, nCmdID, nCmdexecopt, pvaIn, pvaOut) : (int)Microsoft.VisualStudio.OLE.Interop.Constants.OLECMDERR_E_NOTSUPPORTED;
            }

            private static bool IsHandledCommand(Guid commandGroup, uint commandId)
            {
                return IsAcceptCommand(commandGroup, commandId) || IsDismissCommand(commandGroup, commandId);
            }

            private static bool IsAcceptCommand(Guid commandGroup, uint commandId)
            {
                if (commandGroup != VSConstants.VSStd2K) return false;
                return commandId == (uint)VSConstants.VSStd2KCmdID.TAB
                    || commandId == (uint)VSConstants.VSStd2KCmdID.RIGHT;
            }

            private static bool IsDismissCommand(Guid commandGroup, uint commandId)
            {
                return commandGroup == VSConstants.VSStd2K && commandId == (uint)VSConstants.VSStd2KCmdID.CANCEL;
            }
        }

        private sealed class EditorContext
        {
            public string FilePath { get; set; }
            public string Prefix { get; set; }
            public string Suffix { get; set; }
        }
    }
}
