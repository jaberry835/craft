from fastapi.testclient import TestClient


def test_mcp_streamable_http_lists_shared_tools(client: TestClient) -> None:
    headers = {
        "Accept": "application/json, text/event-stream",
        "Content-Type": "application/json",
    }
    response = client.post(
        "/mcp",
        headers=headers,
        json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "test", "version": "1"},
            },
        },
    )
    assert response.status_code == 200
    headers["MCP-Protocol-Version"] = response.json()["result"]["protocolVersion"]

    response = client.post(
        "/mcp",
        headers=headers,
        json={"jsonrpc": "2.0", "method": "notifications/initialized"},
    )
    assert response.status_code == 202

    response = client.post(
        "/mcp",
        headers=headers,
        json={"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
    )
    assert response.status_code == 200
    names = {tool["name"] for tool in response.json()["result"]["tools"]}
    assert {
        "service_info",
        "files_create_upload",
        "markdown_to_docx",
        "docx_apply",
        "markdown_to_xlsx",
        "xlsx_apply",
    } <= names
