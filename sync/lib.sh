#!/usr/bin/env bash
# Shared helpers for sync-*.sh. Source this, don't execute it directly.
set -euo pipefail

require_macos_or_linux() {
  case "$(uname -s)" in
    Darwin|Linux) ;;
    *)
      echo "error: sync scripts are symlink-based and only support macOS/Linux." >&2
      echo "Windows is not supported yet -- see README.md." >&2
      exit 1
      ;;
  esac
}

# link_one SRC DEST
# Symlinks DEST -> SRC. If DEST already exists as something else, it is
# renamed aside with a timestamp suffix first -- never silently clobbered.
link_one() {
  local src="$1" dest="$2"
  mkdir -p "$(dirname "$dest")"

  if [ -L "$dest" ] && [ "$(readlink "$dest")" = "$src" ]; then
    return 0
  fi

  if [ -e "$dest" ] || [ -L "$dest" ]; then
    local backup
    backup="${dest}.pre-llm-garage.$(date +%Y%m%dT%H%M%S)"
    mv "$dest" "$backup"
    echo "backed up existing $dest -> $backup"
  fi

  ln -s "$src" "$dest"
  echo "linked $dest -> $src"
}

# link_dir_contents SRC_DIR DEST_DIR
# Symlinks each entry inside SRC_DIR individually into DEST_DIR, rather than
# symlinking the whole directory -- so files a target agent writes into
# DEST_DIR on its own (caches, other unrelated agents/skills) are untouched.
link_dir_contents() {
  local src_dir="$1" dest_dir="$2"
  [ -d "$src_dir" ] || return 0
  mkdir -p "$dest_dir"
  shopt -s nullglob
  for entry in "$src_dir"/*; do
    link_one "$entry" "$dest_dir/$(basename "$entry")"
  done
  shopt -u nullglob
}
