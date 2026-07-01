#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$DIR/.." && pwd)"
# shellcheck source=./lib.sh
source "$DIR/lib.sh"
require_macos_or_linux

TARGET="$HOME/.config/opencode"

link_one "$REPO_ROOT/context/GLOBAL.md" "$TARGET/AGENTS.md"
link_dir_contents "$REPO_ROOT/skills" "$TARGET/skills"
# Subagent syncing deferred -- skills now cover what subagents were used
# for here. subagents/ + generate.py still work; re-add this line to
# resume syncing them.
# link_dir_contents "$REPO_ROOT/build/opencode/agents" "$TARGET/agents"
link_dir_contents "$REPO_ROOT/build/opencode/commands" "$TARGET/commands"

echo "opencode: sync complete"
