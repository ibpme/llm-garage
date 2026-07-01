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
link_dir_contents "$REPO_ROOT/build/codex/agents" "$TARGET/agents"
link_dir_contents "$REPO_ROOT/build/codex/prompts" "$TARGET/prompts"

echo "codex: sync complete"
