using System;
using System.Threading;
using System.Threading.Tasks;
using JuniorStudio.VisualStudio.Options;
using JuniorStudio.VisualStudio.ToolWindows;
using Microsoft.VisualStudio.Shell;

namespace JuniorStudio.VisualStudio.Services
{
    internal static class JuniorEditorGenerationService
    {
        private static readonly JuniorAgentSidecar Sidecar = JuniorSidecarService.Shared;
        private static readonly SemaphoreSlim Gate = new SemaphoreSlim(1, 1);

        public static async Task<string> GenerateAsync(string systemPrompt, string prompt, CancellationToken cancellationToken)
        {
            return await GenerateAsync(systemPrompt, prompt, requireWarmSidecar: false, cancellationToken: cancellationToken).ConfigureAwait(false);
        }

        public static async Task<string> GenerateGhostSuggestionAsync(string systemPrompt, string prompt, CancellationToken cancellationToken)
        {
            return await GenerateAsync(systemPrompt, prompt, requireWarmSidecar: true, cancellationToken: cancellationToken).ConfigureAwait(false);
        }

        private static async Task<string> GenerateAsync(string systemPrompt, string prompt, bool requireWarmSidecar, CancellationToken cancellationToken)
        {
            JuniorOptionsPage options = null;
            string deployment = null;
            string workspaceRoot = null;

            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync(cancellationToken);
            options = JuniorStudioPackage.Instance?.GetJuniorOptions();
            deployment = options?.ActiveDeployment;
            workspaceRoot = JuniorChatToolWindowControl.GetWorkspaceRoot();

            if (options == null || string.IsNullOrWhiteSpace(deployment) || string.Equals(deployment, "junior-active", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Junior is not configured yet. Open Tools > Options > Junior and set the provider and active deployment.");

            if (requireWarmSidecar && (!Sidecar.IsConfigured || (options.AuthMode == JuniorAuthMode.EntraId && !Sidecar.IsAuthSignedIn)))
                return string.Empty;

            await Gate.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                return await Sidecar.GenerateTextAsync(options, deployment, workspaceRoot, systemPrompt, prompt, cancellationToken, allowInteractiveAuth: !requireWarmSidecar).ConfigureAwait(false);
            }
            finally
            {
                Gate.Release();
            }
        }
    }
}
