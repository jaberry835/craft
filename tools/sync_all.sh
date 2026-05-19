#!/usr/bin/env bash
# sync_all.sh — Run add_repo.py against all tracked projects

set -u

# PAT setup for private GitHub repos used by add_repo.py.
# Priority: existing ADD_REPO_GITHUB_TOKEN -> GITHUB_TOKEN -> secure prompt.
if [[ -z "${ADD_REPO_GITHUB_TOKEN:-}" ]]; then
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    export ADD_REPO_GITHUB_TOKEN="$GITHUB_TOKEN"
  else
    read -rsp "GitHub PAT (repo read access): " pat
    echo
    if [[ -z "$pat" ]]; then
      echo "ERROR: No PAT provided. Set ADD_REPO_GITHUB_TOKEN or GITHUB_TOKEN."
      exit 1
    fi
    export ADD_REPO_GITHUB_TOKEN="$pat"
    unset pat
  fi
fi

repos=(
 # "https://github.com/adamruderman/UserAccessCheckerApi main"
  "https://github.com/adamruderman/AgentChatV2 main"
  "https://github.com/adamruderman/AgentChatV2 experiment/response-api"
  "https://github.com/adamruderman/Rude-MCPServer main"
  #"https://github.com/adamruderman/UserAccessChecker-Python main"
  #"https://github.com/jaberry835/snapseek main"
  #"https://github.com/microsoft/simplechat main"
  #"https://github.com/jaberry835/snapseek deepface-embeddings"
  #"https://github.com/adamruderman/WebScrapeAndIndex main"
  "https://github.com/adamruderman/SecureAPI main"
  "https://github.com/adamruderman/McpServer main"
  "https://github.com/adamruderman/SecureChatExtension main"
  #"https://github.com/adamruderman/SecureChatExtension msal-config"
  #"https://github.com/adamruderman/SecureChatExtension experiment/responses-api"
  #"https://github.com/adamruderman/SecureChatExtension squad-integration"
  #"https://github.com/adamruderman/SecureChatExtension feature/junior-dev-team"
  "https://github.com/adamruderman/junior-studio main"
  "https://github.com/adamruderman/junior-web main"
  "https://github.com/adamruderman/junior-web jb-test-branch"
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
