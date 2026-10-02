from fastapi.testclient import TestClient


def test_xlsx_round_trip_apply_and_formula_protection(client: TestClient) -> None:
    markdown = """# Budget

| Item | Cost |
|---|---|
| Hosting | 42 |
"""
    response = client.post(
        "/api/v1/xlsx/from-markdown",
        json={"markdown": markdown, "output_name": "budget.xlsx"},
    )
    assert response.status_code == 200
    source_id = response.json()["file"]["file_id"]

    response = client.post(
        "/api/v1/xlsx/apply",
        json={
            "file_id": source_id,
            "operations": [
                {
                    "type": "set_cells",
                    "values": {"Budget!B2": "=1+1", "Budget!A3": "Support", "Budget!B3": 8},
                }
            ],
        },
    )
    assert response.status_code == 200
    output_id = response.json()["file"]["file_id"]

    response = client.post(
        "/api/v1/xlsx/to-markdown",
        json={"file_id": output_id, "values_or_formulas": "formulas"},
    )
    assert response.status_code == 200
    assert "Support" in response.json()["markdown"]

    response = client.post("/api/v1/xlsx/inspect", json={"file_id": output_id})
    assert response.status_code == 200
    assert response.json()["formula_count"] == 0
