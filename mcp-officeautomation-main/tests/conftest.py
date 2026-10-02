from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from officeautomation.app import create_app
from officeautomation.config import Settings


@pytest.fixture
def client(tmp_path: object) -> Iterator[TestClient]:
    app = create_app(
        Settings(
            environment="test",
            auth_mode="disabled",
            file_store_root=str(tmp_path),
        )
    )
    with TestClient(app) as test_client:
        yield test_client
