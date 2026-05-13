using System.ComponentModel;
using Microsoft.VisualStudio.Shell;

namespace JuniorStudio.VisualStudio.Options
{
    public sealed class JuniorOptionsPage : DialogPage
    {
        [Category("Provider")]
        [DisplayName("Provider")]
        [Description("Connection mode for Junior Studio. Use Direct for Azure OpenAI / Foundry, APIM for API Management in front of Foundry, or OpenAI Compatible for an OpenAI-compatible endpoint.")]
        [DefaultValue(JuniorProvider.Direct)]
        public JuniorProvider Provider { get; set; } = JuniorProvider.Direct;

        [Category("Provider")]
        [DisplayName("Endpoint")]
        [Description("Azure OpenAI / Foundry endpoint used when Provider is Direct.")]
        public string Endpoint { get; set; } = string.Empty;

        [Category("Provider")]
        [DisplayName("APIM Base URL")]
        [Description("API Management gateway base URL used when Provider is APIM.")]
        public string ApimBaseUrl { get; set; } = string.Empty;

        [Category("Provider")]
        [DisplayName("OpenAI Compatible Base URL")]
        [Description("OpenAI-compatible base URL, for example an /openai/v1 or /v1 endpoint.")]
        public string OpenAICompatibleBaseUrl { get; set; } = string.Empty;

        [Category("Provider")]
        [DisplayName("API Key")]
        [Description("Azure OpenAI key, APIM subscription key (Ocp-Apim-Subscription-Key), or OpenAI-compatible bearer token. Stored in the VS user settings store.")]
        public string ApiKey { get; set; } = string.Empty;

        [Category("Models")]
        [DisplayName("Active Deployment")]
        [Description("Azure deployment ID or OpenAI-compatible model name to use for chat. Used as the default when no model is selected in the chat picker.")]
        public string ActiveDeployment { get; set; } = string.Empty;

        [Category("Models")]
        [DisplayName("Available Models")]
        [Description("Comma- or newline-separated list of deployment IDs / model names to show in the chat model picker. Example: gpt-5.4, gpt-4o, o4-mini")]
        public string AvailableModels { get; set; } = string.Empty;

        [Category("Models")]
        [DisplayName("API Version")]
        [Description("Azure OpenAI API version for classic chat-completions routes.")]
        [DefaultValue("2025-03-01-preview")]
        public string ApiVersion { get; set; } = "2025-03-01-preview";

        [Category("Approvals")]
        [DisplayName("Approval: Write/Create files")]
        [Description("Auto = run silently. Confirm = ask in chat before each write. Deny = block all writes.")]
        [DefaultValue(JuniorApproval.Confirm)]
        public JuniorApproval ApprovalWrite { get; set; } = JuniorApproval.Confirm;

        [Category("Approvals")]
        [DisplayName("Approval: Delete files")]
        [Description("Auto = run silently. Confirm = ask in chat before each delete. Deny = block all deletes.")]
        [DefaultValue(JuniorApproval.Confirm)]
        public JuniorApproval ApprovalDelete { get; set; } = JuniorApproval.Confirm;

        [Category("Approvals")]
        [DisplayName("Approval: Run shell commands")]
        [Description("Auto = run silently. Confirm = ask in chat before each command. Deny = block all shell commands.")]
        [DefaultValue(JuniorApproval.Confirm)]
        public JuniorApproval ApprovalShell { get; set; } = JuniorApproval.Confirm;
    }

    public enum JuniorProvider
    {
        Direct,
        Apim,
        OpenAICompatible
    }

    public enum JuniorApproval
    {
        Auto,
        Confirm,
        Deny
    }
}