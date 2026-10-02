import hashlib

from fastapi.testclient import TestClient


def test_single_upload_metadata_and_range_download(client: TestClient) -> None:
    content = b"# Hello"
    response = client.post(
        "/api/v1/files",
        json={
            "name": "sample.md",
            "content_type": "text/markdown",
            "size": len(content),
            "sha256": hashlib.sha256(content).hexdigest(),
        },
    )
    assert response.status_code == 201
    file_id = response.json()["file_id"]

    response = client.put(f"/api/v1/files/{file_id}/content", content=content)
    assert response.status_code == 200
    assert response.json()["state"] == "validated"

    response = client.get(f"/api/v1/files/{file_id}/content", headers={"Range": "bytes=2-6"})
    assert response.status_code == 206
    assert response.content == b"Hello"


def test_chunked_upload_can_arrive_out_of_order(client: TestClient) -> None:
    content = b"first-second"
    response = client.post(
        "/api/v1/files",
        json={"name": "sample.md", "content_type": "text/markdown", "size": len(content)},
    )
    file_id = response.json()["file_id"]

    assert client.put(f"/api/v1/files/{file_id}/blocks/1", content=b"second").status_code == 204
    assert client.put(f"/api/v1/files/{file_id}/blocks/0", content=b"first-").status_code == 204
    response = client.post(f"/api/v1/files/{file_id}/commit", json={"block_count": 2})

    assert response.status_code == 200
    assert client.get(f"/api/v1/files/{file_id}/content").content == content


def test_file_handles_are_owner_isolated(client: TestClient) -> None:
    response = client.post(
        "/api/v1/files",
        headers={"X-Owner-ID": "owner-a"},
        json={"name": "sample.md", "content_type": "text/markdown", "size": 1},
    )
    file_id = response.json()["file_id"]

    response = client.get(f"/api/v1/files/{file_id}", headers={"X-Owner-ID": "owner-b"})
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "FILE_NOT_FOUND"
