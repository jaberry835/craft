# Tools

## Markdown Conversion

Use [tools/Convert-Markdown.ps1](tools/Convert-Markdown.ps1) or [tools/convert_markdown.py](tools/convert_markdown.py) to generate `.docx` and `.pdf` files next to your Markdown sources.

### What it does
- Converts a single Markdown file or an entire folder.
- Writes output beside each `.md` file.
- Supports `docx`, `pdf`, or `both`.
- Uses a PyPI-managed Pandoc binary for `.docx` output.
- Uses Python Playwright with Chromium for `.pdf` output.

### Prerequisites
- Python must be installed.

### Setup

From the workspace root:

```powershell
python -m pip install -r .\tools\requirements.txt
python -m playwright install chromium
```

This installs all conversion dependencies through PyPI. No system Pandoc, LaTeX, or Microsoft Word install is required.

### Examples
Convert one file to Word and PDF:

```powershell
.\tools\Convert-Markdown.ps1 -Path .\Arabic-ILR3-Curriculum-Development\02-Proficiency-Framework\learning-objectives.md -Format both
```

Convert all curriculum Markdown files recursively to Word only:

```powershell
.\tools\Convert-Markdown.ps1 -Path .\Arabic-ILR3-Curriculum-Development -Format docx -Recurse
```

Convert all curriculum Markdown files recursively and overwrite existing outputs:

```powershell
.\tools\Convert-Markdown.ps1 -Path .\Arabic-ILR3-Curriculum-Development -Format both -Recurse -Overwrite
```

Run the Python entry point directly:

```powershell
python .\tools\convert_markdown.py --path .\Arabic-ILR3-Curriculum-Development --format pdf --recurse
```

### Notes
- The script does not modify the original Markdown files.
- Existing `.docx` and `.pdf` files are skipped unless `-Overwrite` is set.
- If Python dependencies are missing, the script stops with a clear error message.
- Playwright needs a one-time browser install via `python -m playwright install chromium`.