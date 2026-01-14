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
    temp_dir = f"{target_dir}.tmp"

    # Clean up any leftover temp directory
    if os.path.exists(temp_dir):
        shutil.rmtree(temp_dir, onerror=handle_remove_readonly)

    # Clone to temporary directory
    print(f"📥 Cloning {repo_url} ({branch}) to temporary location...")
    subprocess.run([
        "git", "clone", "--depth", "1",
        "--branch", branch, "--single-branch",
        repo_url, temp_dir
    ], check=True)

    # Remove .git folder from temp directory
    git_dir = os.path.join(temp_dir, ".git")
    if os.path.exists(git_dir):
        shutil.rmtree(git_dir, onerror=handle_remove_readonly)
        print(f"🗑️ Removed {git_dir}")

    # Scan for files to exclude (PDFs, videos, large binaries, Docker images, etc.)
    files_to_remove = []
    
    for root, dirs, files in os.walk(temp_dir):
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
            
            if should_remove:
                files_to_remove.append((file_path, reason))
    
    # Display summary
    if files_to_remove:
        print(f"\n📋 Found {len(files_to_remove)} file(s) to exclude:")
        print("=" * 70)
        
        # Group by reason
        by_type = {}
        for file_path, reason in files_to_remove:
            if reason not in by_type:
                by_type[reason] = []
            by_type[reason].append(file_path.relative_to(temp_dir))
        
        for reason, paths in sorted(by_type.items()):
            print(f"\n{reason.upper()}: ({len(paths)} files)")
            for path in paths[:10]:  # Show first 10 of each type
                print(f"  - {path}")
            if len(paths) > 10:
                print(f"  ... and {len(paths) - 10} more")
        
        print("\n" + "=" * 70)
        print(f"\n⚠️  Total: {len(files_to_remove)} file(s) will be excluded")
    else:
        print("\n✨ No files need to be excluded")
    
    # Ask for confirmation
    is_update = os.path.exists(target_dir)
    action = "update" if is_update else "add"
    print(f"\n📁 Repository will be {action}d as: {target_dir}")
    response = input("\n❓ Proceed with commit and push? (yes/no): ").strip().lower()
    
    if response not in ['yes', 'y']:
        print(f"\n❌ Aborting. Cleaning up {temp_dir}...")
        shutil.rmtree(temp_dir, onerror=handle_remove_readonly)
        print("✅ Cleanup complete. No changes were committed.")
        sys.exit(0)
    
    # User confirmed - now remove the excluded files from temp
    removed_count = 0
    for file_path, reason in files_to_remove:
        file_path.unlink()
        removed_count += 1
    
    if removed_count > 0:
        print(f"\n🗑️  Removed {removed_count} file(s)")
    
    # Sync temp directory to target directory
    if is_update:
        print(f"\n🔄 Syncing changes to {target_dir}...")
        # Use rsync to sync directories (copies new, updates modified, deletes removed)
        # -i flag provides itemized change output
        rsync_result = subprocess.run([
            "rsync", "-a", "--delete", "-i",
            f"{temp_dir}/", f"{target_dir}/"
        ], check=True, capture_output=True, text=True)
        
        # Parse rsync output to count changes
        new_files = []
        modified_files = []
        deleted_files = []
        
        for line in rsync_result.stdout.strip().split('\n'):
            if not line:
                continue
            # rsync itemized output format: first char indicates file type, next chars indicate changes
            # >f++++++++ = new file
            # >f.st...... = modified file (size or time changed)
            # *deleting = deleted file
            if line.startswith('*deleting'):
                deleted_files.append(line.replace('*deleting ', '').strip())
            elif line.startswith('>f'):
                filename = line[12:].strip() if len(line) > 12 else line
                if '++++++' in line:
                    new_files.append(filename)
                else:
                    modified_files.append(filename)
        
        # Display sync summary
        total_synced = len(new_files) + len(modified_files) + len(deleted_files)
        
        if total_synced > 0:
            print(f"\n📊 Sync Summary:")
            print("=" * 70)
            
            if new_files:
                print(f"\n✨ NEW FILES ({len(new_files)}):")
                for f in new_files[:10]:
                    print(f"  + {f}")
                if len(new_files) > 10:
                    print(f"  ... and {len(new_files) - 10} more")
            
            if modified_files:
                print(f"\n📝 MODIFIED FILES ({len(modified_files)}):")
                for f in modified_files[:10]:
                    print(f"  ~ {f}")
                if len(modified_files) > 10:
                    print(f"  ... and {len(modified_files) - 10} more")
            
            if deleted_files:
                print(f"\n🗑️  DELETED FILES ({len(deleted_files)}):")
                for f in deleted_files[:10]:
                    print(f"  - {f}")
                if len(deleted_files) > 10:
                    print(f"  ... and {len(deleted_files) - 10} more")
            
            print("\n" + "=" * 70)
            print(f"Total: {total_synced} file(s) synced")
        else:
            print(f"✅ No file changes during sync")
        
        print(f"✅ Synced to {target_dir}")
    else:
        print(f"\n📁 Creating new directory {target_dir}...")
        shutil.move(temp_dir, target_dir)
        print(f"✅ Created {target_dir}")
    
    # Clean up temp directory if it still exists
    if os.path.exists(temp_dir):
        shutil.rmtree(temp_dir, onerror=handle_remove_readonly)
    
    # Stage all changes (additions, modifications, deletions)
    print(f"\n📝 Staging changes...")
    subprocess.run(["git", "add", "-A", target_dir], check=True)
    
    # Check if there are any changes to commit
    result = subprocess.run(
        ["git", "diff", "--cached", "--quiet", target_dir],
        capture_output=True
    )
    
    if result.returncode == 0:
        print(f"\n✨ No changes detected in {target_dir}")
        print("✅ Repository is already up to date!")
        sys.exit(0)
    
    # Show what files are changing
    print(f"\n📋 Changes to be committed:")
    print("=" * 70)
    diff_result = subprocess.run(
        ["git", "diff", "--cached", "--name-status", target_dir],
        capture_output=True,
        text=True,
        check=True
    )
    
    # Parse and display changes by type
    changes = {'A': [], 'M': [], 'D': []}
    for line in diff_result.stdout.strip().split('\n'):
        if line:
            parts = line.split('\t', 1)
            if len(parts) == 2:
                status, filepath = parts
                # Remove target_dir prefix for cleaner display
                display_path = filepath.replace(f"{target_dir}/", "", 1)
                if status in changes:
                    changes[status].append(display_path)
    
    total_changes = sum(len(files) for files in changes.values())
    
    if changes['A']:
        print(f"\n✨ NEW FILES ({len(changes['A'])}):")
        for path in changes['A'][:20]:
            print(f"  + {path}")
        if len(changes['A']) > 20:
            print(f"  ... and {len(changes['A']) - 20} more")
    
    if changes['M']:
        print(f"\n📝 MODIFIED FILES ({len(changes['M'])}):")
        for path in changes['M'][:20]:
            print(f"  ~ {path}")
        if len(changes['M']) > 20:
            print(f"  ... and {len(changes['M']) - 20} more")
    
    if changes['D']:
        print(f"\n🗑️  DELETED FILES ({len(changes['D'])}):")
        for path in changes['D'][:20]:
            print(f"  - {path}")
        if len(changes['D']) > 20:
            print(f"  ... and {len(changes['D']) - 20} more")
    
    print("\n" + "=" * 70)
    print(f"Total: {total_changes} file(s) changed\n")
    
    # Commit and push
    commit_msg = f"Update {repo_name} ({branch})" if is_update else f"Add {repo_name} ({branch})"
    subprocess.run(["git", "commit", "-m", commit_msg], check=True)
    subprocess.run(["git", "push"], check=True)

    action_past = "updated" if is_update else "added"
    print(f"\n✅ Successfully {action_past} {repo_url} ({branch}) as {target_dir}")

if __name__ == "__main__":
    main()
