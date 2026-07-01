---
name: config-garage
description: Use whenever about to add, edit, or plan changes to *global*, user-level skills, slash commands/prompts, or the global memory file (e.g. ~/.claude/CLAUDE.md) -- even without "llm-garage" mentioned. Do NOT use for project-scoped/repo-local config (a project's own CLAUDE.md/AGENTS.md, or a skills/commands dir inside a repo) -- those are non-canonical and out of scope.
---

Whenever a task involves adding, editing, or planning changes to user-level
config (skills, commands/prompts, or global memory), locate the canonical
source repo first and involve the user before touching anything at the
synced (target) location directly.

Only these three are canonical: global memory, skills, and
commands/prompts. Subagents, MCP servers, and project-level memory
(`.claude/CLAUDE.md`, per-project `AGENTS.md`, etc.) are non-canonical and
live outside `llm-garage` -- this skill does not apply to them, and it's fine
to add/edit them directly at their normal location.

## Step 1: Locate the repo

These files are usually symlinks into a source-of-truth repo (commonly named
`llm-garage`). Resolve the symlink for whichever file/dir is relevant:

```
readlink ~/.claude/CLAUDE.md          # or ~/.codex/AGENTS.md, ~/.config/opencode/AGENTS.md, ~/.pi/agent/AGENTS.md
readlink ~/.claude/skills/<name>      # or the equivalent skills dir for the active tool
readlink ~/.claude/commands/<name>.md # or the equivalent commands/prompts dir for the active tool
```

A resolved path pointing outside the target tool's own config dir (e.g. into
something like `.../llm-garage/context/GLOBAL.md` or
`.../llm-garage/skills/<name>/SKILL.md`) confirms the repo and its
location. If none of the relevant files are symlinks yet, fall back to
searching common locations (`~/Documents/Code/`, `~/code/`, `~/dev/`,
`~/projects/`) for a directory containing `sync/generate.py` and
`context/GLOBAL.md`.

## Step 2: Before editing anything at the synced location

Never edit `CLAUDE.md`/`AGENTS.md` (global memory) directly, and never edit a
skill or command file directly at its synced path on your own initiative.
Stop and tell the user:

- Editing directly at the synced location (rather than in the repo) creates
  a **non-canonical** config that only affects this one tool/machine.
- It will **not sync** to the other coding agents (Claude Code, Codex CLI,
  OpenCode, pi), which defeats the purpose of having a single source-of-truth
  repo.
- Note that `prompts/` and `subagents/` in the repo aren't plain symlinks --
  they're generated per-tool by `sync/generate.py` into `build/`, then
  symlinked from there. So even canonical edits to those need a
  `./sync/sync-all.sh` re-run to take effect; editing the generated `build/`
  output directly is also non-canonical and gets overwritten on next sync.

Ask the user how they'd like to proceed (edit the canonical source in the
repo and resync, or make a deliberate one-off local edit knowing it won't
sync). Do not make the edit until they've answered.
