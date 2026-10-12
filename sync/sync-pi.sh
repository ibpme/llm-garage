#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$DIR/.." && pwd)"
# shellcheck source=./lib.sh
source "$DIR/lib.sh"
require_macos_or_linux

TARGET="$HOME/.pi/agent"

link_one "$REPO_ROOT/context/GLOBAL.md" "$TARGET/AGENTS.md"
link_dir_contents "$REPO_ROOT/prompts" "$TARGET/prompts"
# Ensure pi's settings.json points at the same skill directories that
# sync-claude.sh / sync-codex.sh populate.
uv run "$DIR/config_merge.py" json-set "$TARGET/settings.json" skills '["~/.claude/skills","~/.codex/skills"]'

# Link the manifest-driven local package; migrate old individual repo links.
# Unrelated local extensions stay untouched.
link_pi_extensions "$REPO_ROOT/pi-custom-extensions" "$TARGET/extensions"

# Install mutable extension defaults once. Unlike extensions and keybindings,
# these must be normal files: they hold local preferences (prompt suggestions
# are toggled at runtime; one-shot subagent modes are edited by hand) that
# should not modify this repository or be overwritten by a later sync.
for config in prompt-suggestions.json oneshot-subagent.json; do
  if [ ! -e "$TARGET/$config" ] && [ ! -L "$TARGET/$config" ]; then
    cp "$REPO_ROOT/pi-custom-config/$config" "$TARGET/$config"
    echo "installed default $TARGET/$config"
  fi
done

# Symlink this repo's keybindings.json override (unlike extensions, pi reads
# this as a single whole file, not a directory of entries).
link_one "$REPO_ROOT/pi-custom-keybinds/keybindings.json" "$TARGET/keybindings.json"

# Merge native server entries only; pi owns the rest of its mutable config.
if has_flag --with-mcp "$@"; then
  uv run "$DIR/config_merge.py" json-sync-servers "$TARGET/mcp.json" "$REPO_ROOT/mcp/pi-mcp.json"
fi

echo "pi: sync complete"
