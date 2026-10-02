from fastapi import APIRouter, Request

from officeautomation.docx.service import DocxService
from officeautomation.models.docx import (
    ApplyResult,
    DocxApplyRequest,
    DocxInspectRequest,
    DocxToMarkdownRequest,
    FileOperationResult,
    MarkdownResult,
    MarkdownToDocxRequest,
)


def create_docx_router(service: DocxService) -> APIRouter:
    router = APIRouter(prefix="/docx", tags=["docx"])

    @router.post("/from-markdown", response_model=FileOperationResult)
    async def from_markdown(
        payload: MarkdownToDocxRequest, request: Request
    ) -> FileOperationResult:
        return await service.from_markdown(request.state.owner_id, payload)

    @router.post("/to-markdown", response_model=MarkdownResult)
    async def to_markdown(payload: DocxToMarkdownRequest, request: Request) -> MarkdownResult:
        return await service.to_markdown(
            request.state.owner_id,
            payload.file_id,
            payload.markdown_output,
            payload.include_headers_footers,
        )

    @router.post("/inspect")
    async def inspect(payload: DocxInspectRequest, request: Request) -> dict[str, object]:
        return service.inspect(request.state.owner_id, payload.file_id, payload.detail_level)

    @router.post("/apply", response_model=ApplyResult)
    async def apply(payload: DocxApplyRequest, request: Request) -> ApplyResult:
        return await service.apply(request.state.owner_id, payload)

    return router
