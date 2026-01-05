#!/usr/bin/env python3
import sys, subprocess, os, shutil, stat

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

    subprocess.run(["git", "add", target_dir], check=True)
    subprocess.run(["git", "commit", "-m", f"Add/update {repo_name} ({branch})"], check=True)
    subprocess.run(["git", "push"], check=True)

    print(f"✅ Synced {repo_url} ({branch}) into curated repo as {target_dir}")

if __name__ == "__main__":
    main()
