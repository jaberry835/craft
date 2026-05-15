using System.ComponentModel;
using System.ComponentModel.Design;
using System.Drawing.Design;
using Microsoft.VisualStudio.Shell;

namespace JuniorStudio.VisualStudio.Options
{
    public sealed class JuniorOptionsPage : DialogPage
    {
        [Category("Provider")]
        [DisplayName("Provider")]
        [Description("Connection mode for Junior. Use Direct for Azure OpenAI / Foundry, APIM for API Management in front of Foundry, or OpenAI Compatible for an OpenAI-compatible endpoint.")]
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
        [Description("Azure OpenAI key or APIM subscription key. Used when Authentication Mode is API Key. Prefer setting this from Junior Chat so only a cred: reference is stored in VS settings.")]
        public string ApiKey { get; set; } = string.Empty;

        [Category("Authentication")]
        [DisplayName("Authentication Mode")]
        [Description("API Key uses the API Key field. Bearer Token sends the raw bearer token. Entra ID acquires a bearer token with Azure.Identity.")]
        [DefaultValue(JuniorAuthMode.ApiKey)]
        public JuniorAuthMode AuthMode { get; set; } = JuniorAuthMode.ApiKey;

        [Category("Authentication")]
        [DisplayName("Bearer Token")]
        [Description("Raw bearer token used when Authentication Mode is Bearer Token. Prefer Entra ID for interactive user authentication.")]
        public string BearerToken { get; set; } = string.Empty;

        [Category("Authentication")]
        [DisplayName("Entra ID Scopes")]
        [Description("Comma- or newline-separated scopes for Entra ID. For APIM, use the audience APIM validates, for example api://<app-client-id>/user_impersonation. VS Code-style VSCODE_CLIENT_ID and VSCODE_TENANT entries are also accepted.")]
        public string AuthScopes { get; set; } = string.Empty;

        [Category("Authentication")]
        [DisplayName("Entra Tenant ID")]
        [Description("Optional tenant ID for Entra ID authentication. Can also be supplied as VSCODE_TENANT:<tenant-id> in Entra ID Scopes.")]
        public string AuthTenantId { get; set; } = string.Empty;

        [Category("Authentication")]
        [DisplayName("Entra Client ID")]
        [Description("Optional public client app ID for interactive Entra ID authentication. Can also be supplied as VSCODE_CLIENT_ID:<client-id> in Entra ID Scopes.")]
        public string AuthClientId { get; set; } = string.Empty;

        [Category("Authentication")]
        [DisplayName("Azure Cloud")]
        [Description("Authority cloud for Entra ID authentication. Use Custom for sovereign or air-gapped clouds and set Authority Host.")]
        [DefaultValue(JuniorAzureCloud.Commercial)]
        public JuniorAzureCloud AzureCloud { get; set; } = JuniorAzureCloud.Commercial;

        [Category("Authentication")]
        [DisplayName("Authority Host")]
        [Description("Custom Entra authority host, for example https://login.microsoftonline.us/. Used when Azure Cloud is Custom.")]
        public string AuthorityHost { get; set; } = string.Empty;

        [Category("Authentication")]
        [DisplayName("Direct Azure OpenAI Audience")]
        [Description("Optional token audience for Direct + Entra ID. Leave blank to use the selected Azure Cloud default, or set a sovereign/custom audience such as https://cognitiveservices.azure.us/.default.")]
        public string DirectAudience { get; set; } = string.Empty;

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

        [Category("Agent Reliability")]
        [DisplayName("Automatic Repair Attempts")]
        [Description("Number of validation-failure repair turns Junior may start automatically before asking you to continue. Approval settings still apply. Range: 0-3.")]
        [DefaultValue(1)]
        public int AutomaticRepairAttempts { get; set; } = 1;

        [Category("MCP")]
        [DisplayName("Enable MCP Servers")]
        [Description("Connect configured Model Context Protocol servers and expose their tools in Agent mode.")]
        [DefaultValue(false)]
        public bool McpEnabled { get; set; } = false;

        [Category("MCP")]
        [DisplayName("MCP Servers JSON")]
        [Description("JSON object of MCP server configs. Supports stdio command/args/env/cwd and HTTP url/headers/authSession. authSession scopes may include VSCODE_TENANT:<id> and VSCODE_CLIENT_ID:<id>.")]
        [Editor(typeof(MultilineStringEditor), typeof(UITypeEditor))]
        public string McpServersJson { get; set; } = string.Empty;
    }

    public enum JuniorProvider
    {
        Direct,
        Apim,
        OpenAICompatible
    }

    public enum JuniorAuthMode
    {
        ApiKey,
        BearerToken,
        EntraId
    }

    public enum JuniorAzureCloud
    {
        Commercial,
        Government,
        China,
        Custom
    }

    public enum JuniorApproval
    {
        Auto,
        Confirm,
        Deny
    }
}