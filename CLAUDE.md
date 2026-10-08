# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

`llm-garage` is the personal source-of-truth config repo for skills,
subagents, prompts/commands, and global context, shared across four AI
coding agents: Claude Code, OpenAI Codex CLI, OpenCode, and pi. You edit
files here, then run a sync script that symlinks (or generates+symlinks)
them into each tool's native config location. See `README.md` for the
full rationale and per-tool target table — it's kept current and should
be treated as authoritative alongside this file.

## Commands

```
./sync/sync-all.sh              # regenerate + symlink skills, memory, commands/prompts, subagents into all 4 tools
./sync/unsync-all.sh            # remove all symlinks this repo created, restore backups
./sync/refresh-context7.py      # pull Context7's skill/rule content from upstream and diff
```

Per-tool variants exist too: `sync-claude.sh`, `sync-codex.sh`,
`sync-opencode.sh`, `sync-pi.sh` (and matching `unsync-*.sh`).

There is no build/lint/test tooling — `sync/generate.py` (Python 3
stdlib only) and `sync/lib.sh` (bash, macOS/Linux only) are the only
"code" to reason about. `npm test` is a stub and not meaningful.

**Regeneration is not automatic.** After editing anything under
`subagents/`, `prompts/`, or `mcp/`, you must re-run sync for the change
to take effect in any live tool. Editing `context/GLOBAL.md` or
`skills/**` takes effect immediately since those paths are direct
symlinks, not generated.
