import html
import json

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse
from mcp.server import MCPServer


def create_landing_router(mcp_server: MCPServer) -> APIRouter:
    router = APIRouter()

    @router.get("/", response_class=HTMLResponse, include_in_schema=False)
    async def landing_page(request: Request) -> HTMLResponse:
        base_url = str(request.base_url).rstrip("/")
        mcp_url = f"{base_url}/mcp"
        tools = await mcp_server.list_tools()
        tool_items = "\n".join(
            f"<li><code>{html.escape(tool.name)}</code>"
            f"<span>{html.escape(tool.description or 'No description available.')}</span></li>"
            for tool in tools
        )
        vscode_config = json.dumps(
            {
                "servers": {
                    "office-automation": {
                        "type": "http",
                        "url": mcp_url,
                    }
                }
            },
            indent=2,
        )
        content = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Office Automation Service</title>
  <style>
    body {{ color: #202124; font: 16px/1.5 system-ui, sans-serif; margin: 0; }}
    main {{ margin: 0 auto; max-width: 960px; padding: 3rem 1.5rem; }}
    h1, h2 {{ line-height: 1.2; }}
    a {{ color: #075985; }}
    .actions {{ display: flex; flex-wrap: wrap; gap: 1rem; margin: 2rem 0; }}
    .actions a {{ background: #075985; border-radius: .4rem; color: white;
      padding: .7rem 1rem; text-decoration: none; }}
    pre {{ background: #f3f4f6; border-radius: .4rem; overflow-x: auto; padding: 1rem; }}
    ul {{ display: grid; gap: .75rem; list-style: none; padding: 0; }}
    li {{ border-left: .25rem solid #0e7490; padding-left: .75rem; }}
    li code {{ display: block; font-weight: 700; }}
    li span {{ display: block; }}
  </style>
</head>
<body>
<main>
  <h1>Office Automation Service</h1>
  <p>Deterministic Word and Excel document automation over REST and MCP.</p>
  <div class="actions">
    <a href="/api/v1/docs">Open Swagger API documentation</a>
    <a href="/api/v1/openapi.json">Download the OpenAPI schema</a>
  </div>

  <h2>Connect an MCP client</h2>
  <p>The Streamable HTTP MCP endpoint is <code>{html.escape(mcp_url)}</code>.</p>
  <p>Add this server definition to <code>.vscode/mcp.json</code>:</p>
  <pre><code>{html.escape(vscode_config)}</code></pre>
  <p>When authentication is enabled, configure the client to send the credentials
  required by the deployment.</p>

  <h2>Available MCP tools</h2>
  <ul>{tool_items}</ul>
</main>
</body>
</html>"""
        return HTMLResponse(content)

    return router
