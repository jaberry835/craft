#!/usr/bin/env python3
import sys, subprocess, os, shutil, stat, tempfile, filecmp, json
from datetime import datetime, timezone
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
SYNC_STATE_FILE = ".add_repo_sync_state.json"


def get_github_token() -> str | None:
    token = os.environ.get("ADD_REPO_GITHUB_TOKEN")
    if token:
        return token.strip()
    return None


def is_github_https_source(source: str) -> bool:
    if os.path.exists(source):
        return False
    parsed = urlparse(source)
    return parsed.scheme == "https" and parsed.hostname in {"github.com", "www.github.com"}


def setup_gh_git_credentials() -> None:
    try:
        subprocess.run(
            ["gh", "auth", "setup-git"],
            capture_output=True,
            text=True,
            check=False,
        )
    except FileNotFoundError:
        pass


def build_git_source_with_auth(source: str) -> str:
    if not is_github_https_source(source):
        return source

    parsed = urlparse(source)

    if parsed.username:
        return source

    token = get_github_token()
    if not token:
        return source

    auth_netloc = f"x-access-token:{token}@{parsed.hostname}"
    if parsed.port:
        auth_netloc = f"{auth_netloc}:{parsed.port}"
    return parsed._replace(netloc=auth_netloc).geturl()


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


def make_sync_key(source: str, branch: str) -> str:
    if os.path.exists(source):
        return f"local::{Path(source).resolve()}::{branch}"
    return f"remote::{source}::{branch}"


def load_sync_state(state_path: Path) -> dict:
    if not state_path.exists():
        return {}
    try:
        with state_path.open("r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            return data
    except (OSError, json.JSONDecodeError):
        pass
    return {}


def save_sync_state(state_path: Path, state: dict) -> None:
    with state_path.open("w", encoding="utf-8") as f:
        json.dump(state, f, indent=2, sort_keys=True)
        f.write("\n")


def get_remote_branch_head(source: str, branch: str) -> str:
    result = subprocess.run(
        ["git", "ls-remote", source, f"refs/heads/{branch}"],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        reason = (result.stderr or result.stdout or "git ls-remote failed").strip()
        raise RuntimeError(reason)
    output = result.stdout.strip()
    if not output:
        raise ValueError(f"Branch '{branch}' not found for {source}")
    return output.split()[0]


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


README_PATH = Path("README.md")


def append_readme_log(repo_name: str, branch: str, stats: dict) -> bool:
    """Append a sync-log row to the root README.md. Returns True if written."""
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    parts = []
    if stats["added"]:
        parts.append(f"+{stats['added']}")
    if stats["updated"]:
        parts.append(f"~{stats['updated']}")
    if stats["removed"]:
        parts.append(f"-{stats['removed']}")
    changes = ", ".join(parts) if parts else "no changes"
    row = f"| {now} | {repo_name} | {branch} | {changes} |\n"

    if not README_PATH.exists():
        header = (
            "# curated\nCurated Demo Code\n\n"
            "## Sync Log\n\n"
            "| Date | Project | Branch | Changes |\n"
            "|------|---------|--------|---------|\n"
        )
        README_PATH.write_text(header + row, encoding="utf-8")
        return True

    content = README_PATH.read_text(encoding="utf-8")
    if content.rstrip().endswith("|"):
        # Table already has rows — just append
        README_PATH.write_text(content.rstrip("\n") + "\n" + row, encoding="utf-8")
    else:
        # No table yet — add one
        content = content.rstrip("\n") + "\n\n## Sync Log\n\n"
        content += "| Date | Project | Branch | Changes |\n"
        content += "|------|---------|--------|---------|\n"
        content += row
        README_PATH.write_text(content, encoding="utf-8")
    return True


def parse_args():
    import argparse
    parser = argparse.ArgumentParser(
        description="Add or sync a repo into the curated workspace."
    )
    parser.add_argument("source", help="Git repo URL, local directory, or .zip file")
    parser.add_argument("branch", help="Branch name to clone")
    parser.add_argument(
        "--tmp-dir",
        default=None,
        help="Directory to use for temp files (default: system temp)"
    )
    return parser.parse_args()


def main():
    args = parse_args()
    source, branch = args.source, args.branch
    if is_github_https_source(source):
        setup_gh_git_credentials()
    git_source = build_git_source_with_auth(source)
    tmp_base = args.tmp_dir
    repo_name = derive_repo_name(source)
    target_dir = f"{repo_name}-{branch}"
    state_path = Path(SYNC_STATE_FILE)
    sync_state = load_sync_state(state_path)
    sync_key = make_sync_key(source, branch)

    remote_head = None
    if not os.path.exists(source) and os.path.exists(target_dir):
        try:
            remote_head = get_remote_branch_head(git_source, branch)
            last_synced_head = sync_state.get(sync_key)
            if last_synced_head == remote_head:
                print("✅ No remote changes detected — skipping clone and sync.")
                return
        except (RuntimeError, ValueError) as e:
            print(f"⚠️ Could not pre-check remote HEAD ({e}). Continuing with full sync...")

    # Clone/copy into a temp directory first
    if tmp_base:
        os.makedirs(tmp_base, exist_ok=True)
        print(f"📂 Using temp directory base: {tmp_base}")
    with tempfile.TemporaryDirectory(prefix="add_repo_sync_", dir=tmp_base) as tmp_dir:
        fresh_dir = os.path.join(tmp_dir, "fresh")

        if os.path.exists(source):
            print(f"📦 Importing local source {source}...")
            copy_local_source(source, fresh_dir)
        else:
            print(f"📥 Cloning {source} ({branch})...")
            try:
                subprocess.run([
                    "git", "clone", "--depth", "1",
                    "--branch", branch, "--single-branch",
                    git_source, fresh_dir
                ], check=True)
            except subprocess.CalledProcessError:
                if is_github_https_source(source):
                    print("❌ Clone failed for GitHub repo.")
                    print("   If this is private, authenticate with a token that has repo read access,")
                    print("   then either run `gh auth login --with-token` or set ADD_REPO_GITHUB_TOKEN.")
                else:
                    print("❌ Clone failed.")
                sys.exit(1)

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
        # No file changes — save sync state but do NOT commit anything
        if remote_head:
            sync_state[sync_key] = remote_head
            save_sync_state(state_path, sync_state)
        print("\n✅ Already up to date — nothing to commit.")
        return

    # --- Real changes: log to README, stage everything, single commit ---
    append_readme_log(repo_name, branch, stats)

    # Resolve remote_head now if we don't have it yet
    if not remote_head and not os.path.exists(source):
        try:
            remote_head = get_remote_branch_head(git_source, branch)
        except (RuntimeError, ValueError):
            remote_head = None
    if remote_head:
        sync_state[sync_key] = remote_head
        save_sync_state(state_path, sync_state)

    # Stage only the target dir, README, and sync state — nothing else
    subprocess.run(["git", "add", target_dir], check=True)
    subprocess.run(["git", "add", str(README_PATH)], check=True)
    subprocess.run(["git", "add", SYNC_STATE_FILE], check=True)

    # Double-check git actually has staged changes before committing
    diff = subprocess.run(["git", "diff", "--cached", "--quiet"])
    if diff.returncode == 0:
        print("\n✅ Nothing staged — skipping commit.")
        return

    subprocess.run(["git", "commit", "-m", f"Add/update {repo_name} ({branch})"], check=True)
    subprocess.run(["git", "push"], check=True)

    print(f"✅ Synced {source} ({branch}) into curated repo as {target_dir}")

if __name__ == "__main__":
    main()
