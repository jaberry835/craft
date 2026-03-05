#!/usr/bin/env bash
# sync_all.sh — Run add_repo.py against all tracked projects

set -u

repos=(
  "https://github.com/adamruderman/UserAccessCheckerApi main"
  "https://github.com/adamruderman/AgentChatV2 main"
  "https://github.com/adamruderman/Rude-MCPServer main"
  "https://github.com/adamruderman/UserAccessChecker-Python main"
  "https://github.com/jaberry835/snapseek main"
  "https://github.com/jaberry835/PrintShopDemo main"
)

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
add_repo="$script_dir/add_repo.py"

for repo in "${repos[@]}"; do
  url="${repo% *}"
  branch="${repo##* }"

  echo
  echo "========================================"
  echo "Syncing: $url ($branch)"
  echo "========================================"

  python "$add_repo" "$url" "$branch"
  exit_code=$?
  if [[ $exit_code -ne 0 ]]; then
    echo "ERROR syncing $url"
  fi
done

echo
echo "All repos processed."
