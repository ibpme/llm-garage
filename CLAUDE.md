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
./sync/sync-all.sh --with-mcp   # ...plus merge MCP servers under mcp/ into each tool's native config
./sync/unsync-all.sh            # remove all symlinks this repo created, restore backups
./sync/unsync-all.sh --with-mcp # ...plus remove this repo's MCP entries from native configs
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

## Architecture

- `context/GLOBAL.md` — canonical global instructions, symlinked to
  `CLAUDE.md`/`AGENTS.md` in every tool's home dir.
- `skills/<name>/SKILL.md` — canonical skills, identical format across
  all four tools, plain symlinked (no translation step).
- `subagents/<name>/{spec.yaml,prompt.md}` — non-canonical. Currently
  **not linked into any live tool config** (the `link_dir_contents ...
  agents` line is commented out in each `sync/sync-<target>.sh`, since
  skills cover most of what these were used for). `generate.py` still
  translates them into `build/<target>/agents/`; uncomment the relevant
  line per target to resume linking.
- `prompts/<name>.md` — canonical manually-invoked `/name` commands
  (frontmatter + `$ARGUMENTS` body), passed through to each tool's
  command dir with only minor frontmatter differences.
- `mcp/<name>/spec.yaml` — non-canonical, **opt-in only** (`--with-mcp`).
  stdio servers only (`command` + args). Merged into each tool's native
  MCP config via `sync/config_merge.py`, which upserts just one server's
  entry/table and leaves the rest of the file (auth, other servers,
  project lists) untouched, with a one-time backup on first write.
- `sync/generate.py` — the only place that does real translation work:
  reads `subagents/`, `prompts/`, `mcp/` and writes `build/<target>/...`
  in each tool's native format. Key pieces: `CLAUDE_TOOL_MAP` /
  `OPENCODE_TOOL_MAP` (canonical tool vocab → per-tool names),
  `codex_sandbox_mode()` (tool list → Codex's `workspace-write`/
  `read-only` sandbox, since Codex has no per-tool allow-list),
  `parse_spec()` (a deliberately small ~30-line hand-rolled YAML subset
  parser — flat keys plus two nested maps, `model:` and `mcp_tools:` —
  not a general YAML parser, so keep new specs within that shape).
- `sync/lib.sh` — shared symlink + backup helpers; any existing file at
  a target path is renamed aside as `<file>.pre-llm-garage.<timestamp>`
  before a symlink is created, never silently overwritten. Refuses to
  run on non-macOS/Linux.
- `build/` — fully generated output, gitignored, rebuilt on every sync
  run. Never edit here.
- `pi-custom-extensions/` and `pi-custom-keybinds/` — pi-specific
  extensions/keybindings, not part of the cross-tool sync system.

### MCP tool names vs. canonical tool vocab

Subagent `tools:` is a flat CSV using a small canonical vocabulary
(`read, grep, bash`, ...) that `generate.py` translates per target. MCP
tool names are **not portable** across tools (Claude wants
`mcp__<server>__<tool>` or a `mcp__<server>__*` wildcard; OpenCode wants
`<server>_<tool>` or `<server>_*`), so they go through the separate
`mcp_tools:` nested map instead — one raw, target-specific CSV per
target key, bypassing translation entirely. Codex has no per-agent
tool/MCP scoping at all (its TOML schema is only `name`/`description`/
`model_reasoning_effort`/`sandbox_mode`/`developer_instructions`); a
`mcp_tools.codex` key is accepted but ignored with a warning.

## Editing conventions

- Skills, `context/GLOBAL.md`, and prompts are canonical here — edit
  directly in this repo, never at a tool's synced location (that bypass
  won't propagate and will be silently overwritten by the next sync).
- Subagents and MCP servers are non-canonical by design.
- After adding a subagent or MCP server, see the README's "Adding a new
  subagent" / "Adding a new MCP server" sections for the exact
  `spec.yaml` shape expected by `generate.py`.
