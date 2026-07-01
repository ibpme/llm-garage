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

echo "claude: sync complete"
