from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator

from officeautomation.models.files import FileReference


class MarkdownToDocxRequest(BaseModel):
    markdown: str | None = None
    markdown_file_id: str | None = None
    template_file_id: str | None = None
    output_name: str = "document.docx"

    @model_validator(mode="after")
    def exactly_one_markdown_source(self) -> "MarkdownToDocxRequest":
        if (self.markdown is None) == (self.markdown_file_id is None):
            raise ValueError("Provide exactly one of markdown or markdown_file_id")
        return self


class DocxToMarkdownRequest(BaseModel):
    file_id: str
    markdown_output: Literal["auto", "inline", "file"] = "auto"
    include_headers_footers: bool = False


class DocxInspectRequest(BaseModel):
    file_id: str
    detail_level: Literal["summary", "full"] = "summary"


class DocxOperation(BaseModel):
    type: Literal["replace_placeholder", "replace_text", "set_properties"]
    placeholder: str | None = None
    find: str | None = None
    value: str | None = None
    properties: dict[str, str] | None = None


class DocxApplyRequest(BaseModel):
    file_id: str
    operations: list[DocxOperation] = Field(min_length=1, max_length=100)
    output_name: str = "document.docx"


class FileOperationResult(BaseModel):
    file: FileReference
    warnings: list[str] = Field(default_factory=list)


class MarkdownResult(BaseModel):
    markdown: str | None = None
    markdown_file: FileReference | None = None
    assets: list[dict[str, Any]] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


class ApplyResult(FileOperationResult):
    operations: list[dict[str, Any]]
