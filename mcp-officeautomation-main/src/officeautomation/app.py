from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import APIRouter, FastAPI
from mcp.server.transport_security import TransportSecuritySettings

from officeautomation import __version__
from officeautomation.api.docx import create_docx_router
from officeautomation.api.files import create_files_router
from officeautomation.api.landing import create_landing_router
from officeautomation.api.xlsx import create_xlsx_router
from officeautomation.auth import AuthenticationMiddleware
from officeautomation.config import Settings, get_settings
from officeautomation.docx.service import DocxService
from officeautomation.errors import register_error_handlers
from officeautomation.files.local import LocalFileStore
from officeautomation.mcp.server import create_mcp_server
from officeautomation.xlsx.service import XlsxService


def create_app(settings: Settings | None = None) -> FastAPI:
    resolved_settings = settings or get_settings()
    file_store = LocalFileStore(resolved_settings)
    docx_service = DocxService(file_store)
    xlsx_service = XlsxService(file_store)
    mcp_server = create_mcp_server(resolved_settings, file_store, docx_service, xlsx_service)
    mcp_app = mcp_server.streamable_http_app(
        streamable_http_path="/mcp",
        json_response=True,
        stateless_http=True,
        transport_security=TransportSecuritySettings(
            allowed_hosts=resolved_settings.mcp_allowed_hosts,
            allowed_origins=resolved_settings.mcp_allowed_origins,
        ),
    )

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        async with mcp_app.router.lifespan_context(mcp_app):
            yield

    app = FastAPI(
        title="Office Automation Service",
        version=__version__,
        docs_url="/api/v1/docs",
        openapi_url="/api/v1/openapi.json",
        redoc_url=None,
        lifespan=lifespan,
    )
    app.state.settings = resolved_settings
    app.state.file_store = file_store
    app.state.docx_service = docx_service
    app.state.xlsx_service = xlsx_service
    app.state.mcp_server = mcp_server
    register_error_handlers(app)
    app.add_middleware(AuthenticationMiddleware, settings=resolved_settings)
    app.include_router(create_landing_router(mcp_server))

    api = APIRouter(prefix="/api/v1")

    @app.get("/healthz", include_in_schema=False)
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @api.get("/info")
    async def service_info() -> dict[str, object]:
        return {
            "name": "office-automation",
            "version": __version__,
            "retention_seconds": resolved_settings.retention_seconds,
            "max_file_size": resolved_settings.max_file_size,
            "interfaces": ["rest", "mcp"],
            "formats": ["docx", "xlsx"],
        }

    api.include_router(create_files_router(app.state.file_store))
    api.include_router(create_docx_router(app.state.docx_service))
    api.include_router(create_xlsx_router(app.state.xlsx_service))
    app.include_router(api)
    app.mount("/", mcp_app)
    return app
