# Office Automation Service

Deterministic `.docx` and `.xlsx` automation exposed through REST and MCP.

## Local development

```powershell
python -m venv .venv
.venv\Scripts\python -m pip install -e ".[dev,office]"
$env:OFFICE_AUTOMATION_AUTH_MODE = "disabled"
.venv\Scripts\uvicorn officeautomation.app:create_app --factory --reload
```

The service landing page is available at `http://127.0.0.1:8000/`. The REST API
is hosted at `http://127.0.0.1:8000/api/v1`, with interactive Swagger
documentation at `http://127.0.0.1:8000/api/v1/docs` and its OpenAPI schema at
`http://127.0.0.1:8000/api/v1/openapi.json`. The health endpoint is
`http://127.0.0.1:8000/healthz`.

The MCP server is hosted at `http://127.0.0.1:8000/mcp` using Streamable HTTP.
For VS Code, add the following to `.vscode/mcp.json`:

```json
{
  "servers": {
    "office-automation": {
      "type": "http",
      "url": "http://127.0.0.1:8000/mcp"
    }
  }
}
```

The landing page shows the deployment-specific MCP URL, this connection
configuration, all available MCP tools, and a link to Swagger.

Authentication is never implicitly disabled. Set `OFFICE_AUTOMATION_AUTH_MODE`
to `disabled` only for local functional testing. Development and test systems
can instead use `api_key`; production uses `entra`.

## Implemented local slice

- Immutable local file handles with single and chunked uploads, validation,
	owner isolation, expiry checks, and ranged downloads.
- Markdown to/from Word, Word inspection, placeholder/text replacement, and
	core properties.
- Markdown tables to/from Excel, workbook inspection, common cell/range/sheet
	operations, and formula-injection protection.
- The same operations exposed as REST routes and 13 MCP tools.

The production adapters are deliberately staged next: Entra token validation,
Azure Blob Storage through managed identity, signed download links, retention
leader election, and Azure infrastructure. The local implementation does not
pretend those controls are active.

Run all checks with:

```powershell
.venv\Scripts\python -m pytest
.venv\Scripts\ruff check src tests
```
