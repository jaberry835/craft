from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator

from officeautomation.models.docx import ApplyResult, FileOperationResult, MarkdownResult


class MarkdownToXlsxRequest(BaseModel):
    markdown: str | None = None
    markdown_file_id: str | None = None
    template_file_id: str | None = None
    output_name: str = "workbook.xlsx"

    @model_validator(mode="after")
    def exactly_one_markdown_source(self) -> "MarkdownToXlsxRequest":
        if (self.markdown is None) == (self.markdown_file_id is None):
            raise ValueError("Provide exactly one of markdown or markdown_file_id")
        return self


class XlsxToMarkdownRequest(BaseModel):
    file_id: str
    sheets: list[str] | None = None
    values_or_formulas: Literal["values", "formulas"] = "values"
    markdown_output: Literal["auto", "inline", "file"] = "auto"


class XlsxInspectRequest(BaseModel):
    file_id: str
    sample_rows: int = Field(default=5, ge=0, le=50)


class XlsxOperation(BaseModel):
    type: Literal[
        "set_cells",
        "write_range",
        "replace_placeholders",
        "add_sheet",
        "rename_sheet",
        "delete_sheet",
    ]
    values: dict[str, Any] | list[list[Any]] | None = None
    start_cell: str | None = None
    sheet: str | None = None
    replacements: dict[str, Any] | None = None
    name: str | None = None
    new_name: str | None = None


class XlsxApplyRequest(BaseModel):
    file_id: str
    operations: list[XlsxOperation] = Field(min_length=1, max_length=100)
    output_name: str = "workbook.xlsx"
    allow_formulas: bool = False
    allow_feature_loss: bool = False


__all__ = [
    "ApplyResult",
    "FileOperationResult",
    "MarkdownResult",
    "MarkdownToXlsxRequest",
    "XlsxApplyRequest",
    "XlsxInspectRequest",
    "XlsxToMarkdownRequest",
]
