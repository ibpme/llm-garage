#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$DIR/.." && pwd)"
# shellcheck source=./lib.sh
source "$DIR/lib.sh"
require_macos_or_linux

TARGET="$HOME/.pi/agent"

link_one "$REPO_ROOT/context/GLOBAL.md" "$TARGET/AGENTS.md"
link_dir_contents "$REPO_ROOT/build/pi/agents" "$TARGET/agents"
link_dir_contents "$REPO_ROOT/build/pi/prompts" "$TARGET/prompts"
# No skills link needed here: ~/.pi/agent/settings.json already points
# pi's "skills" config at ~/.claude/skills and ~/.codex/skills, both of
# which sync-claude.sh / sync-codex.sh populate.

echo "pi: sync complete"
