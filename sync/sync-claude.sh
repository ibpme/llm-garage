#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$DIR/.." && pwd)"
# shellcheck source=./lib.sh
source "$DIR/lib.sh"
require_macos_or_linux

TARGET="$HOME/.claude"

link_one "$REPO_ROOT/context/GLOBAL.md" "$TARGET/CLAUDE.md"
link_dir_contents "$REPO_ROOT/skills" "$TARGET/skills"
link_dir_contents "$REPO_ROOT/build/claude/agents" "$TARGET/agents"
link_dir_contents "$REPO_ROOT/build/claude/commands" "$TARGET/commands"

# MCP servers live inside ~/.claude.json, a file shared with unrelated
# Claude Code state (auth, projects, other servers) -- merge the key in
# rather than symlinking the whole file.
if [ -d "$REPO_ROOT/build/claude/mcp" ]; then
  for entry in "$REPO_ROOT/build/claude/mcp"/*.json; do
    [ -e "$entry" ] || continue
    name="$(basename "$entry" .json)"
    python3 "$DIR/mcp_merge.py" json-merge "$HOME/.claude.json" mcpServers "$name" "$entry"
  done
fi

echo "claude: sync complete"
