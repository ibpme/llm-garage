#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$DIR/.." && pwd)"
# shellcheck source=./lib.sh
source "$DIR/lib.sh"
require_macos_or_linux

TARGET="$HOME/.claude"

unlink_one "$TARGET/CLAUDE.md"
unlink_repo_symlinks "$TARGET/skills"
unlink_repo_symlinks "$TARGET/agents"
unlink_repo_symlinks "$TARGET/commands"

# Only reverses MCP entries if this repo was synced with --with-mcp in
# the first place -- see sync-claude.sh.
if has_flag --with-mcp "$@" && [ -d "$REPO_ROOT/mcp" ]; then
  for d in "$REPO_ROOT/mcp"/*/; do
    [ -d "$d" ] || continue
    python3 "$DIR/config_merge.py" json-remove "$HOME/.claude.json" mcpServers "$(basename "$d")"
  done
fi

echo "claude: unsync complete"
