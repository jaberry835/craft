#!/usr/bin/env python3
"""Calculate repository size with an optional top-level directory breakdown."""

from __future__ import annotations

import argparse
import json
import os
from collections import defaultdict
from pathlib import Path
from typing import DefaultDict


def format_bytes(num_bytes: int) -> str:
    """Return a human-readable file size string."""
    units = ["B", "KB", "MB", "GB", "TB", "PB"]
    value = float(num_bytes)
    for unit in units:
        if value < 1024 or unit == units[-1]:
            if unit == "B":
                return f"{int(value)} {unit}"
            return f"{value:.2f} {unit}"
        value /= 1024
    return f"{num_bytes} B"


def scan_repo(path: Path, include_git: bool, follow_symlinks: bool) -> dict:
    """Scan a directory tree and return size statistics."""
    total_size = 0
    file_count = 0
    dir_count = 0
    errors: list[str] = []
    top_level_sizes: DefaultDict[str, int] = defaultdict(int)

    for root, dirnames, filenames in os.walk(path, topdown=True, followlinks=follow_symlinks):
        if not include_git:
            dirnames[:] = [name for name in dirnames if name != ".git"]

        dir_count += len(dirnames)

        root_path = Path(root)
        for filename in filenames:
            file_path = root_path / filename
            try:
                stat_result = file_path.stat(follow_symlinks=follow_symlinks)
            except OSError as err:
                errors.append(f"{file_path}: {err}")
                continue

            size = stat_result.st_size
            total_size += size
            file_count += 1

            rel_parts = file_path.relative_to(path).parts
            top_key = "(root)" if len(rel_parts) == 1 else rel_parts[0]
            top_level_sizes[top_key] += size

    return {
        "path": str(path),
        "total_bytes": total_size,
        "total_files": file_count,
        "total_dirs": dir_count,
        "top_level_bytes": dict(sorted(top_level_sizes.items(), key=lambda item: item[1], reverse=True)),
        "errors": errors,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Calculate repository size with optional top-level directory breakdown."
    )
    parser.add_argument(
        "path",
        nargs="?",
        default=".",
        help="Path to scan (defaults to current directory).",
    )
    parser.add_argument(
        "--include-git",
        action="store_true",
        help="Include the .git directory in calculations.",
    )
    parser.add_argument(
        "--follow-symlinks",
        action="store_true",
        help="Follow symbolic links while scanning.",
    )
    parser.add_argument(
        "--top",
        type=int,
        default=10,
        help="Number of top-level entries to display (default: 10).",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Print full results as JSON.",
    )
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    scan_path = Path(args.path).resolve()
    if not scan_path.exists():
        raise SystemExit(f"Path does not exist: {scan_path}")
    if not scan_path.is_dir():
        raise SystemExit(f"Path is not a directory: {scan_path}")
    if args.top < 1:
        raise SystemExit("--top must be at least 1")

    result = scan_repo(
        scan_path,
        include_git=args.include_git,
        follow_symlinks=args.follow_symlinks,
    )

    if args.json:
        print(json.dumps(result, indent=2))
        return

    print(f"Repository: {result['path']}")
    print(f"Total size: {format_bytes(result['total_bytes'])} ({result['total_bytes']} bytes)")
    print(f"Files: {result['total_files']}")
    print(f"Directories: {result['total_dirs']}")
    print()
    print(f"Top-level entries by size (top {args.top}):")

    for name, size in list(result["top_level_bytes"].items())[: args.top]:
        print(f"  {name}: {format_bytes(size)} ({size} bytes)")

    if result["errors"]:
        print()
        print(f"Warnings: skipped {len(result['errors'])} path(s).")
        for error in result["errors"][:5]:
            print(f"  - {error}")
        if len(result["errors"]) > 5:
            print("  - ...")


if __name__ == "__main__":
    main()
