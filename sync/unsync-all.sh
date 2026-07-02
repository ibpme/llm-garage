#!/usr/bin/env bash
# Reverses sync-all.sh: removes every symlink this repo created and restores
# whatever was backed up in its place (see lib.sh's unlink_one). Anything
# that isn't one of ours is left untouched. Finishes by deleting build/,
# since it's just generated output. Pass --with-mcp if sync-all.sh was
# originally run with --with-mcp, to also remove those MCP server entries.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$DIR/.." && pwd)"

for target in claude codex opencode pi; do
  echo "=== $target ==="
  "$DIR/unsync-$target.sh" "$@"
done

rm -rf "$REPO_ROOT/build"
echo "removed $REPO_ROOT/build"
