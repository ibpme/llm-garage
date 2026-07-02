#!/usr/bin/env bash
# Regenerates build/ and re-links everything. MCP servers are skipped by
# default -- setting them up is a coding agent's own responsibility, not
# this repo's. Pass --with-mcp to also sync this repo's mcp/ specs.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

python3 "$DIR/generate.py"

for target in claude codex opencode pi; do
  echo "=== $target ==="
  "$DIR/sync-$target.sh" "$@"
done
