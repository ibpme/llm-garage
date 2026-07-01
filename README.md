# llm-garage

Personal, source-of-truth repo for skills, subagents, prompts/commands, and
global context, shared across multiple AI coding agents (Claude Code, OpenAI
Codex CLI, OpenCode, pi). Edit here, then sync out to each tool's native
config location.

## Layout

```
context/GLOBAL.md        canonical global instructions (-> CLAUDE.md / AGENTS.md everywhere)
skills/<name>/SKILL.md    canonical skills (same SKILL.md format across all four tools)
subagents/<name>/
  spec.yaml               description, tools, per-target model map, optional thinking/max_turns
  prompt.md               the subagent's system prompt body
prompts/<name>.md         manually-invoked "/name" commands (frontmatter + $ARGUMENTS body)
sync/
  generate.py             subagents/ + prompts/ -> build/<target>/... (native format per tool)
  lib.sh                  shared symlink + backup helpers
  sync-claude.sh
  sync-codex.sh
  sync-opencode.sh
  sync-pi.sh
  sync-all.sh             regenerate + sync everything
build/                    generated output (gitignored, rebuilt every run)
```

## Why generate instead of pure symlink

Skills and context files are byte-identical across all four tools, so those
are plain symlinks. Subagents are not: each tool names models differently
(`sonnet` vs `anthropic/claude-opus-4-6` vs a Codex-specific id vs its own
TOML schema), so a subagent's canonical spec is translated per target by
`generate.py`, and the *generated* file is what gets symlinked into place.
Prompts/commands are close enough across tools (same `$ARGUMENTS`/`$1`
placeholder body) that they're passed through with only minor frontmatter
differences.

Practical effect: after editing anything under `subagents/` or `prompts/`,
re-run sync (regeneration isn't automatic on `git pull`):

```
git pull
./sync/sync-all.sh
```

Editing `context/GLOBAL.md` or `skills/` takes effect immediately since
those are direct symlinks -- no regeneration step.

## Per-tool targets

| Tool | Context file | Skills | Subagents | Commands/prompts |
|---|---|---|---|---|
| Claude Code | `~/.claude/CLAUDE.md` | `~/.claude/skills/<name>/` | `~/.claude/agents/<name>.md` | `~/.claude/commands/<name>.md` |
| Codex CLI | `~/.codex/AGENTS.md` | `~/.codex/skills/<name>/` | `~/.codex/agents/<name>.toml` | `~/.codex/prompts/<name>.md` (deprecated upstream -- prefer skills for anything auto-triggered) |
| OpenCode | `~/.config/opencode/AGENTS.md` | `~/.config/opencode/skills/<name>/` | `~/.config/opencode/agents/<name>.md` | `~/.config/opencode/commands/<name>.md` |
| pi | `~/.pi/agent/AGENTS.md` | none needed -- pi's `settings.json` already points at `~/.claude/skills` and `~/.codex/skills` | `~/.pi/agent/agents/<name>.md` | `~/.pi/agent/prompts/<name>.md` |

## Setup on a new machine

```
git clone <this repo> ~/Documents/Code/jv-llm-garage
cd ~/Documents/Code/jv-llm-garage
./sync/sync-all.sh
```

Any existing file at a target path is renamed aside as
`<file>.pre-llm-garage.<timestamp>` before the symlink is created --
nothing is silently overwritten. Requires Python 3 (stdlib only, no pip
install needed) and bash.

## Windows

Not supported yet. `sync/lib.sh` refuses to run on anything but
macOS/Linux (`uname` check) rather than silently failing halfway through a
sync. If/when this is worth solving: either run these scripts under WSL
(simplest -- symlinks work as-is against the WSL filesystem, though native
Windows-installed agents won't see them), or write a `sync-*.ps1` variant
using `New-Item -ItemType SymbolicLink` (requires Developer Mode or admin)
with a copy-file fallback when symlink creation is denied.

## Adding a new subagent

```
mkdir subagents/my-agent
$EDITOR subagents/my-agent/spec.yaml   # description, tools, model per target
$EDITOR subagents/my-agent/prompt.md   # system prompt body
./sync/sync-all.sh
```

`spec.yaml` is a deliberately small YAML subset (flat keys + one nested
`model:` map) parsed by a ~30-line hand-rolled parser in `generate.py` --
not a general YAML parser. Keep new specs within that shape (see
`subagents/explore/spec.yaml` for the reference example).
