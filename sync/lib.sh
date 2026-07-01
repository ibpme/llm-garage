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

# unlink_one DEST
# Reverses link_one: removes DEST only if it's a symlink pointing into this
# repo (never touches anything else), then restores the newest
# pre-llm-garage backup for DEST if one exists. No-op if DEST isn't one of
# ours.
unlink_one() {
  local dest="$1"

  if [ -L "$dest" ]; then
    local target
    target="$(readlink "$dest")"
    case "$target" in
      "$REPO_ROOT"/*)
        rm "$dest"
        echo "removed link $dest"
        ;;
      *)
        echo "skipped $dest (symlink points outside this repo, leaving as-is)"
        return 0
        ;;
    esac
  elif [ -e "$dest" ]; then
    echo "skipped $dest (not a symlink, leaving as-is)"
    return 0
  else
    return 0
  fi

  # Timestamp suffix (YYYYMMDDThhmmss) sorts the same alphabetically as
  # chronologically, so the last glob match is the most recent backup.
  # Explicitly scope nullglob here rather than relying on the caller's
  # setting -- if it's already on and nothing matches, the pattern vanishes
  # entirely and this would silently operate on the wrong argument.
  local backup="" f
  shopt -s nullglob
  for f in "${dest}".pre-llm-garage.*; do
    backup="$f"
  done
  shopt -u nullglob

  if [ -n "$backup" ]; then
    mv "$backup" "$dest"
    echo "restored backup $backup -> $dest"
  fi
}

# unlink_repo_symlinks DEST_DIR
# Scans DEST_DIR (not this repo's source dir, so it works even if a spec was
# since deleted) and unlinks every entry that is one of ours, via unlink_one.
unlink_repo_symlinks() {
  local dest_dir="$1"
  [ -d "$dest_dir" ] || return 0
  shopt -s nullglob
  for entry in "$dest_dir"/*; do
    unlink_one "$entry"
  done
  shopt -u nullglob
}
