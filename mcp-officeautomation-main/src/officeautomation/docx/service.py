import re
from io import BytesIO
from pathlib import Path
from typing import Any

from docx import Document
from docx.document import Document as DocumentObject
from docx.enum.text import WD_BREAK
from docx.table import Table
from docx.text.paragraph import Paragraph
from markdown_it import MarkdownIt

from officeautomation.errors import ServiceError
from officeautomation.files.local import LocalFileStore
from officeautomation.models.docx import (
    ApplyResult,
    DocxApplyRequest,
    FileOperationResult,
    MarkdownResult,
    MarkdownToDocxRequest,
)

DOCX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
PLACEHOLDER_PATTERN = re.compile(r"\{\{[^{}]+\}\}|\[\[[^\[\]]+\]\]|«[^»]+»|<<[^<>]+>>")


class DocxService:
    def __init__(self, store: LocalFileStore) -> None:
        self.store = store
        self.markdown = MarkdownIt("commonmark").enable("table")

    async def from_markdown(
        self, owner: str, request: MarkdownToDocxRequest
    ) -> FileOperationResult:
        markdown = self._load_markdown(owner, request.markdown, request.markdown_file_id)
        if request.template_file_id:
            _, template_path = self.store.open_content(owner, request.template_file_id)
            document = Document(template_path)
            self._clear_body(document)
        else:
            document = Document()
        warnings = self._render_markdown(document, markdown)
        output = BytesIO()
        document.save(output)
        parent = request.template_file_id or request.markdown_file_id
        reference = await self.store.save_bytes(
            owner,
            self._ensure_suffix(request.output_name, ".docx"),
            DOCX_CONTENT_TYPE,
            output.getvalue(),
            parent_file_id=parent,
        )
        return FileOperationResult(file=reference, warnings=warnings)

    async def to_markdown(
        self,
        owner: str,
        file_id: str,
        output_mode: str,
        include_headers_footers: bool,
    ) -> MarkdownResult:
        _, path = self.store.open_content(owner, file_id)
        document = Document(path)
        lines: list[str] = []
        warnings: list[str] = []
        for block in document.iter_inner_content():
            if isinstance(block, Paragraph):
                text = block.text.strip()
                if not text:
                    lines.append("")
                    continue
                style_name = block.style.name if block.style else ""
                heading = re.fullmatch(r"Heading ([1-6])", style_name)
                if heading:
                    lines.append(f"{'#' * int(heading.group(1))} {text}")
                elif style_name.startswith("List Bullet"):
                    lines.append(f"- {text}")
                elif style_name.startswith("List Number"):
                    lines.append(f"1. {text}")
                else:
                    lines.append(text)
            elif isinstance(block, Table):
                lines.extend(self._table_to_markdown(block))
        if include_headers_footers:
            for index, section in enumerate(document.sections):
                for label, container in (("Header", section.header), ("Footer", section.footer)):
                    text = "\n\n".join(p.text for p in container.paragraphs if p.text)
                    if text:
                        lines.extend(["", f"<!-- {label} {index} -->", text])
        markdown = "\n".join(lines).strip() + "\n"
        if output_mode == "file" or (output_mode == "auto" and len(markdown.encode()) > 100_000):
            reference = await self.store.save_bytes(
                owner,
                f"{Path(self.store.get(file_id, owner).name).stem}.md",
                "text/markdown",
                markdown.encode(),
                parent_file_id=file_id,
            )
            return MarkdownResult(markdown_file=reference, warnings=warnings)
        return MarkdownResult(markdown=markdown, warnings=warnings)

    def inspect(self, owner: str, file_id: str, detail_level: str) -> dict[str, Any]:
        _, path = self.store.open_content(owner, file_id)
        document = Document(path)
        blocks: list[dict[str, Any]] = []
        placeholders: dict[str, list[str]] = {}
        for index, block in enumerate(document.iter_inner_content()):
            block_id = f"b{index}"
            if isinstance(block, Paragraph):
                style = block.style.name if block.style else ""
                heading = re.fullmatch(r"Heading ([1-6])", style)
                entry: dict[str, Any] = {
                    "id": block_id,
                    "type": "heading" if heading else "paragraph",
                    "style": style,
                    "text": block.text if detail_level == "full" else block.text[:500],
                }
                if heading:
                    entry["level"] = int(heading.group(1))
                blocks.append(entry)
                for token in PLACEHOLDER_PATTERN.findall(block.text):
                    placeholders.setdefault(token, []).append(block_id)
            elif isinstance(block, Table):
                header = [cell.text[:200] for cell in block.rows[0].cells] if block.rows else []
                blocks.append(
                    {
                        "id": block_id,
                        "type": "table",
                        "rows": len(block.rows),
                        "cols": len(block.columns),
                        "header": header,
                    }
                )
        return {
            "file_id": file_id,
            "styles": sorted({style.name for style in document.styles}),
            "sections": len(document.sections),
            "blocks": blocks,
            "placeholders": [
                {"token": token, "occurrences": occurrences}
                for token, occurrences in placeholders.items()
            ],
        }

    async def apply(self, owner: str, request: DocxApplyRequest) -> ApplyResult:
        _, path = self.store.open_content(owner, request.file_id)
        document = Document(path)
        results: list[dict[str, Any]] = []
        for operation in request.operations:
            if operation.type in {"replace_placeholder", "replace_text"}:
                target = (
                    operation.placeholder
                    if operation.type == "replace_placeholder"
                    else operation.find
                )
                if not target:
                    raise ServiceError(
                        "INVALID_DOCUMENT", f"{operation.type} requires a target", 422
                    )
                count = self._replace_everywhere(document, target, operation.value or "")
                if count == 0:
                    raise ServiceError("ANCHOR_NOT_FOUND", f"Text was not found: {target}", 404)
                results.append({"type": operation.type, "status": "applied", "matches": count})
            elif operation.type == "set_properties":
                properties = operation.properties or {}
                for name, value in properties.items():
                    if name not in {
                        "title",
                        "author",
                        "subject",
                        "keywords",
                        "comments",
                        "category",
                    }:
                        raise ServiceError(
                            "UNSUPPORTED_FEATURE", f"Unsupported property: {name}", 422
                        )
                    setattr(document.core_properties, name, value)
                results.append(
                    {"type": operation.type, "status": "applied", "matches": len(properties)}
                )
        output = BytesIO()
        document.save(output)
        reference = await self.store.save_bytes(
            owner,
            self._ensure_suffix(request.output_name, ".docx"),
            DOCX_CONTENT_TYPE,
            output.getvalue(),
            parent_file_id=request.file_id,
        )
        return ApplyResult(file=reference, operations=results)

    def _load_markdown(self, owner: str, inline: str | None, file_id: str | None) -> str:
        if inline is not None:
            return inline
        if not file_id:
            raise ServiceError("INVALID_DOCUMENT", "Markdown input is required", 422)
        _, path = self.store.open_content(owner, file_id)
        return path.read_text(encoding="utf-8")

    def _render_markdown(self, document: DocumentObject, markdown: str) -> list[str]:
        tokens = self.markdown.parse(markdown)
        index = 0
        list_stack: list[str] = []
        while index < len(tokens):
            token = tokens[index]
            if token.type == "heading_open":
                text = tokens[index + 1].content
                document.add_heading(text, level=int(token.tag[1]))
                index += 3
                continue
            if token.type in {"bullet_list_open", "ordered_list_open"}:
                list_stack.append(token.type)
            elif token.type in {"bullet_list_close", "ordered_list_close"}:
                list_stack.pop()
            elif token.type == "paragraph_open":
                text = tokens[index + 1].content
                style = None
                if list_stack:
                    style = "List Bullet" if list_stack[-1] == "bullet_list_open" else "List Number"
                document.add_paragraph(text, style=style)
                index += 3
                continue
            elif token.type == "fence":
                document.add_paragraph(token.content, style="Normal")
            elif token.type == "hr":
                document.add_paragraph().add_run().add_break(WD_BREAK.PAGE)
            elif token.type == "table_open":
                index = self._render_table(document, tokens, index)
                continue
            elif token.type == "html_block" and "pagebreak" in token.content.lower():
                document.add_paragraph().add_run().add_break(WD_BREAK.PAGE)
            index += 1
        return []

    def _render_table(self, document: DocumentObject, tokens: list[Any], start: int) -> int:
        rows: list[list[str]] = []
        row: list[str] | None = None
        index = start + 1
        while tokens[index].type != "table_close":
            token = tokens[index]
            if token.type == "tr_open":
                row = []
            elif token.type in {"th_open", "td_open"} and row is not None:
                row.append(tokens[index + 1].content)
            elif token.type == "tr_close" and row is not None:
                rows.append(row)
                row = None
            index += 1
        if rows:
            table = document.add_table(rows=len(rows), cols=max(len(row) for row in rows))
            table.style = "Table Grid"
            for row_index, values in enumerate(rows):
                for column_index, value in enumerate(values):
                    table.cell(row_index, column_index).text = value
        return index + 1

    @staticmethod
    def _table_to_markdown(table: Table) -> list[str]:
        rows = [[cell.text.replace("|", "\\|") for cell in row.cells] for row in table.rows]
        if not rows:
            return []
        width = max(len(row) for row in rows)
        rows = [row + [""] * (width - len(row)) for row in rows]
        output = ["| " + " | ".join(rows[0]) + " |", "| " + " | ".join(["---"] * width) + " |"]
        output.extend("| " + " | ".join(row) + " |" for row in rows[1:])
        output.append("")
        return output

    def _replace_everywhere(self, document: DocumentObject, target: str, value: str) -> int:
        count = 0
        for paragraph in self._all_paragraphs(document):
            occurrences = paragraph.text.count(target)
            if not occurrences:
                continue
            replacement = paragraph.text.replace(target, value)
            if paragraph.runs:
                paragraph.runs[0].text = replacement
                for run in paragraph.runs[1:]:
                    run.text = ""
            else:
                paragraph.add_run(replacement)
            count += occurrences
        return count

    @staticmethod
    def _all_paragraphs(document: DocumentObject) -> list[Paragraph]:
        paragraphs = list(document.paragraphs)
        for table in document.tables:
            for row in table.rows:
                for cell in row.cells:
                    paragraphs.extend(cell.paragraphs)
        for section in document.sections:
            paragraphs.extend(section.header.paragraphs)
            paragraphs.extend(section.footer.paragraphs)
        return paragraphs

    @staticmethod
    def _clear_body(document: DocumentObject) -> None:
        body = document._element.body
        for child in list(body):
            if not child.tag.endswith("sectPr"):
                body.remove(child)

    @staticmethod
    def _ensure_suffix(name: str, suffix: str) -> str:
        return name if name.lower().endswith(suffix) else f"{name}{suffix}"
