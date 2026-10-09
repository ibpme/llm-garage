# llm-garage

Source-of-truth config for Claude Code, Codex CLI, OpenCode, and pi.
Edit canonical files here, never at synced locations. See `README.md` for
layout and per-tool targets.

## Commands

```bash
./sync/sync-all.sh              # link skills, context, prompts, pi extensions/config
./sync/sync-all.sh --with-mcp   # also merge native pi MCP defaults
./sync/unsync-all.sh            # unlink repo config and restore backups
uv run sync/test_sync.py        # regression tests
./sync/refresh-context7.py      # refresh upstream Context7 skill/rules
```

Per-tool sync/unsync scripts are under `sync/`. Requires macOS/Linux, bash,
and `uv`; Python helpers use stdlib only. No build/lint tooling; `npm test`
is a stub.

## Sync rules

- Skills, context, and prompts are direct symlinks. Existing-file edits take
  effect immediately; re-run sync when adding or removing entries.
- `mcp/pi-mcp.json` is opt-in (`--with-mcp`), merged—not symlinked. Connection
  settings sync; local `enabled`, `exposure`, and `toolExposure` survive.
  Unrelated servers/settings remain untouched. Keep secrets out of tracked files.
- Mutable pi extension defaults are copied only when missing; local state wins.
- Subagents and other tools' MCP configs are not managed by sync.
