namespace JuniorStudio.VisualStudio.Services
{
    internal static class JuniorSidecarService
    {
        public static JuniorAgentSidecar Shared { get; } = new JuniorAgentSidecar();
    }
}
