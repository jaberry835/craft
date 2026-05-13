using System;
using System.Diagnostics.CodeAnalysis;
using System.IO;
using System.Reflection;
using System.Windows;
using System.Windows.Controls;
using JuniorStudio.VisualStudio.Services;
using JuniorStudio.VisualStudio.WebView;
using Microsoft.VisualStudio;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Shell.Interop;
using Microsoft.Web.WebView2.Core;

namespace JuniorStudio.VisualStudio.ToolWindows
{
    public partial class JuniorChatToolWindowControl : UserControl, IVsSolutionEvents
    {
        private readonly JuniorWebViewBridge bridge = new JuniorWebViewBridge();
        private bool initialized;
        private IVsSolution solutionService;
        private uint solutionEventsCookie;

        public JuniorChatToolWindowControl()
        {
            InitializeComponent();
            bridge.SidecarMessage += OnSidecarMessage;
            bridge.SidecarFailed += OnSidecarFailed;
            Unloaded += OnUnloaded;
        }

        [SuppressMessage("Usage", "VSTHRD100:Avoid async void methods", Justification = "WPF event handler; exceptions are handled inside the method.")]
        private async void OnLoaded(object sender, RoutedEventArgs e)
        {
            if (initialized)
            {
                return;
            }

            initialized = true;
            try
            {
                bridge.OptionsProvider = () => JuniorStudioPackage.Instance?.GetJuniorOptions();
                bridge.WorkspaceRootProvider = GetWorkspaceRoot;

                var userDataFolder = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "JuniorStudio",
                    "WebView2");
                Directory.CreateDirectory(userDataFolder);

                var env = await CoreWebView2Environment.CreateAsync(null, userDataFolder, null);
                await ChatWebView.EnsureCoreWebView2Async(env);

                var assetRoot = Path.Combine(
                    Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location),
                    "Assets");
                ChatWebView.CoreWebView2.SetVirtualHostNameToFolderMapping(
                    "junior.local",
                    assetRoot,
                    CoreWebView2HostResourceAccessKind.Allow);

                ChatWebView.CoreWebView2.WebMessageReceived += OnWebMessageReceived;
                ChatWebView.NavigationCompleted += OnNavigationCompleted;
                ChatWebView.NavigateToString(JuniorChatHtmlBuilder.Build());

                // Listen for solution/folder open/close so we can re-announce the workspace.
                try
                {
                    solutionService = Package.GetGlobalService(typeof(SVsSolution)) as IVsSolution;
                    solutionService?.AdviseSolutionEvents(this, out solutionEventsCookie);
                }
                catch { }
            }
            catch (Exception ex)
            {
                MessageBox.Show(ex.Message, "Junior Studio WebView initialization failed", MessageBoxButton.OK, MessageBoxImage.Error);
            }
        }

        private void OnNavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs e)
        {
            foreach (var message in bridge.GetStartupMessages())
            {
                ChatWebView.CoreWebView2.PostWebMessageAsJson(message);
            }
        }

        private void OnWebMessageReceived(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            try
            {
                foreach (var message in bridge.HandleWebMessage(e.WebMessageAsJson))
                {
                    PostToWebView(message);
                }
            }
            catch (Exception ex)
            {
                PostToWebView(bridge.CreateErrorMessage(ex.Message));
            }
        }

        private void OnSidecarMessage(string jsonLine)
        {
            // Intercept openWorkspaceFolder so VS opens the new folder. Don't forward to WebView.
            if (!string.IsNullOrEmpty(jsonLine) && jsonLine.IndexOf("\"openWorkspaceFolder\"", StringComparison.Ordinal) >= 0)
            {
                Dispatcher.BeginInvoke(new Action(() => HandleOpenWorkspaceFolder(jsonLine)));
                return;
            }
            Dispatcher.BeginInvoke(new Action(() => PostToWebView(jsonLine)));
        }

        private void HandleOpenWorkspaceFolder(string jsonLine)
        {
            try
            {
                ThreadHelper.ThrowIfNotOnUIThread();
                // crude path extraction: "path":"..."
                var marker = "\"path\"";
                var idx = jsonLine.IndexOf(marker, StringComparison.Ordinal);
                if (idx < 0) return;
                var colon = jsonLine.IndexOf(':', idx);
                var q1 = jsonLine.IndexOf('"', colon + 1);
                var q2 = jsonLine.IndexOf('"', q1 + 1);
                while (q2 > 0 && jsonLine[q2 - 1] == '\\') q2 = jsonLine.IndexOf('"', q2 + 1);
                if (q1 < 0 || q2 < 0) return;
                var path = jsonLine.Substring(q1 + 1, q2 - q1 - 1).Replace("\\\\", "\\");
                if (!Directory.Exists(path)) return;
                var solution7 = Package.GetGlobalService(typeof(SVsSolution)) as IVsSolution7;
                solution7?.OpenFolder(path);
            }
            catch { }
        }

        private void OnSidecarFailed(string message)
        {
            Dispatcher.BeginInvoke(new Action(() => PostToWebView(bridge.CreateErrorMessage(message))));
        }

        private void PostToWebView(string json)
        {
            try
            {
                var core = ChatWebView != null ? ChatWebView.CoreWebView2 : null;
                if (core == null) return;
                core.PostWebMessageAsJson(json);
            }
            catch
            {
            }
        }

        private void OnUnloaded(object sender, RoutedEventArgs e)
        {
            try
            {
                if (solutionService != null && solutionEventsCookie != 0)
                {
                    ThreadHelper.ThrowIfNotOnUIThread();
                    solutionService.UnadviseSolutionEvents(solutionEventsCookie);
                    solutionEventsCookie = 0;
                }
            }
            catch { }
            try
            {
                bridge.SidecarMessage -= OnSidecarMessage;
                bridge.SidecarFailed -= OnSidecarFailed;
                bridge.Dispose();
            }
            catch
            {
            }
        }

        private void RepostWorkspaceBanner()
        {
            Dispatcher.BeginInvoke(new Action(() =>
            {
                foreach (var m in bridge.BuildWorkspaceBannerMessages())
                    PostToWebView(m);
            }));
        }

        int IVsSolutionEvents.OnAfterOpenProject(IVsHierarchy pHierarchy, int fAdded) { RepostWorkspaceBanner(); return VSConstants.S_OK; }
        int IVsSolutionEvents.OnQueryCloseProject(IVsHierarchy pHierarchy, int fRemoving, ref int pfCancel) => VSConstants.S_OK;
        int IVsSolutionEvents.OnBeforeCloseProject(IVsHierarchy pHierarchy, int fRemoved) => VSConstants.S_OK;
        int IVsSolutionEvents.OnAfterLoadProject(IVsHierarchy pStubHierarchy, IVsHierarchy pRealHierarchy) => VSConstants.S_OK;
        int IVsSolutionEvents.OnQueryUnloadProject(IVsHierarchy pRealHierarchy, ref int pfCancel) => VSConstants.S_OK;
        int IVsSolutionEvents.OnBeforeUnloadProject(IVsHierarchy pRealHierarchy, IVsHierarchy pStubHierarchy) => VSConstants.S_OK;
        int IVsSolutionEvents.OnAfterOpenSolution(object pUnkReserved, int fNewSolution) { RepostWorkspaceBanner(); return VSConstants.S_OK; }
        int IVsSolutionEvents.OnQueryCloseSolution(object pUnkReserved, ref int pfCancel) => VSConstants.S_OK;
        int IVsSolutionEvents.OnBeforeCloseSolution(object pUnkReserved) => VSConstants.S_OK;
        int IVsSolutionEvents.OnAfterCloseSolution(object pUnkReserved) { RepostWorkspaceBanner(); return VSConstants.S_OK; }

        private static string GetWorkspaceRoot()
        {
            try
            {
                Microsoft.VisualStudio.Shell.ThreadHelper.ThrowIfNotOnUIThread();

                // Works for both .sln solutions and Open Folder mode.
                var vsSolution = Microsoft.VisualStudio.Shell.Package.GetGlobalService(
                    typeof(Microsoft.VisualStudio.Shell.Interop.SVsSolution))
                    as Microsoft.VisualStudio.Shell.Interop.IVsSolution;
                if (vsSolution != null &&
                    vsSolution.GetSolutionInfo(out var solutionDir, out var solutionFile, out _) == 0)
                {
                    if (!string.IsNullOrEmpty(solutionDir) && Directory.Exists(solutionDir))
                    {
                        return solutionDir.TrimEnd('\\', '/');
                    }
                    if (!string.IsNullOrEmpty(solutionFile))
                    {
                        var dir = Path.GetDirectoryName(solutionFile);
                        if (!string.IsNullOrEmpty(dir) && Directory.Exists(dir))
                            return dir;
                    }
                }

                var dte = Microsoft.VisualStudio.Shell.Package.GetGlobalService(typeof(EnvDTE.DTE)) as EnvDTE.DTE;
                var slnFile = dte?.Solution?.FullName;
                if (!string.IsNullOrEmpty(slnFile) && File.Exists(slnFile))
                {
                    return Path.GetDirectoryName(slnFile);
                }
            }
            catch
            {
            }
            return null;
        }
    }
}
