#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$DIR/.." && pwd)"
# shellcheck source=./lib.sh
source "$DIR/lib.sh"
require_macos_or_linux

TARGET="$HOME/.config/opencode"

unlink_one "$TARGET/AGENTS.md"
unlink_repo_symlinks "$TARGET/skills"
unlink_repo_symlinks "$TARGET/agents"
unlink_repo_symlinks "$TARGET/commands"

echo "opencode: unsync complete"
