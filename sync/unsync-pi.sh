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
uv run "$DIR/config_merge.py" json-remove-key "$TARGET/settings.json" skills

# Remove only server names listed in the tracked native config.
if has_flag --with-mcp "$@"; then
  uv run "$DIR/config_merge.py" json-unsync-servers "$TARGET/mcp.json" "$REPO_ROOT/mcp/pi-mcp.json"
fi

echo "pi: unsync complete"
