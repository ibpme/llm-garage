#!/usr/bin/env bash
# Links shared config and prompts directly. Pass --with-mcp to also
# merge the tracked native pi MCP servers.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

for target in claude codex opencode pi; do
  echo "=== $target ==="
  "$DIR/sync-$target.sh" "$@"
done
