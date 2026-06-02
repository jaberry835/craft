#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Bootstrap Azure persistence resources for Junior Workbench.

Required:
  --cosmos-account <name>
  --storage-account <name>

Optional:
  --resource-group <name>          Shared default for Cosmos and Storage resource groups
  --cosmos-resource-group <name>   Overrides the shared resource group for Cosmos
  --storage-resource-group <name>  Overrides the shared resource group for Storage
  --database <name>                 Cosmos DB database name. Default: JuniorWeb
  --workspace-container <name>      Default: Workspaces
  --config-container <name>         Default: WorkspaceConfig
  --chat-container <name>           Default: ChatSessions
  --pending-container <name>        Default: PendingChanges
  --agents-container <name>         Default: Agents
  --blob-container <name>           Default: junior-workspaces
  --skip-agents-container           Do not create the shared admin config container
  --help                            Show this help

Example:
  bash scripts/bootstrap-azure-persistence.sh \
    --resource-group my-rg \
    --cosmos-account my-cosmos \
    --storage-account mystorage

  bash scripts/bootstrap-azure-persistence.sh \
    --cosmos-resource-group data-rg \
    --storage-resource-group storage-rg \
    --cosmos-account my-cosmos \
    --storage-account mystorage
EOF
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required command not found: $1" >&2
    exit 1
  fi
}

run_az() {
  local output
  local status

  set +e
  output=$(az "$@" 2>&1)
  status=$?
  set -e

  if [[ $status -ne 0 ]]; then
    printf '%s\n' "$output" >&2
    if [[ "$output" == *"AADSTS50076"* ]] || [[ "$output" == *"claims-challenge"* ]]; then
      echo >&2
      echo "Azure CLI needs an MFA/claims-challenge login for this write operation." >&2
      echo "Run the login command shown above, preferably with --use-device-code, then rerun this script." >&2
    fi
    exit $status
  fi

  printf '%s\n' "$output"
}

RESOURCE_GROUP=""
COSMOS_RESOURCE_GROUP=""
STORAGE_RESOURCE_GROUP=""
COSMOS_ACCOUNT=""
STORAGE_ACCOUNT=""
DATABASE_NAME="JuniorWeb"
WORKSPACE_CONTAINER="Workspaces"
CONFIG_CONTAINER="WorkspaceConfig"
CHAT_CONTAINER="ChatSessions"
PENDING_CONTAINER="PendingChanges"
AGENTS_CONTAINER="Agents"
BLOB_CONTAINER="junior-workspaces"
CREATE_AGENTS_CONTAINER="true"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --resource-group)
      RESOURCE_GROUP="$2"
      shift 2
      ;;
    --cosmos-account)
      COSMOS_ACCOUNT="$2"
      shift 2
      ;;
    --cosmos-resource-group)
      COSMOS_RESOURCE_GROUP="$2"
      shift 2
      ;;
    --storage-account)
      STORAGE_ACCOUNT="$2"
      shift 2
      ;;
    --storage-resource-group)
      STORAGE_RESOURCE_GROUP="$2"
      shift 2
      ;;
    --database)
      DATABASE_NAME="$2"
      shift 2
      ;;
    --workspace-container)
      WORKSPACE_CONTAINER="$2"
      shift 2
      ;;
    --config-container)
      CONFIG_CONTAINER="$2"
      shift 2
      ;;
    --chat-container)
      CHAT_CONTAINER="$2"
      shift 2
      ;;
    --pending-container)
      PENDING_CONTAINER="$2"
      shift 2
      ;;
    --agents-container)
      AGENTS_CONTAINER="$2"
      shift 2
      ;;
    --blob-container)
      BLOB_CONTAINER="$2"
      shift 2
      ;;
    --skip-agents-container)
      CREATE_AGENTS_CONTAINER="false"
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$COSMOS_ACCOUNT" || -z "$STORAGE_ACCOUNT" ]]; then
  echo "Missing required arguments." >&2
  usage
  exit 1
fi

if [[ -z "$COSMOS_RESOURCE_GROUP" ]]; then
  COSMOS_RESOURCE_GROUP="$RESOURCE_GROUP"
fi

if [[ -z "$STORAGE_RESOURCE_GROUP" ]]; then
  STORAGE_RESOURCE_GROUP="$RESOURCE_GROUP"
fi

if [[ -z "$COSMOS_RESOURCE_GROUP" || -z "$STORAGE_RESOURCE_GROUP" ]]; then
  echo "Provide --resource-group or both --cosmos-resource-group and --storage-resource-group." >&2
  usage
  exit 1
fi

require_command az

CONTAINERS=(
  "$WORKSPACE_CONTAINER"
  "$CONFIG_CONTAINER"
  "$CHAT_CONTAINER"
  "$PENDING_CONTAINER"
)

if [[ "$CREATE_AGENTS_CONTAINER" == "true" ]]; then
  CONTAINERS+=("$AGENTS_CONTAINER")
fi

echo "Ensuring Cosmos DB database '$DATABASE_NAME' exists in account '$COSMOS_ACCOUNT'..."
run_az cosmosdb sql database create \
  --resource-group "$COSMOS_RESOURCE_GROUP" \
  --account-name "$COSMOS_ACCOUNT" \
  --name "$DATABASE_NAME" \
  --output table

for container in "${CONTAINERS[@]}"; do
  echo "Ensuring Cosmos DB container '$container' exists with partition key /partitionKey..."
  run_az cosmosdb sql container create \
    --resource-group "$COSMOS_RESOURCE_GROUP" \
    --account-name "$COSMOS_ACCOUNT" \
    --database-name "$DATABASE_NAME" \
    --name "$container" \
    --partition-key-path "/partitionKey" \
    --output table
done

echo "Ensuring private blob container '$BLOB_CONTAINER' exists in storage account '$STORAGE_ACCOUNT'..."
run_az storage container create \
  --resource-group "$STORAGE_RESOURCE_GROUP" \
  --account-name "$STORAGE_ACCOUNT" \
  --name "$BLOB_CONTAINER" \
  --auth-mode login \
  --public-access off \
  --output table

echo
echo "Bootstrap complete. Configure the app with:"
echo "  COSMOS_DB_DATABASE=$DATABASE_NAME"
echo "  COSMOS_DB_WORKSPACE_CONTAINER=$WORKSPACE_CONTAINER"
echo "  COSMOS_DB_WORKSPACE_CONFIG_CONTAINER=$CONFIG_CONTAINER"
echo "  COSMOS_DB_CHAT_CONTAINER=$CHAT_CONTAINER"
echo "  COSMOS_DB_PENDING_CHANGE_CONTAINER=$PENDING_CONTAINER"
if [[ "$CREATE_AGENTS_CONTAINER" == "true" ]]; then
  echo "  COSMOS_DB_CONFIG_CONTAINER=$AGENTS_CONTAINER"
fi
echo "  JUNIOR_WORKSPACE_BLOB_CONTAINER=$BLOB_CONTAINER"
