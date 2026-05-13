using System;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.VisualStudio.Shell;
using JuniorStudio.VisualStudio.Commands;
using JuniorStudio.VisualStudio.Options;
using JuniorStudio.VisualStudio.ToolWindows;
using Task = System.Threading.Tasks.Task;

namespace JuniorStudio.VisualStudio
{
    [PackageRegistration(UseManagedResourcesOnly = true, AllowsBackgroundLoading = true)]
    [InstalledProductRegistration("Junior Studio", "Air-gapped AI coding assistant for Visual Studio", "0.1.7")]
    [ProvideMenuResource("Menus.ctmenu", 1)]
    [ProvideToolWindow(typeof(JuniorChatToolWindow))]
    [ProvideOptionPage(typeof(JuniorOptionsPage), "Junior Studio", "Provider", 0, 0, true)]
    [Guid(PackageGuidString)]
    public sealed class JuniorStudioPackage : AsyncPackage
    {
        public const string PackageGuidString = "c2c66f37-2bf9-4c64-9a87-a9eb3e937593";
        public static JuniorStudioPackage Instance { get; private set; }

        public JuniorOptionsPage GetJuniorOptions()
        {
            return (JuniorOptionsPage)GetDialogPage(typeof(JuniorOptionsPage));
        }

        protected override async Task InitializeAsync(CancellationToken cancellationToken, IProgress<ServiceProgressData> progress)
        {
            await JoinableTaskFactory.SwitchToMainThreadAsync(cancellationToken);
            Instance = this;
            await OpenJuniorChatCommand.InitializeAsync(this);
        }
    }
}