#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$DIR/.." && pwd)"
# shellcheck source=./lib.sh
source "$DIR/lib.sh"
require_macos_or_linux

TARGET="$HOME/.codex"

link_one "$REPO_ROOT/context/GLOBAL.md" "$TARGET/AGENTS.md"
link_dir_contents "$REPO_ROOT/skills" "$TARGET/skills"
# Subagent syncing deferred -- skills now cover what subagents were used
# for here. subagents/ + generate.py still work; re-add this line to
# resume syncing them.
# link_dir_contents "$REPO_ROOT/build/codex/agents" "$TARGET/agents"
link_dir_contents "$REPO_ROOT/build/codex/prompts" "$TARGET/prompts"

# MCP servers live inside config.toml, a file shared with unrelated Codex
# state (model, project trust list, tui settings) -- merge the table in
# rather than symlinking the whole file.
if [ -d "$REPO_ROOT/build/codex/mcp" ]; then
  for entry in "$REPO_ROOT/build/codex/mcp"/*.toml; do
    [ -e "$entry" ] || continue
    name="$(basename "$entry" .toml)"
    python3 "$DIR/mcp_merge.py" toml-merge "$TARGET/config.toml" mcp_servers "$name" "$entry"
  done
fi

echo "codex: sync complete"
