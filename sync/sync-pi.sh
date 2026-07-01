#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$DIR/.." && pwd)"
# shellcheck source=./lib.sh
source "$DIR/lib.sh"
require_macos_or_linux

TARGET="$HOME/.pi/agent"

link_one "$REPO_ROOT/context/GLOBAL.md" "$TARGET/AGENTS.md"
# Subagent syncing deferred -- skills now cover what subagents were used
# for here. subagents/ + generate.py still work; re-add this line to
# resume syncing them.
# link_dir_contents "$REPO_ROOT/build/pi/agents" "$TARGET/agents"
link_dir_contents "$REPO_ROOT/build/pi/prompts" "$TARGET/prompts"
# No skills link needed here: ~/.pi/agent/settings.json already points
# pi's "skills" config at ~/.claude/skills and ~/.codex/skills, both of
# which sync-claude.sh / sync-codex.sh populate.

# MCP servers live in mcp.json, a file pi may also hold project-scoped or
# pi-specific state in -- merge the key in rather than symlinking the file.
if [ -d "$REPO_ROOT/build/pi/mcp" ]; then
  for entry in "$REPO_ROOT/build/pi/mcp"/*.json; do
    [ -e "$entry" ] || continue
    name="$(basename "$entry" .json)"
    python3 "$DIR/mcp_merge.py" json-merge "$TARGET/mcp.json" mcpServers "$name" "$entry"
  done
fi

echo "pi: sync complete"
