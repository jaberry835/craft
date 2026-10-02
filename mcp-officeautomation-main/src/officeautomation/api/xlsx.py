from fastapi import APIRouter, Request

from officeautomation.models.docx import ApplyResult, FileOperationResult, MarkdownResult
from officeautomation.models.xlsx import (
    MarkdownToXlsxRequest,
    XlsxApplyRequest,
    XlsxInspectRequest,
    XlsxToMarkdownRequest,
)
from officeautomation.xlsx.service import XlsxService


def create_xlsx_router(service: XlsxService) -> APIRouter:
    router = APIRouter(prefix="/xlsx", tags=["xlsx"])

    @router.post("/from-markdown", response_model=FileOperationResult)
    async def from_markdown(
        payload: MarkdownToXlsxRequest, request: Request
    ) -> FileOperationResult:
        return await service.from_markdown(request.state.owner_id, payload)

    @router.post("/to-markdown", response_model=MarkdownResult)
    async def to_markdown(payload: XlsxToMarkdownRequest, request: Request) -> MarkdownResult:
        return await service.to_markdown(
            request.state.owner_id,
            payload.file_id,
            payload.sheets,
            payload.values_or_formulas,
            payload.markdown_output,
        )

    @router.post("/inspect")
    async def inspect(payload: XlsxInspectRequest, request: Request) -> dict[str, object]:
        return service.inspect(request.state.owner_id, payload.file_id, payload.sample_rows)

    @router.post("/apply", response_model=ApplyResult)
    async def apply(payload: XlsxApplyRequest, request: Request) -> ApplyResult:
        return await service.apply(request.state.owner_id, payload)

    return router
