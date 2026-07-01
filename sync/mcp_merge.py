#!/usr/bin/env python3
"""Merge or remove a single MCP server entry inside a native tool config
file, without disturbing the rest of that file -- unlike skills/subagents/
prompts, files like ~/.claude.json, ~/.codex/config.toml and
~/.pi/agent/mcp.json also hold unrelated state (auth, projects, other
servers) owned by the tool itself, so they can't be symlinked wholesale.

Used by sync-*.sh / unsync-*.sh after generate.py has produced the
per-target fragment under build/<target>/mcp/<name>.json|toml.

Usage:
  mcp_merge.py json-merge  <config_path> <config_key> <name> <entry_json_path>
  mcp_merge.py json-remove <config_path> <config_key> <name>
  mcp_merge.py toml-merge  <config_path> <table> <name> <entry_toml_path>
  mcp_merge.py toml-remove <config_path> <table> <name>
"""
import json
import os
import sys
import tempfile


def _backup_once(path):
    """Back up the config file the first time this script ever touches it,
    mirroring lib.sh's "never silently overwrite" convention for symlinks.
    Only fires once per file (checked via glob of the same suffix pattern
    lib.sh uses for its own backups) -- this is a safety net for manual
    recovery, not an automatic restore like unlink_one's.
    """
    if not os.path.isfile(path):
        return
    import glob
    import time
    if glob.glob(f"{path}.pre-llm-garage-mcp.*"):
        return
    backup = f"{path}.pre-llm-garage-mcp.{time.strftime('%Y%m%dT%H%M%S')}"
    with open(path, "rb") as src, open(backup, "wb") as dst:
        dst.write(src.read())
    print(f"backed up {path} -> {backup}")


def _atomic_write(path, text):
    """Write text to path via a temp file + rename, so a crash/kill/disk-full
    mid-write can never leave the live config truncated or half-written --
    the target either has the old content or the new content, never neither.
    """
    dirname = os.path.dirname(path) or "."
    os.makedirs(dirname, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(dir=dirname, prefix=os.path.basename(path) + ".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(text)
        os.replace(tmp_path, path)
    except BaseException:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        raise


def load_json(path):
    if not os.path.isfile(path):
        return {}
    with open(path) as f:
        content = f.read().strip()
    if not content:
        return {}
    try:
        return json.loads(content)
    except json.JSONDecodeError as e:
        sys.exit(f"error: {path} is not valid JSON, refusing to touch it ({e})")


def write_json(path, config):
    # ensure_ascii=False so existing non-ASCII content (project paths, etc.)
    # isn't rewritten into \uXXXX escapes on every unrelated key we touch.
    _atomic_write(path, json.dumps(config, indent=2, ensure_ascii=False) + "\n")


def json_merge(config_path, config_key, name, entry_path):
    with open(entry_path) as f:
        entry = json.load(f)
    _backup_once(config_path)
    config = load_json(config_path)
    if not isinstance(config, dict):
        sys.exit(f"error: {config_path} top level is not a JSON object, refusing to touch it")
    bucket = config.setdefault(config_key, {})
    if not isinstance(bucket, dict):
        sys.exit(f"error: {config_path} key {config_key!r} is not an object "
                  f"(found {type(bucket).__name__}), refusing to overwrite it")
    existing = bucket.get(name)
    if existing is not None and existing != entry:
        print(f"note: {config_key}.{name} already existed with a different value, replacing it")
    bucket[name] = entry
    write_json(config_path, config)
    print(f"merged {config_key}.{name} -> {config_path}")


def json_remove(config_path, config_key, name):
    if not os.path.isfile(config_path):
        return
    config = load_json(config_path)
    bucket = config.get(config_key, {})
    if not isinstance(bucket, dict) or name not in bucket:
        return
    _backup_once(config_path)
    del bucket[name]
    write_json(config_path, config)
    print(f"removed {config_key}.{name} from {config_path}")


def _normalize_header(line):
    """Collapse whitespace inside `[ table ]` so `[foo.bar]` and
    `[ foo.bar ]` are recognized as the same table -- avoids ending up with
    two conflicting tables for the same server (which TOML itself would
    then reject as a duplicate key on the tool's next parse).
    """
    stripped = line.strip()
    if not stripped.startswith("[") or "]" not in stripped:
        return stripped
    inner = stripped[1:stripped.index("]")].strip()
    return f"[{inner}]" + stripped[stripped.index("]") + 1:]


def _toml_block_span(lines, table):
    """Return the [start, end) line-index span of the `[table]` block,
    including any nested `[table.sub]` tables, or None if absent.
    """
    header = f"[{table}]"
    start = None
    for i, line in enumerate(lines):
        if _normalize_header(line) == header:
            start = i
            break
    if start is None:
        return None
    end = len(lines)
    for i in range(start + 1, len(lines)):
        normalized = _normalize_header(lines[i])
        if normalized.startswith("[") and not normalized.startswith(f"[{table}."):
            end = i
            break
    return (start, end)


def toml_merge(config_path, table, name, entry_path):
    full_table = f"{table}.{name}"
    with open(entry_path) as f:
        entry_body = f.read().rstrip("\n")
    block = [f"[{full_table}]"] + entry_body.split("\n") + [""]

    _backup_once(config_path)
    lines = []
    if os.path.isfile(config_path):
        with open(config_path) as f:
            lines = f.read().split("\n")

    span = _toml_block_span(lines, full_table)
    if span:
        start, end = span
        existing_body = [l for l in lines[start + 1:end] if l.strip() != ""]
        new_body = [l for l in block[1:] if l.strip() != ""]
        if existing_body and existing_body != new_body:
            print(f"note: [{full_table}] already existed with a different value, replacing it")
        lines[start:end] = block
    else:
        if lines and lines[-1].strip() != "":
            lines.append("")
        lines.extend(block)

    _atomic_write(config_path, "\n".join(lines).rstrip("\n") + "\n")
    print(f"merged [{full_table}] -> {config_path}")


def toml_remove(config_path, table, name):
    if not os.path.isfile(config_path):
        return
    full_table = f"{table}.{name}"
    with open(config_path) as f:
        lines = f.read().split("\n")
    span = _toml_block_span(lines, full_table)
    if not span:
        return
    _backup_once(config_path)
    start, end = span
    del lines[start:end]
    remaining = "\n".join(lines).rstrip("\n")
    _atomic_write(config_path, remaining + "\n" if remaining else "")
    print(f"removed [{full_table}] from {config_path}")


def main():
    args = sys.argv[1:]
    if not args:
        sys.exit(__doc__)
    cmd = args[0]
    try:
        if cmd == "json-merge":
            _, config_path, config_key, name, entry_path = args
            json_merge(config_path, config_key, name, entry_path)
        elif cmd == "json-remove":
            _, config_path, config_key, name = args
            json_remove(config_path, config_key, name)
        elif cmd == "toml-merge":
            _, config_path, table, name, entry_path = args
            toml_merge(config_path, table, name, entry_path)
        elif cmd == "toml-remove":
            _, config_path, table, name = args
            toml_remove(config_path, table, name)
        else:
            sys.exit(f"unknown command: {cmd}")
    except ValueError:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
