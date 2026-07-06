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
unlink_repo_symlinks "$TARGET/extensions"
unlink_one "$TARGET/keybindings.json"

# Reverse the settings.json skills key we set during sync.
python3 "$DIR/config_merge.py" json-remove-key "$TARGET/settings.json" skills

# Only reverses MCP entries if this repo was synced with --with-mcp in
# the first place -- see sync-pi.sh.
if has_flag --with-mcp "$@" && [ -d "$REPO_ROOT/mcp" ]; then
  for d in "$REPO_ROOT/mcp"/*/; do
    [ -d "$d" ] || continue
    python3 "$DIR/config_merge.py" json-remove "$TARGET/mcp.json" mcpServers "$(basename "$d")"
  done
fi

echo "pi: unsync complete"
