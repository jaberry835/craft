# Office Automation Development

- Keep REST and MCP adapters thin; implement behavior in shared services.
- Files are immutable. Every conversion or edit returns a new `file_id`.
- Never log document content, API keys, authorization headers, or signed tokens.
- Local functional tests use the local file store and explicit disabled auth.
- Production uses Entra ID and managed identity; credentials must not be committed.
- MCP SDK reference: https://py.sdk.modelcontextprotocol.io/
- MCP protocol reference: https://modelcontextprotocol.io/specification/latest
