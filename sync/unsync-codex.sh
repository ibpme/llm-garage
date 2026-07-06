#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$DIR/.." && pwd)"
# shellcheck source=./lib.sh
source "$DIR/lib.sh"
require_macos_or_linux

TARGET="$HOME/.codex"

unlink_one "$TARGET/AGENTS.md"
unlink_repo_symlinks "$TARGET/skills"
unlink_repo_symlinks "$TARGET/agents"
unlink_repo_symlinks "$TARGET/prompts"

# Only reverses MCP entries if this repo was synced with --with-mcp in
# the first place -- see sync-codex.sh.
if has_flag --with-mcp "$@" && [ -d "$REPO_ROOT/mcp" ]; then
  for d in "$REPO_ROOT/mcp"/*/; do
    [ -d "$d" ] || continue
    python3 "$DIR/config_merge.py" toml-remove "$TARGET/config.toml" mcp_servers "$(basename "$d")"
  done
fi

echo "codex: unsync complete"
