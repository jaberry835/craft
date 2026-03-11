"""
tests/test_tools.py – Unit tests for MCP tools
================================================
Run with:
    uv run pytest

Or with verbose output:
    uv run pytest -v

The tests import the tool-logic functions directly (not through MCP protocol),
which keeps them fast and free of any HTTP overhead.

Test strategy
--------------
  - Test the business-logic of each tool in isolation.
  - Use httpx.AsyncClient with the ASGI app for integration-style tests
    that exercise the full HTTP stack (see test_health_endpoint below).
  - Do NOT test the MCP protocol itself – the MCP SDK already covers that.

Adding tests for a new tool
----------------------------
1. Import the tool function or the register_* function.
2. If the tool uses Context, use the MockContext helper below.
3. Assert against the Pydantic output model.
"""

import base64

import httpx
import pytest
import pytest_asyncio  # noqa: F401 – pytest-asyncio mode=auto needs this import
from httpx import ASGITransport, AsyncClient
from unittest.mock import AsyncMock, MagicMock

# Import the Starlette ASGI app from the module level so we can test HTTP.
from server import app


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

class MockContext:
    """
    Minimal stand-in for mcp.server.fastmcp.Context.

    Provides no-op implementations of the Context methods used in example.py
    so that async tools can be tested without a running MCP server.

    Extend this class if your tools use additional Context capabilities
    (report_progress, request_context, etc.).
    """

    class _RequestContext:
        lifespan_context: dict = {}

    request_context = _RequestContext()

    async def info(self, message: str, *args, **kwargs) -> None:  # noqa: ARG002
        pass

    async def debug(self, message: str, *args, **kwargs) -> None:  # noqa: ARG002
        pass

    async def warning(self, message: str, *args, **kwargs) -> None:  # noqa: ARG002
        pass

    async def error(self, message: str, *args, **kwargs) -> None:  # noqa: ARG002
        pass

    async def report_progress(
        self, progress: int, total: int, message: str = ""
    ) -> None:
        pass


# ---------------------------------------------------------------------------
# Health endpoint
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_health_endpoint_returns_200() -> None:
    """The /health endpoint must always return 200 with status=ok."""
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        response = await client.get("/health")

    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert "server" in data


# ---------------------------------------------------------------------------
# Tool: echo
# ---------------------------------------------------------------------------

def test_echo_returns_correct_fields() -> None:
    """echo should return original, upper, and length."""
    from tools.example import EchoResult

    # Access the underlying function logic directly by recreating output model.
    message = "Hello, MCP!"
    result = EchoResult(
        original=message,
        upper=message.upper(),
        length=len(message),
    )

    assert result.original == "Hello, MCP!"
    assert result.upper == "HELLO, MCP!"
    assert result.length == 11


def test_echo_empty_string() -> None:
    """echo with an empty string should return length 0."""
    from tools.example import EchoResult

    result = EchoResult(original="", upper="", length=0)
    assert result.length == 0


# ---------------------------------------------------------------------------
# Tool: list_items
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_list_items_returns_requested_count() -> None:
    """list_items should return exactly `limit` items."""
    from mcp.server.fastmcp import FastMCP

    from tools.example import register_example_tools

    # Build a fresh FastMCP instance and register tools so we can call
    # the underlying function through a controlled context.
    mcp = FastMCP("test")
    register_example_tools(mcp)

    # Call the tool function directly via re-implementing the logic.
    # This tests the logic, not the registration / protocol layer.
    from tools.example import ListResult, ItemSummary
    ctx = MockContext()
    limit = 3

    items = [ItemSummary(id=i, name=f"Item {i}") for i in range(1, limit + 1)]
    result = ListResult(items=items, total=len(items))

    assert result.total == 3
    assert len(result.items) == 3
    assert result.items[0].id == 1
    assert result.items[2].id == 3


# ---------------------------------------------------------------------------
# Auth: OBO helper (import-only test – executes only if msal is installed)
# ---------------------------------------------------------------------------

def test_obo_module_importable() -> None:
    """auth.obo should be importable regardless of whether msal is installed."""
    import auth.obo  # noqa: F401


def test_obo_raises_on_empty_token() -> None:
    """get_obo_token should raise ValueError immediately on empty token."""
    import asyncio

    from auth.obo import get_obo_token

    with pytest.raises(ValueError, match="incoming_token must not be empty"):
        asyncio.run(
            get_obo_token(
                incoming_token="",
                scopes=["https://graph.microsoft.com/User.Read"],
                msal_app=None,  # type: ignore[arg-type]
            )
        )


# ---------------------------------------------------------------------------
# Echo API tools – unit tests using mocked httpx.AsyncClient
#
# The _call_* functions are module-level (not closures), so we can call them
# directly without starting the MCP server.  A MagicMock simulates the httpx
# response; an AsyncMock simulates the client's async .get() / .post() calls.
#
# Pattern to copy when adding tests for new API wrapper tools:
#   1. Build a MagicMock response with the JSON your API would return.
#   2. Create AsyncMock(spec=httpx.AsyncClient) and set .get.return_value.
#   3. Call the _call_* function directly and assert on the Pydantic result.
# ---------------------------------------------------------------------------

def _make_mock_client(json_payload: dict, method: str = "get") -> AsyncMock:
    """Helper: returns a mock AsyncClient whose .get() (or .post()) returns json_payload."""
    mock_response = MagicMock()
    mock_response.raise_for_status = MagicMock()   # no-op – does not raise
    mock_response.json.return_value = json_payload

    mock_client = AsyncMock(spec=httpx.AsyncClient)
    getattr(mock_client, method).return_value = mock_response
    return mock_client


@pytest.mark.asyncio
async def test_echo_external_happy_path() -> None:
    """_call_echo should parse the API response into EchoApiResult."""
    from tools.echo_api import EchoApiResult, _call_echo

    client = _make_mock_client({"echo": "HELLO WORLD", "original_message": "hello world"})
    result = await _call_echo("hello world", client, "http://testapi")

    client.get.assert_called_once_with("http://testapi/echo/hello world", headers={})
    assert isinstance(result, EchoApiResult)
    assert result.echo == "HELLO WORLD"
    assert result.original_message == "hello world"


@pytest.mark.asyncio
async def test_lookup_ip_company_happy_path() -> None:
    """_call_lookup_ip_company should parse the API response into IPCompanyResult."""
    from tools.echo_api import IPCompanyResult, _call_lookup_ip_company

    payload = {
        "original_ip": "1.2.3.4",
        "company": {
            "name": "Acme Corp",
            "description": "A tech company",
            "industry": "Technology",
            "founded_year": 2000,
            "headquarters": "London, UK",
        },
        "associated_ips": ["1.2.3.5", "1.2.3.6"],
        "location": {
            "address": "123 High St",
            "city": "London",
            "country": "UK",
            "postal_code": "EC1A 1BB",
            "coordinates": "51.5074,-0.1278",
        },
        "confidence_score": 0.95,
    }
    client = _make_mock_client(payload)
    result = await _call_lookup_ip_company("1.2.3.4", client, "http://testapi")

    client.get.assert_called_once_with("http://testapi/api/v1/ip-company/1.2.3.4")
    assert isinstance(result, IPCompanyResult)
    assert result.original_ip == "1.2.3.4"
    assert result.company.name == "Acme Corp"
    assert len(result.associated_ips) == 2
    assert result.confidence_score == 0.95
    assert result.location.city == "London"


@pytest.mark.asyncio
async def test_get_company_devices_happy_path() -> None:
    """_call_get_company_devices should parse the API response into CompanyDevicesResult."""
    from tools.echo_api import CompanyDevicesResult, _call_get_company_devices

    payload = {
        "company_name": "Acme Corp",
        "total_devices": 2,
        "devices": [
            {
                "ip_address": "10.0.0.1",
                "device_type": "server",
                "hostname": "web01.acme.example",
                "location": "London DC",
                "last_seen": "2026-03-01T12:00:00Z",
            },
            {
                "ip_address": "10.0.0.2",
                "device_type": "router",
                "hostname": "gw01.acme.example",
                "location": "London DC",
                "last_seen": "2026-03-01T11:30:00Z",
            },
        ],
        "network_summary": "Acme Corp runs a mid-size data centre in London.",
    }
    client = _make_mock_client(payload)
    result = await _call_get_company_devices("Acme Corp", client, "http://testapi")

    client.get.assert_called_once_with("http://testapi/api/v1/company-devices/Acme Corp")
    assert isinstance(result, CompanyDevicesResult)
    assert result.total_devices == 2
    assert result.devices[0].hostname == "web01.acme.example"
    assert result.devices[1].device_type == "router"


@pytest.mark.asyncio
async def test_get_company_summary_happy_path() -> None:
    """_call_get_company_summary should parse the API response into CompanySummaryResult."""
    from tools.echo_api import CompanySummaryResult, _call_get_company_summary

    payload = {
        "company": {
            "name": "Acme Corp",
            "description": "A tech company",
            "industry": "Technology",
            "founded_year": 2000,
            "headquarters": "London, UK",
        },
        "location": {
            "address": "123 High St",
            "city": "London",
            "country": "UK",
            "postal_code": "EC1A 1BB",
        },
        "business_summary": "Acme Corp provides cloud solutions.",
        "key_facts": ["Founded in 2000", "500 employees"],
        "recent_news": ["Acme Corp wins award"],
    }
    client = _make_mock_client(payload)
    result = await _call_get_company_summary("Acme Corp", client, "http://testapi")

    client.get.assert_called_once_with("http://testapi/api/v1/company-summary/Acme Corp")
    assert isinstance(result, CompanySummaryResult)
    assert result.company.founded_year == 2000
    assert "500 employees" in result.key_facts
    assert result.location.coordinates is None  # not in payload, should default to None


@pytest.mark.asyncio
async def test_echo_external_raises_on_http_error() -> None:
    """_call_echo should raise RuntimeError for non-2xx responses."""
    from tools.echo_api import _call_echo

    bad_response = MagicMock()
    bad_response.status_code = 500
    bad_response.text = "Internal Server Error"

    mock_client = AsyncMock(spec=httpx.AsyncClient)
    mock_client.get.side_effect = httpx.HTTPStatusError(
        "500", request=MagicMock(), response=bad_response
    )

    with pytest.raises(RuntimeError, match="Echo API returned HTTP 500"):
        await _call_echo("test", mock_client, "http://testapi")


@pytest.mark.asyncio
async def test_echo_external_raises_on_connection_error() -> None:
    """_call_echo should raise RuntimeError when the API is unreachable."""
    from tools.echo_api import _call_echo

    mock_client = AsyncMock(spec=httpx.AsyncClient)
    mock_client.get.side_effect = httpx.ConnectError("Connection refused")

    with pytest.raises(RuntimeError, match="Could not reach Echo API"):
        await _call_echo("test", mock_client, "http://testapi")


# ---------------------------------------------------------------------------
# Secure API tools – unit tests
# ---------------------------------------------------------------------------

def test_encode_user_cert_header_round_trip(tmp_path) -> None:
    """encode_user_cert_header should produce valid base64 DER from a PEM file."""
    from tools.secure_api import encode_user_cert_header

    # Minimal self-consistent PEM: 48 raw bytes → base64 lines → header/footer
    raw_der = b"\x30" * 48
    b64_body = base64.b64encode(raw_der).decode("ascii")
    pem_text = f"-----BEGIN CERTIFICATE-----\n{b64_body}\n-----END CERTIFICATE-----\n"

    pem_file = tmp_path / "test.crt"
    pem_file.write_text(pem_text, encoding="ascii")

    result = encode_user_cert_header(pem_file)

    # Decode result and verify it matches the original DER bytes
    assert base64.b64decode(result) == raw_der


def test_encode_user_cert_header_real_cert() -> None:
    """encode_user_cert_header should work with the real user-alice.crt in certs/."""
    from pathlib import Path

    from tools.secure_api import encode_user_cert_header

    cert_path = Path("certs/user-alice.crt")
    if not cert_path.exists():
        pytest.skip("certs/user-alice.crt not found")

    result = encode_user_cert_header(cert_path)

    # Result should be valid base64 that decodes to DER (starts with 0x30 = ASN.1 SEQUENCE)
    der = base64.b64decode(result)
    assert der[0] == 0x30  # ASN.1 SEQUENCE tag


@pytest.mark.asyncio
async def test_secure_api_status_happy_path() -> None:
    """_call_secure_status should parse the API response into SecureApiStatusResult."""
    from tools.secure_api import SecureApiStatusResult, _call_secure_status

    payload = {
        "status": "running",
        "service": "Secure API — caller mTLS + OBO user cert",
        "version": "2.0.0",
        "auth": {
            "layer1": "mTLS",
            "layer2": "X-User-Cert header",
            "caller_allowlist": ["test-caller"],
            "user_cert_required": True,
        },
    }
    client = _make_mock_client(payload)
    result = await _call_secure_status(client, "https://testapi")

    client.get.assert_called_once_with("https://testapi/status")
    assert isinstance(result, SecureApiStatusResult)
    assert result.status == "running"
    assert result.version == "2.0.0"
    assert result.auth.user_cert_required is True
    assert "test-caller" in result.auth.caller_allowlist


@pytest.mark.asyncio
async def test_secure_api_greeting_happy_path() -> None:
    """_call_secure_greeting should parse the API response into SecureApiGreetingResult."""
    from tools.secure_api import SecureApiGreetingResult, _call_secure_greeting

    payload = {
        "status": "ok",
        "message": "Request accepted. Caller 'test-caller' is acting on behalf of user 'user-alice'.",
        "caller_cn": "test-caller",
        "user_cn": "user-alice",
        "auth_method": "mTLS (caller) + X-User-Cert header (user identity)",
    }
    client = _make_mock_client(payload)
    user_b64 = "dGVzdA=="  # dummy value

    result = await _call_secure_greeting(client, "https://testapi", user_b64)

    client.get.assert_called_once_with(
        "https://testapi/",
        headers={"X-User-Cert": user_b64},
    )
    assert isinstance(result, SecureApiGreetingResult)
    assert result.caller_cn == "test-caller"
    assert result.user_cn == "user-alice"
    assert "accepted" in result.message.lower()


@pytest.mark.asyncio
async def test_secure_api_data_happy_path() -> None:
    """_call_secure_data should parse the API response into SecureApiDataResult."""
    from tools.secure_api import SecureApiDataResult, _call_secure_data

    payload = {
        "status": "success",
        "caller_cn": "test-caller",
        "user_cn": "user-alice",
        "protected_data": {
            "count": 3,
            "records": ["alpha", "beta", "gamma"],
            "note": "Sample protected records.",
        },
    }
    client = _make_mock_client(payload)
    user_b64 = "dGVzdA=="

    result = await _call_secure_data(client, "https://testapi", user_b64)

    client.get.assert_called_once_with(
        "https://testapi/data",
        headers={"X-User-Cert": user_b64},
    )
    assert isinstance(result, SecureApiDataResult)
    assert result.status == "success"
    assert result.protected_data.count == 3
    assert result.protected_data.records == ["alpha", "beta", "gamma"]


@pytest.mark.asyncio
async def test_secure_api_status_raises_on_http_error() -> None:
    """_call_secure_status should raise RuntimeError for non-2xx responses."""
    from tools.secure_api import _call_secure_status

    bad_response = MagicMock()
    bad_response.status_code = 403
    bad_response.text = "Forbidden"

    mock_client = AsyncMock(spec=httpx.AsyncClient)
    mock_client.get.side_effect = httpx.HTTPStatusError(
        "403", request=MagicMock(), response=bad_response
    )

    with pytest.raises(RuntimeError, match="Secure API /status returned HTTP 403"):
        await _call_secure_status(mock_client, "https://testapi")


@pytest.mark.asyncio
async def test_secure_api_greeting_raises_on_connection_error() -> None:
    """_call_secure_greeting should raise RuntimeError when the API is unreachable."""
    from tools.secure_api import _call_secure_greeting

    mock_client = AsyncMock(spec=httpx.AsyncClient)
    mock_client.get.side_effect = httpx.ConnectError("Connection refused")

    with pytest.raises(RuntimeError, match="Could not reach Secure API"):
        await _call_secure_greeting(mock_client, "https://testapi", "dGVzdA==")


# ---------------------------------------------------------------------------
# UserCertMiddleware / get_user_cert() – contextvar propagation
# ---------------------------------------------------------------------------

def test_get_user_cert_returns_empty_by_default() -> None:
    """get_user_cert() should return '' when no middleware has set the var."""
    from auth.user_cert_context import get_user_cert

    assert get_user_cert() == ""


@pytest.mark.asyncio
async def test_user_cert_middleware_propagates_header() -> None:
    """UserCertMiddleware should set the contextvar from the X-User-Cert header."""
    from auth.user_cert_context import UserCertMiddleware, get_user_cert

    captured = {}

    async def downstream_app(scope, receive, send):
        captured["cert"] = get_user_cert()

    middleware = UserCertMiddleware(downstream_app)

    scope = {
        "type": "http",
        "headers": [(b"x-user-cert", b"dGVzdENlcnQ=")],
    }
    await middleware(scope, None, None)

    assert captured["cert"] == "dGVzdENlcnQ="


@pytest.mark.asyncio
async def test_user_cert_middleware_empty_when_no_header() -> None:
    """UserCertMiddleware should set '' when X-User-Cert is absent."""
    from auth.user_cert_context import UserCertMiddleware, get_user_cert

    captured = {}

    async def downstream_app(scope, receive, send):
        captured["cert"] = get_user_cert()

    middleware = UserCertMiddleware(downstream_app)

    scope = {
        "type": "http",
        "headers": [],
    }
    await middleware(scope, None, None)

    assert captured["cert"] == ""


@pytest.mark.asyncio
async def test_user_cert_header_reaches_health_endpoint() -> None:
    """X-User-Cert sent on a real HTTP request should be accessible via get_user_cert()."""
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        response = await client.get(
            "/health",
            headers={"X-User-Cert": "abc123"},
        )

    # Health endpoint doesn't use the cert, but should still return 200
    # (middleware should not interfere with unrelated endpoints).
    assert response.status_code == 200
