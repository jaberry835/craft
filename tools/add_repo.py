#!/usr/bin/env python3
import sys, subprocess, os, shutil, stat, tempfile, filecmp
from pathlib import Path
from urllib.parse import urlparse

# File extensions to exclude (images are allowed)
EXCLUDE_EXTENSIONS = {
    # Documents
    '.pdf',
    # Video files
    '.mp4', '.avi', '.mov', '.mkv', '.webm', '.flv', '.wmv', '.m4v', '.mpg', '.mpeg',
    '.3gp', '.3g2', '.h264', '.m2v', '.mts', '.ogv', '.vob',
    # Audio files
    '.mp3', '.wav', '.flac', '.aac', '.ogg', '.wma', '.m4a', '.opus',
    # Archives
    '.zip', '.tar', '.gz', '.7z', '.rar', '.bz2', '.xz', '.tgz', '.tbz2',
    # Executables and compiled binaries
    '.exe', '.dll', '.so', '.dylib', '.bin', '.o', '.obj', '.lib', '.a',
    '.class', '.pyc', '.pyo', '.pyd',
    # Installers and packages
    '.dmg', '.msi', '.deb', '.rpm', '.apk', '.app', '.pkg',
    # Database files
    '.db', '.sqlite', '.sqlite3', '.mdb',
    # Office files (large binaries)
    '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.vsdx',
    # Container images
    '.docker', '.oci', '.img', '.qcow2', '.vmdk', '.vdi', '.vhd',
    # Test snapshots
    '.snap'
}

# Specific filenames to exclude (Docker images often saved without extensions)
EXCLUDE_FILENAMES = {
    'docker-image.tar',
    'image.tar',
}

# Filename patterns that indicate Docker/container images
EXCLUDE_PATTERNS = [
    lambda name: name.endswith('-image.tar'),
    lambda name: name.startswith('docker-') and '.tar' in name,
]

# Size threshold for binary detection (10MB)
MAX_FILE_SIZE = 10 * 1024 * 1024

def handle_remove_readonly(func, path, exc):
    excvalue = exc[1]
    if func in (os.unlink, os.rmdir):
        os.chmod(path, stat.S_IWRITE)
        func(path)


def derive_repo_name(source: str) -> str:
    if os.path.exists(source):
        source_path = Path(source)
        if source_path.is_file():
            return source_path.stem
        return source_path.name

    parsed = urlparse(source)
    source_tail = os.path.basename((parsed.path or source).rstrip("/"))
    if source_tail.endswith('.git'):
        source_tail = source_tail[:-4]

    repo_name = os.path.splitext(source_tail)[0]
    return repo_name or "imported-repo"


def copy_local_source(source: str, target_dir: str) -> None:
    source_path = Path(source)
    if source_path.is_dir():
        shutil.copytree(source_path, target_dir, symlinks=True)
        return

    if source_path.is_file() and source_path.suffix.lower() == ".zip":
        with tempfile.TemporaryDirectory(prefix="add_repo_extract_") as extract_dir:
            shutil.unpack_archive(str(source_path), extract_dir)
            root_entries = [
                Path(extract_dir) / entry
                for entry in os.listdir(extract_dir)
                if entry != "__MACOSX"
            ]

            if len(root_entries) == 1 and root_entries[0].is_dir():
                source_root = root_entries[0]
            else:
                source_root = Path(extract_dir)

            shutil.copytree(source_root, target_dir, symlinks=True)
        return

    raise ValueError(
        f"Unsupported local source: {source}. Expected a directory or .zip file."
    )

def should_exclude(file_path: Path) -> tuple:
    """Check if a file should be excluded. Returns (should_remove, reason)."""
    # Check by extension
    if file_path.suffix.lower() in EXCLUDE_EXTENSIONS:
        return True, f"type: {file_path.suffix}"
    # Check by specific filename
    if file_path.name.lower() in EXCLUDE_FILENAMES:
        return True, "Docker image file"
    # Check by filename pattern
    if any(pattern(file_path.name.lower()) for pattern in EXCLUDE_PATTERNS):
        return True, "Docker/container image"
    # Check by size (for unknown large files)
    try:
        size = file_path.stat().st_size
        if size > MAX_FILE_SIZE:
            return True, f"size: {size / (1024*1024):.1f}MB"
    except OSError:
        pass
    return False, ""


def sync_directories(fresh_dir: str, target_dir: str) -> dict:
    """Incrementally sync fresh_dir into target_dir.
    Only copies new/changed files and removes deleted files.
    Returns stats dict with counts."""
    stats = {"added": 0, "updated": 0, "removed": 0, "unchanged": 0, "excluded": 0}
    fresh_path = Path(fresh_dir)
    target_path = Path(target_dir)

    # Build set of all relative paths in the fresh source (after exclusions)
    fresh_files = set()
    for root, dirs, files in os.walk(fresh_path):
        for file in files:
            fp = Path(root) / file
            rel = fp.relative_to(fresh_path)
            exclude, reason = should_exclude(fp)
            if exclude:
                fp.unlink()
                stats["excluded"] += 1
                print(f"🗑️ Excluded {rel} ({reason})")
                continue
            fresh_files.add(rel)

    # Copy new or changed files
    for rel in sorted(fresh_files):
        src_file = fresh_path / rel
        dst_file = target_path / rel

        if not dst_file.exists():
            # New file
            dst_file.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src_file, dst_file)
            stats["added"] += 1
            print(f"  ➕ Added {rel}")
        elif not filecmp.cmp(str(src_file), str(dst_file), shallow=False):
            # File content changed
            shutil.copy2(src_file, dst_file)
            stats["updated"] += 1
            print(f"  ✏️ Updated {rel}")
        else:
            stats["unchanged"] += 1

    # Remove files that no longer exist in source
    if target_path.exists():
        for root, dirs, files in os.walk(target_path):
            for file in files:
                fp = Path(root) / file
                rel = fp.relative_to(target_path)
                if rel not in fresh_files:
                    fp.unlink()
                    stats["removed"] += 1
                    print(f"  🗑️ Removed {rel}")

        # Clean up empty directories
        for root, dirs, files in os.walk(target_path, topdown=False):
            for d in dirs:
                dp = Path(root) / d
                if dp.exists() and not any(dp.iterdir()):
                    dp.rmdir()

    return stats


def main():
    if len(sys.argv) < 3:
        print("Usage: python add_repo.py <repo_url|local_path|archive.zip> <branch>")
        sys.exit(1)

    source, branch = sys.argv[1], sys.argv[2]
    repo_name = derive_repo_name(source)
    target_dir = f"{repo_name}-{branch}"

    # Clone/copy into a temp directory first
    with tempfile.TemporaryDirectory(prefix="add_repo_sync_") as tmp_dir:
        fresh_dir = os.path.join(tmp_dir, "fresh")

        if os.path.exists(source):
            print(f"📦 Importing local source {source}...")
            copy_local_source(source, fresh_dir)
        else:
            print(f"📥 Cloning {source} ({branch})...")
            subprocess.run([
                "git", "clone", "--depth", "1",
                "--branch", branch, "--single-branch",
                source, fresh_dir
            ], check=True)

        # Remove .git folder from fresh clone
        git_dir = os.path.join(fresh_dir, ".git")
        if os.path.exists(git_dir):
            shutil.rmtree(git_dir, onerror=handle_remove_readonly)

        # Incremental sync: only update what actually changed
        is_new = not os.path.exists(target_dir)
        if is_new:
            print(f"🆕 Creating {target_dir} (first import)...")
            os.makedirs(target_dir, exist_ok=True)
        else:
            print(f"🔄 Syncing changes into {target_dir}...")

        stats = sync_directories(fresh_dir, target_dir)

    # Summary
    print(f"\n📊 Sync summary:")
    print(f"   Added:     {stats['added']}")
    print(f"   Updated:   {stats['updated']}")
    print(f"   Removed:   {stats['removed']}")
    print(f"   Unchanged: {stats['unchanged']}")
    if stats['excluded'] > 0:
        print(f"   Excluded:  {stats['excluded']}")

    total_changes = stats['added'] + stats['updated'] + stats['removed']
    if total_changes == 0:
        print("\n✅ Already up to date — nothing to commit.")
        return

    subprocess.run(["git", "add", target_dir], check=True)
    subprocess.run(["git", "commit", "-m", f"Add/update {repo_name} ({branch})"], check=True)
    subprocess.run(["git", "push"], check=True)

    print(f"✅ Synced {source} ({branch}) into curated repo as {target_dir}")

if __name__ == "__main__":
    main()
