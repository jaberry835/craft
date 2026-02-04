#!/usr/bin/env python3
import sys, subprocess, os, shutil, stat
from pathlib import Path

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

def main():
    if len(sys.argv) < 3:
        print("Usage: python add_repo.py <repo_url> <branch>")
        sys.exit(1)

    repo_url, branch = sys.argv[1], sys.argv[2]
    repo_name = os.path.splitext(os.path.basename(repo_url))[0]
    target_dir = f"{repo_name}-{branch}"

    if os.path.exists(target_dir):
        print(f"⚠️ Removing existing {target_dir}...")
        shutil.rmtree(target_dir, onerror=handle_remove_readonly)

    subprocess.run([
        "git", "clone", "--depth", "1",
        "--branch", branch, "--single-branch",
        repo_url, target_dir
    ], check=True)

    # Remove .git folder safely
    git_dir = os.path.join(target_dir, ".git")
    if os.path.exists(git_dir):
        shutil.rmtree(git_dir, onerror=handle_remove_readonly)
        print(f"🗑️ Removed {git_dir}")

    # Remove excluded file types (PDFs, videos, large binaries, Docker images, etc.)
    removed_count = 0
    removed_by_size = 0
    for root, dirs, files in os.walk(target_dir):
        for file in files:
            file_path = Path(root) / file
            should_remove = False
            reason = ""
            
            # Check by extension
            if file_path.suffix.lower() in EXCLUDE_EXTENSIONS:
                should_remove = True
                reason = f"type: {file_path.suffix}"
            # Check by specific filename
            elif file_path.name.lower() in EXCLUDE_FILENAMES:
                should_remove = True
                reason = "Docker image file"
            # Check by filename pattern
            elif any(pattern(file_path.name.lower()) for pattern in EXCLUDE_PATTERNS):
                should_remove = True
                reason = "Docker/container image"
            # Check by size (for unknown large files)
            elif file_path.stat().st_size > MAX_FILE_SIZE:
                should_remove = True
                reason = f"size: {file_path.stat().st_size / (1024*1024):.1f}MB"
                removed_by_size += 1
            
            if should_remove:
                file_path.unlink()
                removed_count += 1
                print(f"🗑️ Removed {file_path.relative_to(target_dir)} ({reason})")
    
    if removed_count > 0:
        print(f"✨ Removed {removed_count} file(s) total")
        if removed_by_size > 0:
            print(f"   ({removed_by_size} removed due to size >10MB)")
    else:
        print("✨ No files needed removal")

    subprocess.run(["git", "add", target_dir], check=True)
    subprocess.run(["git", "commit", "-m", f"Add/update {repo_name} ({branch})"], check=True)
    subprocess.run(["git", "push"], check=True)

    print(f"✅ Synced {repo_url} ({branch}) into curated repo as {target_dir}")

if __name__ == "__main__":
    main()
