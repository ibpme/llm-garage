#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$DIR/.." && pwd)"
# shellcheck source=./lib.sh
source "$DIR/lib.sh"
require_macos_or_linux

TARGET="$HOME/.pi/agent"

unlink_one "$TARGET/AGENTS.md"
unlink_repo_symlinks "$TARGET/agents"
unlink_repo_symlinks "$TARGET/prompts"

if [ -d "$REPO_ROOT/mcp" ]; then
  for d in "$REPO_ROOT/mcp"/*/; do
    [ -d "$d" ] || continue
    python3 "$DIR/mcp_merge.py" json-remove "$TARGET/mcp.json" mcpServers "$(basename "$d")"
  done
fi

echo "pi: unsync complete"
