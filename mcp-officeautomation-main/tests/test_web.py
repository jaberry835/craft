from fastapi.testclient import TestClient


def test_landing_page_describes_mcp_and_links_swagger(client: TestClient) -> None:
    response = client.get("/")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/html")
    assert "http://testserver/mcp" in response.text
    assert 'href="/api/v1/docs"' in response.text
    assert "files_create_upload" in response.text
    assert "docx_apply" in response.text
    assert "xlsx_apply" in response.text


def test_swagger_and_openapi_are_available(client: TestClient) -> None:
    docs_response = client.get("/api/v1/docs")
    schema_response = client.get("/api/v1/openapi.json")

    assert docs_response.status_code == 200
    assert "Swagger UI" in docs_response.text
    assert schema_response.status_code == 200
    assert schema_response.json()["info"]["title"] == "Office Automation Service"
