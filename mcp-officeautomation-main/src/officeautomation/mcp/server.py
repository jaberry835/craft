import base64
import binascii
from typing import Any

from mcp.server import MCPServer
from mcp.server.mcpserver import Context

from officeautomation import __version__
from officeautomation.config import Settings
from officeautomation.docx.service import DocxService
from officeautomation.errors import ServiceError
from officeautomation.files.local import LocalFileStore
from officeautomation.models.docx import (
    DocxApplyRequest,
    DocxInspectRequest,
    DocxOperation,
    MarkdownToDocxRequest,
)
from officeautomation.models.files import FileCreate
from officeautomation.models.xlsx import MarkdownToXlsxRequest, XlsxApplyRequest, XlsxOperation
from officeautomation.xlsx.service import XlsxService


def create_mcp_server(
    settings: Settings,
    store: LocalFileStore,
    docx_service: DocxService,
    xlsx_service: XlsxService,
) -> MCPServer:
    server = MCPServer(
        "office-automation",
        description="Deterministic Word and Excel document automation",
        version=__version__,
    )

    @server.tool()
    async def service_info() -> dict[str, Any]:
        """Return service capabilities and configured limits."""
        return {
            "name": "office-automation",
            "version": __version__,
            "retention_seconds": settings.retention_seconds,
            "max_file_size": settings.max_file_size,
            "formats": ["docx", "xlsx"],
        }

    @server.tool()
    async def files_create_upload(
        name: str,
        content_type: str,
        size: int,
        ctx: Context,
        sha256: str | None = None,
    ) -> dict[str, Any]:
        """Reserve an immutable file handle and return REST upload endpoints."""
        owner = _owner(ctx, settings)
        result = store.reserve(
            owner,
            FileCreate(name=name, content_type=content_type, size=size, sha256=sha256),
        )
        return result.model_dump(mode="json")

    @server.tool()
    async def files_get_info(file_id: str, ctx: Context) -> dict[str, Any]:
        """Return metadata and lineage for an uploaded file."""
        result = store.to_reference(store.get(file_id, _owner(ctx, settings)))
        return result.model_dump(mode="json")

    @server.tool()
    async def files_delete(file_id: str, ctx: Context) -> dict[str, Any]:
        """Delete a file before its scheduled expiry."""
        store.delete(_owner(ctx, settings), file_id)
        return {"file_id": file_id, "deleted": True}

    @server.tool()
    async def files_upload_inline(
        name: str,
        content_type: str,
        content_base64: str,
        ctx: Context,
    ) -> dict[str, Any]:
        """Upload a small file inline; larger files must use the REST upload endpoints."""
        try:
            content = base64.b64decode(content_base64, validate=True)
        except (ValueError, binascii.Error) as error:
            raise ServiceError("INVALID_DOCUMENT", "Invalid base64 content", 422) from error
        if len(content) > settings.max_inline_upload_size:
            raise ServiceError(
                "PAYLOAD_TOO_LARGE", "Inline upload exceeds the configured limit", 413
            )
        result = await store.save_bytes(_owner(ctx, settings), name, content_type, content)
        return result.model_dump(mode="json")

    @server.tool()
    async def markdown_to_docx(
        ctx: Context,
        markdown: str | None = None,
        markdown_file_id: str | None = None,
        template_file_id: str | None = None,
        output_name: str = "document.docx",
    ) -> dict[str, Any]:
        """Create a Word document from Markdown, optionally using a template."""
        result = await docx_service.from_markdown(
            _owner(ctx, settings),
            MarkdownToDocxRequest(
                markdown=markdown,
                markdown_file_id=markdown_file_id,
                template_file_id=template_file_id,
                output_name=output_name,
            ),
        )
        return result.model_dump(mode="json")

    @server.tool()
    async def docx_to_markdown(
        file_id: str,
        ctx: Context,
        markdown_output: str = "auto",
        include_headers_footers: bool = False,
    ) -> dict[str, Any]:
        """Convert a Word document to Markdown."""
        result = await docx_service.to_markdown(
            _owner(ctx, settings),
            file_id,
            markdown_output,
            include_headers_footers,
        )
        return result.model_dump(mode="json")

    @server.tool()
    async def docx_inspect(
        file_id: str, ctx: Context, detail_level: str = "summary"
    ) -> dict[str, Any]:
        """Describe Word document structure and addressable placeholders."""
        DocxInspectRequest(file_id=file_id, detail_level=detail_level)
        return docx_service.inspect(_owner(ctx, settings), file_id, detail_level)

    @server.tool()
    async def docx_apply(
        file_id: str,
        operations: list[dict[str, Any]],
        ctx: Context,
        output_name: str = "document.docx",
    ) -> dict[str, Any]:
        """Apply an atomic batch of deterministic Word edits."""
        result = await docx_service.apply(
            _owner(ctx, settings),
            DocxApplyRequest(
                file_id=file_id,
                operations=[DocxOperation.model_validate(item) for item in operations],
                output_name=output_name,
            ),
        )
        return result.model_dump(mode="json")

    @server.tool()
    async def markdown_to_xlsx(
        ctx: Context,
        markdown: str | None = None,
        markdown_file_id: str | None = None,
        template_file_id: str | None = None,
        output_name: str = "workbook.xlsx",
    ) -> dict[str, Any]:
        """Create an Excel workbook from Markdown tables."""
        result = await xlsx_service.from_markdown(
            _owner(ctx, settings),
            MarkdownToXlsxRequest(
                markdown=markdown,
                markdown_file_id=markdown_file_id,
                template_file_id=template_file_id,
                output_name=output_name,
            ),
        )
        return result.model_dump(mode="json")

    @server.tool()
    async def xlsx_to_markdown(
        file_id: str,
        ctx: Context,
        sheets: list[str] | None = None,
        values_or_formulas: str = "values",
        markdown_output: str = "auto",
    ) -> dict[str, Any]:
        """Convert selected Excel worksheets to Markdown tables."""
        result = await xlsx_service.to_markdown(
            _owner(ctx, settings),
            file_id,
            sheets,
            values_or_formulas,
            markdown_output,
        )
        return result.model_dump(mode="json")

    @server.tool()
    async def xlsx_inspect(file_id: str, ctx: Context, sample_rows: int = 5) -> dict[str, Any]:
        """Describe workbook structure, placeholders, formulas, and risky features."""
        return xlsx_service.inspect(_owner(ctx, settings), file_id, sample_rows)

    @server.tool()
    async def xlsx_apply(
        file_id: str,
        operations: list[dict[str, Any]],
        ctx: Context,
        output_name: str = "workbook.xlsx",
        allow_formulas: bool = False,
        allow_feature_loss: bool = False,
    ) -> dict[str, Any]:
        """Apply an atomic batch of deterministic Excel edits."""
        result = await xlsx_service.apply(
            _owner(ctx, settings),
            XlsxApplyRequest(
                file_id=file_id,
                operations=[XlsxOperation.model_validate(item) for item in operations],
                output_name=output_name,
                allow_formulas=allow_formulas,
                allow_feature_loss=allow_feature_loss,
            ),
        )
        return result.model_dump(mode="json")

    return server


def _owner(ctx: Context, settings: Settings) -> str:
    request = ctx.request_context.request
    if request is not None:
        owner = getattr(request.state, "owner_id", None)
        if owner:
            return owner
    if settings.auth_mode == "disabled":
        return "local-user"
    raise ServiceError("UNAUTHORIZED", "Caller identity is unavailable", 401)
