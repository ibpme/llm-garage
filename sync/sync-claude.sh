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
# Subagent syncing deferred -- skills now cover what subagents were used
# for here. subagents/ + generate.py still work; re-add this line to
# resume syncing them.
# link_dir_contents "$REPO_ROOT/build/claude/agents" "$TARGET/agents"
link_dir_contents "$REPO_ROOT/build/claude/commands" "$TARGET/commands"

# MCP servers are optional and off by default -- setting them up is a
# coding agent's own responsibility, not this repo's. Pass --with-mcp to
# also merge this repo's mcp/ specs into ~/.claude.json (a file shared
# with unrelated Claude Code state: auth, projects, other servers -- so
# the key is merged in rather than symlinking the whole file).
if has_flag --with-mcp "$@" && [ -d "$REPO_ROOT/build/claude/mcp" ]; then
  for entry in "$REPO_ROOT/build/claude/mcp"/*.json; do
    [ -e "$entry" ] || continue
    name="$(basename "$entry" .json)"
    python3 "$DIR/config_merge.py" json-merge "$HOME/.claude.json" mcpServers "$name" "$entry"
  done
fi

echo "claude: sync complete"
