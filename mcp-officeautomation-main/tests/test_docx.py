from fastapi.testclient import TestClient


def test_docx_round_trip_inspect_and_apply(client: TestClient) -> None:
    markdown = """# Report

Hello {{name}}.

| A | B |
|---|---|
| 1 | 2 |
"""
    response = client.post(
        "/api/v1/docx/from-markdown",
        json={"markdown": markdown, "output_name": "report.docx"},
    )
    assert response.status_code == 200
    source_id = response.json()["file"]["file_id"]

    response = client.post(
        "/api/v1/docx/inspect",
        json={"file_id": source_id, "detail_level": "full"},
    )
    assert response.status_code == 200
    assert response.json()["placeholders"][0]["token"] == "{{name}}"

    response = client.post(
        "/api/v1/docx/apply",
        json={
            "file_id": source_id,
            "operations": [
                {"type": "replace_placeholder", "placeholder": "{{name}}", "value": "Ada"}
            ],
        },
    )
    assert response.status_code == 200
    output_id = response.json()["file"]["file_id"]
    assert output_id != source_id

    response = client.post("/api/v1/docx/to-markdown", json={"file_id": output_id})
    assert response.status_code == 200
    assert "Hello Ada." in response.json()["markdown"]
    assert "| A | B |" in response.json()["markdown"]
