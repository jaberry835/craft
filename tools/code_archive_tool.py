#!/usr/bin/env python3
"""
Code Archive Tool - Pack and unpack code files with .txt extensions

This tool helps create archives of code files by:
1. Adding .txt extensions to code files (making them viewable as plain text)
2. Creating a zip archive
3. Unpacking and restoring original extensions

Only processes files that are tracked by git (checked in).
"""

import os
import sys
import shutil
import tarfile
import subprocess
import argparse
from pathlib import Path
from typing import List, Set

# Define code file extensions to process
CODE_EXTENSIONS = {
    '.cs', '.py', '.md', '.tsx', '.ts', '.jsx', '.js', 
    '.css', '.scss', '.sass', '.less',
    '.json', '.xml', '.yaml', '.yml',
    '.ps1', '.sh', '.bat', '.cmd',
    '.html', '.htm',
    '.java', '.cpp', '.c', '.h', '.hpp',
    '.go', '.rs', '.rb', '.php',
    '.sql', '.graphql', '.proto',
    '.conf', '.config', '.ini', '.toml',
    '.dockerfile', '.gitignore', '.gitattributes',
    '.txt', '.log',
    # Additional extensions
    '.lock', '.text',
    '.example', '.env',
    '.csproj', '.sln',
    '.bicep', '.bicepparam', '.tf',
    '.kql', '.http',
    '.map', '.mjs', '.cjs'
}

# Image file extensions (can be optionally included)
IMAGE_EXTENSIONS = {
    '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.ico', '.webp', '.tiff', '.tif', '.svg'
}

# Font file extensions (can be optionally included)
FONT_EXTENSIONS = {
    '.ttf', '.woff', '.woff2', '.eot', '.otf'
}

# File extensions to always exclude (binaries, archives, media)
EXCLUDE_EXTENSIONS = {
    # Archives
    '.pdf', '.zip', '.tar', '.gz', '.7z', '.rar', '.bz2', '.xz',
    # Executables and binaries
    '.exe', '.dll', '.so', '.dylib', '.bin', '.o', '.obj', '.lib', '.a',
    '.app', '.msi', '.dmg', '.deb', '.rpm', '.apk',
    # Media (video/audio)
    '.mp4', '.avi', '.mov', '.mp3', '.wav', '.flac', '.ogg', '.webm', '.mkv',
    # Test snapshots and office files
    '.snap', '.vsdx'
}

# Track all known extensions
KNOWN_EXTENSIONS = CODE_EXTENSIONS | IMAGE_EXTENSIONS | FONT_EXTENSIONS | EXCLUDE_EXTENSIONS


def get_git_tracked_files(directory: str) -> Set[str]:
    """
    Get all files tracked by git in the given directory.
    
    Args:
        directory: The git repository directory
        
    Returns:
        Set of relative file paths tracked by git
    """
    try:
        result = subprocess.run(
            ['git', 'ls-files'],
            cwd=directory,
            capture_output=True,
            text=True,
            check=True
        )
        files = set(result.stdout.strip().split('\n'))
        return {f for f in files if f}  # Remove empty strings
    except subprocess.CalledProcessError as e:
        print(f"Error: Failed to get git tracked files: {e}")
        sys.exit(1)
    except FileNotFoundError:
        print("Error: git command not found. Make sure git is installed.")
        sys.exit(1)


def get_all_files(directory: str) -> Set[str]:
    """
    Get all files in a directory recursively.
    
    Args:
        directory: The directory to scan
        
    Returns:
        Set of relative file paths
    """
    directory_path = Path(directory)
    files = set()
    
    for file_path in directory_path.rglob('*'):
        if file_path.is_file():
            # Skip hidden directories and common ignore patterns
            if any(part.startswith('.') and part not in ['.env', '.env.example', '.env.sample'] 
                   for part in file_path.parts[len(directory_path.parts):]):
                continue
            
            rel_path = file_path.relative_to(directory_path)
            files.add(str(rel_path))
    
    return files


def should_process_file(file_path: str, full_path: Path = None, include_images: bool = False, include_fonts: bool = False) -> bool:
    """
    Determine if a file should be processed based on its extension.
    
    Args:
        file_path: Path to the file
        full_path: Optional full path to check if file is executable
        include_images: Whether to include image files
        include_fonts: Whether to include font files
        
    Returns:
        True if file should be processed, False otherwise
    """
    path = Path(file_path)
    ext = path.suffix.lower()
    
    # Always exclude these extensions (binaries, archives, media)
    if ext in EXCLUDE_EXTENSIONS:
        return False
    
    # Handle images based on flag
    if ext in IMAGE_EXTENSIONS:
        return include_images
    
    # Handle fonts based on flag
    if ext in FONT_EXTENSIONS:
        return include_fonts
    
    # Check if file is executable binary (Unix systems)
    if full_path and full_path.exists():
        # If file has no extension and is executable, likely a binary
        if not ext and os.access(full_path, os.X_OK):
            # Allow known script files without extensions
            allowed_no_ext = {'Dockerfile', 'Makefile', 'Jenkinsfile', 'Vagrantfile'}
            if path.name not in allowed_no_ext:
                try:
                    # Check if file starts with a shebang (text script)
                    with open(full_path, 'rb') as f:
                        first_bytes = f.read(2)
                        # If it starts with #! it's a script, not a binary
                        if first_bytes != b'#!':
                            # Check for binary markers (null bytes in first 8KB)
                            f.seek(0)
                            chunk = f.read(8192)
                            if b'\x00' in chunk:
                                return False  # Binary file
                except:
                    pass
    
    # Include known code extensions
    if ext in CODE_EXTENSIONS:
        return True
    
    # Include files without extension (like Dockerfile, Makefile)
    if not ext and path.name not in ['.git', '.gitignore']:
        return True
    
    return False


def pack_directory(source_dir: str, output_zip: str, include_images: bool = False, include_fonts: bool = False):
    """
    Pack a directory by adding .txt to code files and creating a zip archive.
    
    Args:
        source_dir: Source directory to pack
        output_zip: Output zip file path
        include_images: Whether to include image files in the archive
        include_fonts: Whether to include font files in the archive
    """
    source_path = Path(source_dir).resolve()
    
    if not source_path.exists():
        print(f"Error: Directory '{source_dir}' does not exist.")
        sys.exit(1)
    
    if not source_path.is_dir():
        print(f"Error: '{source_dir}' is not a directory.")
        sys.exit(1)
    
    print(f"Packing directory: {source_path}")
    
    # Check if it's a git repository
    is_git_repo = (source_path / '.git').exists()
    
    if is_git_repo:
        print("Getting git-tracked files...")
        git_files = get_git_tracked_files(str(source_path))
        print(f"Found {len(git_files)} git-tracked files")
    else:
        print("Not a git repository - scanning all files...")
        git_files = get_all_files(str(source_path))
        print(f"Found {len(git_files)} files")
    
    # Create temporary directory for modified files
    temp_dir = source_path.parent / f".temp_pack_{source_path.name}"
    
    if temp_dir.exists():
        shutil.rmtree(temp_dir)
    
    temp_dir.mkdir()
    
    processed_count = 0
    skipped_count = 0
    excluded_count = 0
    
    # Track unknown extensions and non-.txt files
    unknown_extensions = set()
    seen_extensions = set()
    non_txt_files = []
    
    try:
        print("Processing files...")
        if include_images:
            print("  - Including image files")
        if include_fonts:
            print("  - Including font files")
        print()
        
        for rel_path in git_files:
            src_file = source_path / rel_path
            
            if not src_file.exists() or not src_file.is_file():
                continue
            
            # Track file extensions
            ext = Path(rel_path).suffix.lower()
            if ext and ext not in KNOWN_EXTENSIONS and ext not in seen_extensions:
                unknown_extensions.add(ext)
                seen_extensions.add(ext)
                print(f"ℹ New extension encountered: '{ext}' (file: {rel_path})")
            
            # Skip .gitignore files
            if Path(rel_path).name == '.gitignore':
                excluded_count += 1
                continue
            
            # Check if file should be excluded
            ext_lower = Path(rel_path).suffix.lower()
            if ext_lower in EXCLUDE_EXTENSIONS:
                excluded_count += 1
                continue
            
            if ext_lower in IMAGE_EXTENSIONS and not include_images:
                excluded_count += 1
                continue
            
            if ext_lower in FONT_EXTENSIONS and not include_fonts:
                excluded_count += 1
                continue
            
            # Add .txt.txt to ALL files that aren't excluded
            dst_file = temp_dir / f"{rel_path}.txt.txt"
            processed_count += 1
            
            # Create parent directories
            dst_file.parent.mkdir(parents=True, exist_ok=True)
            
            # Copy file
            shutil.copy2(src_file, dst_file)
        
        print()
        print(f"Processed {processed_count} files (added .txt.txt to all)")
        if excluded_count > 0:
            print(f"Excluded {excluded_count} binary/media files")
        
        if unknown_extensions:
            print(f"\n⚠ Unknown extensions found: {', '.join(sorted(unknown_extensions))}")
            print("  Consider adding these to CODE_EXTENSIONS or EXCLUDE_EXTENSIONS")
        
        # Create tar archive (uncompressed)
        print(f"\nCreating tar archive: {output_zip}")
        
        with tarfile.open(output_zip, 'w') as tar:
            for file_path in temp_dir.rglob('*'):
                if file_path.is_file():
                    arcname = file_path.relative_to(temp_dir)
                    tar.add(file_path, arcname=arcname)
        
        print(f"✓ Successfully created: {output_zip}")
        
    finally:
        # Clean up temporary directory
        if temp_dir.exists():
            shutil.rmtree(temp_dir)
            print("Cleaned up temporary files")


def unpack_archive(tar_file: str, output_dir: str):
    """
    Unpack a tar.gz archive and remove .txt.txt extensions from code files.
    
    Args:
        tar_file: Path to tar.gz file
        output_dir: Output directory to extract to
    """
    tar_path = Path(tar_file).resolve()
    output_path = Path(output_dir).resolve()
    
    if not tar_path.exists():
        print(f"Error: Archive file '{tar_file}' does not exist.")
        sys.exit(1)
    
    if output_path.exists():
        response = input(f"Directory '{output_dir}' exists. Overwrite? (y/N): ")
        if response.lower() != 'y':
            print("Aborted.")
            sys.exit(0)
        shutil.rmtree(output_path)
    
    output_path.mkdir(parents=True, exist_ok=True)
    
    print(f"Unpacking archive: {tar_path}")
    print(f"Output directory: {output_path}")
    
    restored_count = 0
    
    with tarfile.open(tar_path, 'r') as tar:
        for member in tar.getmembers():
            if not member.isfile():
                continue
            
            archived_name = member.name
            
            # Remove .txt.txt extension
            if archived_name.endswith('.txt.txt'):
                target_name = archived_name[:-8]  # Remove .txt.txt
                restored_count += 1
            else:
                target_name = archived_name
            
            # Extract file
            target_path = output_path / target_name
            target_path.parent.mkdir(parents=True, exist_ok=True)
            
            # Extract the file
            member.name = target_name
            tar.extract(member, output_path)
    
    print(f"Restored {restored_count} files (removed .txt.txt)")
    print(f"✓ Successfully unpacked to: {output_path}")


def main():
    parser = argparse.ArgumentParser(
        description='Pack and unpack code archives with .txt.txt extensions',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  Pack a directory:
    %(prog)s pack /path/to/project output.tar
  
  Unpack an archive:
    %(prog)s unpack archive.tar /path/to/output
        """
    )
    
    subparsers = parser.add_subparsers(dest='command', help='Command to execute')
    
    # Pack command
    pack_parser = subparsers.add_parser('pack', help='Pack a directory into a tar archive')
    pack_parser.add_argument('directory', help='Directory to pack (git-tracked files if git repo, all files otherwise)')
    pack_parser.add_argument('output', help='Output tar file path')
    pack_parser.add_argument('--include-images', action='store_true', 
                            help='Include image files (jpg, png, gif, etc.) in the archive')
    pack_parser.add_argument('--include-fonts', action='store_true',
                            help='Include font files (ttf, woff, etc.) in the archive')
    
    # Unpack command
    unpack_parser = subparsers.add_parser('unpack', help='Unpack a tar archive')
    unpack_parser.add_argument('tarfile', help='Tar file to unpack')
    unpack_parser.add_argument('output', help='Output directory')
    
    args = parser.parse_args()
    
    if not args.command:
        parser.print_help()
        sys.exit(1)
    
    try:
        if args.command == 'pack':
            pack_directory(args.directory, args.output, 
                          include_images=args.include_images,
                          include_fonts=args.include_fonts)
        elif args.command == 'unpack':
            unpack_archive(args.tarfile, args.output)
    except KeyboardInterrupt:
        print("\n\nOperation cancelled by user.")
        sys.exit(1)
    except Exception as e:
        print(f"\nError: {e}")
        sys.exit(1)


if __name__ == '__main__':
    main()
