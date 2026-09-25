import type { McpAuthSettings, McpAuthType } from './types/api';
import { maskedSecretValue } from './types/api';

const authOptions: Array<{ type: McpAuthType; label: string; hint: string }> = [
  { type: 'none', label: 'None', hint: 'The server needs no credentials, or they are set in mcp.json headers.' },
  { type: 'bearer', label: 'Bearer token', hint: 'Sends Authorization: Bearer <token>.' },
  { type: 'header', label: 'API key header', hint: 'Sends a custom header such as x-api-key.' },
  { type: 'oauth', label: 'OAuth client credentials', hint: 'Requests a token from a token endpoint and refreshes it before expiry.' },
  { type: 'entra', label: 'Microsoft Entra', hint: 'Uses DefaultAzureCredential (managed identity, environment, or Azure CLI sign-in).' }
];

type Field = keyof Omit<McpAuthSettings, 'type'>;

const fieldsByType: Record<McpAuthType, Array<{ field: Field; label: string; placeholder: string; secret?: boolean; optional?: boolean }>> = {
  none: [],
  bearer: [{ field: 'token', label: 'Token', placeholder: '${env:MCP_TOKEN}', secret: true }],
  header: [
    { field: 'headerName', label: 'Header name', placeholder: 'x-api-key' },
    { field: 'value', label: 'Header value', placeholder: '${env:MCP_API_KEY}', secret: true }
  ],
  oauth: [
    { field: 'tokenUrl', label: 'Token URL', placeholder: 'https://login.example/oauth2/token' },
    { field: 'clientId', label: 'Client ID', placeholder: 'aaa-workbench' },
    { field: 'clientSecret', label: 'Client secret', placeholder: '${env:MCP_CLIENT_SECRET}', secret: true },
    { field: 'scope', label: 'Scope', placeholder: 'mcp.read mcp.write', optional: true },
    { field: 'audience', label: 'Audience', placeholder: 'https://mcp.example', optional: true }
  ],
  entra: [
    { field: 'scope', label: 'Scope', placeholder: 'api://my-mcp-server/.default' },
    { field: 'managedIdentityClientId', label: 'Managed identity client ID', placeholder: 'User-assigned identity (optional)', optional: true },
    { field: 'tenantId', label: 'Tenant ID', placeholder: 'Optional', optional: true },
    { field: 'authorityHost', label: 'Authority host', placeholder: 'https://login.microsoftonline.us (sovereign clouds)', optional: true }
  ]
};

/** Authentication settings for an HTTP MCP server in the customization editor. */
export function McpAuthFields({ auth, onChange }: { auth: McpAuthSettings; onChange: (auth: McpAuthSettings) => void }) {
  const selected = authOptions.find((option) => option.type === auth.type) ?? authOptions[0]!;
  return (
    <fieldset className="mcp-auth">
      <legend>Authentication</legend>
      <label>
        Method
        <select value={auth.type} onChange={(event) => onChange({ type: event.target.value as McpAuthType })}>
          {authOptions.map((option) => <option key={option.type} value={option.type}>{option.label}</option>)}
        </select>
        <small>{selected.hint}</small>
      </label>
      {fieldsByType[auth.type].map(({ field, label, placeholder, secret, optional }) => (
        <label key={field}>
          {label}{optional ? ' (optional)' : ''}
          <input
            required={!optional}
            value={auth[field] ?? ''}
            placeholder={placeholder}
            autoComplete="off"
            spellCheck={false}
            onFocus={(event) => {
              if (secret && event.target.value === maskedSecretValue) event.target.select();
            }}
            onChange={(event) => onChange({ ...auth, [field]: event.target.value })}
          />
          {secret && (
            <small>
              {auth[field] === maskedSecretValue
                ? 'A stored value is kept unless you replace it.'
                : 'Use ${env:NAME} so the secret stays in .env instead of the project.'}
            </small>
          )}
        </label>
      ))}
    </fieldset>
  );
}
