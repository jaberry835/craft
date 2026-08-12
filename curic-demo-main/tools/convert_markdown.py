import argparse
import asyncio
import html
from pathlib import Path
import sys

import markdown
from playwright.async_api import async_playwright
import pypandoc


VALID_FORMATS = {"docx", "pdf", "both"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--path", "-p", default=".")
    parser.add_argument("--format", "-f", default="both", choices=sorted(VALID_FORMATS))
    parser.add_argument("--recurse", action="store_true")
    parser.add_argument("--overwrite", action="store_true")
    return parser.parse_args()


def collect_markdown_files(target: Path, recurse: bool) -> list[Path]:
    if not target.exists():
        raise FileNotFoundError(f"Path not found: {target}")

    if target.is_file():
        if target.suffix.lower() != ".md":
            raise ValueError(f"Target file must be a Markdown file: {target}")
        return [target.resolve()]

    pattern = "**/*.md" if recurse else "*.md"
    return sorted(path.resolve() for path in target.glob(pattern) if path.is_file())


def convert_to_docx(markdown_file: Path, overwrite: bool) -> None:
    output_path = markdown_file.with_suffix(".docx")
    if output_path.exists() and not overwrite:
        print(f"Skipping existing DOCX: {output_path}")
        return

    pypandoc.convert_file(
        str(markdown_file),
        "docx",
        format="gfm",
        outputfile=str(output_path),
    )
    print(f"Created DOCX: {output_path}")


def infer_direction(markdown_source: str) -> str:
    for char in markdown_source:
        if "\u0600" <= char <= "\u06FF":
            return "rtl"
    return "ltr"


def build_html(markdown_source: str, file_name: str) -> str:
    direction = infer_direction(markdown_source)
    title = file_name
    for line in markdown_source.splitlines():
        if line.startswith("# "):
            title = line[2:].strip()
            break

    body = markdown.markdown(
        markdown_source,
        extensions=["extra", "tables", "fenced_code", "toc"],
        output_format="html5",
    )

    return f"""<!doctype html>
<html lang=\"en\" dir=\"{direction}\">
<head>
  <meta charset=\"utf-8\">
  <title>{html.escape(title)}</title>
  <style>
    @page {{
      size: letter;
      margin: 0.7in;
    }}
    body {{
      font-family: "Segoe UI", "Noto Naskh Arabic", Arial, sans-serif;
      color: #111827;
      line-height: 1.55;
      font-size: 11pt;
      unicode-bidi: plaintext;
    }}
    h1, h2, h3, h4, h5, h6 {{
      color: #0f172a;
      line-height: 1.2;
      margin-top: 1.1em;
      margin-bottom: 0.45em;
    }}
    h1 {{
      border-bottom: 1px solid #cbd5e1;
      padding-bottom: 0.2em;
    }}
    p, ul, ol, table, blockquote {{
      margin-top: 0.5em;
      margin-bottom: 0.5em;
    }}
    table {{
      border-collapse: collapse;
      width: 100%;
    }}
    th, td {{
      border: 1px solid #cbd5e1;
      padding: 0.4em 0.55em;
      text-align: start;
      vertical-align: top;
    }}
    th {{
      background: #f8fafc;
    }}
    code {{
      font-family: Consolas, "Cascadia Code", monospace;
      font-size: 0.95em;
      background: #f8fafc;
      padding: 0.1em 0.25em;
      border-radius: 4px;
    }}
    pre code {{
      display: block;
      padding: 0.75em;
      overflow-wrap: anywhere;
      white-space: pre-wrap;
    }}
    blockquote {{
      border-inline-start: 4px solid #cbd5e1;
      padding-inline-start: 0.8em;
      color: #334155;
      margin-inline-start: 0;
    }}
  </style>
</head>
<body>
{body}
</body>
</html>
"""


async def convert_to_pdf(markdown_file: Path, overwrite: bool) -> None:
    output_path = markdown_file.with_suffix(".pdf")
    if output_path.exists() and not overwrite:
        print(f"Skipping existing PDF: {output_path}")
        return

    markdown_source = markdown_file.read_text(encoding="utf-8")
    html_document = build_html(markdown_source, markdown_file.stem)

    try:
        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch()
            page = await browser.new_page()
            await page.set_content(html_document, wait_until="networkidle")
            await page.pdf(
                path=str(output_path),
                format="Letter",
                print_background=True,
                margin={
                    "top": "0.7in",
                    "right": "0.7in",
                    "bottom": "0.7in",
                    "left": "0.7in",
                },
            )
            await browser.close()
    except Exception as error:
        message = str(error)
        if "Executable doesn't exist" in message:
            raise RuntimeError(
                "Playwright browser is not installed. Run 'python -m playwright install chromium' first."
            ) from error
        raise

    print(f"Created PDF: {output_path}")


async def main() -> int:
    args = parse_args()
    files = collect_markdown_files(Path(args.path), args.recurse)
    if not files:
        print("No Markdown files found.")
        return 0

    for markdown_file in files:
        if args.format in {"docx", "both"}:
            convert_to_docx(markdown_file, args.overwrite)

        if args.format in {"pdf", "both"}:
            await convert_to_pdf(markdown_file, args.overwrite)

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(asyncio.run(main()))
    except Exception as error:
        print(error, file=sys.stderr)
        raise SystemExit(1)