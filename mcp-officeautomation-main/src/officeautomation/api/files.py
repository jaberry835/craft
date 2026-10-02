from typing import Annotated

from fastapi import APIRouter, Path, Request, Response, status
from fastapi.responses import FileResponse

from officeautomation.files.local import LocalFileStore
from officeautomation.models.files import (
    CommitRequest,
    FileCreate,
    FileReference,
    UploadReservation,
)


def create_files_router(store: LocalFileStore) -> APIRouter:
    router = APIRouter(prefix="/files", tags=["files"])

    @router.post("", response_model=UploadReservation, status_code=status.HTTP_201_CREATED)
    async def reserve_file(payload: FileCreate, request: Request) -> UploadReservation:
        return store.reserve(request.state.owner_id, payload)

    @router.put("/{file_id}/content", response_model=FileReference)
    async def upload_file(file_id: str, request: Request) -> FileReference:
        return await store.upload(request.state.owner_id, file_id, request.stream())

    @router.put("/{file_id}/blocks/{block_number}", status_code=status.HTTP_204_NO_CONTENT)
    async def upload_block(
        file_id: str,
        block_number: Annotated[int, Path(ge=0, le=9999)],
        request: Request,
    ) -> Response:
        await store.upload_block(request.state.owner_id, file_id, block_number, request.stream())
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    @router.post("/{file_id}/commit", response_model=FileReference)
    async def commit_upload(
        file_id: str, payload: CommitRequest, request: Request
    ) -> FileReference:
        return store.commit(request.state.owner_id, file_id, payload.block_count, payload.sha256)

    @router.get("/{file_id}", response_model=FileReference)
    async def get_file(file_id: str, request: Request) -> FileReference:
        return store.to_reference(store.get(file_id, request.state.owner_id))

    @router.get("/{file_id}/content", response_class=FileResponse)
    async def download_file(file_id: str, request: Request) -> FileResponse:
        stored, path = store.open_content(request.state.owner_id, file_id)
        return FileResponse(
            path,
            media_type=stored.content_type,
            filename=stored.name,
            headers={"ETag": f'"{stored.sha256}"'},
        )

    @router.delete("/{file_id}", status_code=status.HTTP_204_NO_CONTENT)
    async def delete_file(file_id: str, request: Request) -> Response:
        store.delete(request.state.owner_id, file_id)
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    return router
