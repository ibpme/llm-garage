#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

python3 "$DIR/generate.py"

for target in claude codex opencode pi; do
  echo "=== $target ==="
  "$DIR/sync-$target.sh"
done
