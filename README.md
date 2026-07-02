# llm-garage

Personal, source-of-truth repo for skills, subagents, prompts/commands, and
global context, shared across multiple AI coding agents (Claude Code, OpenAI
Codex CLI, OpenCode, pi). Edit here, then sync out to each tool's native
config location.

## Layout

```
context/GLOBAL.md        canonical global instructions (-> CLAUDE.md / AGENTS.md everywhere)
skills/<name>/SKILL.md    canonical skills (same SKILL.md format across all four tools)
subagents/<name>/         non-canonical -- deferred, not synced into any live tool config (see below)
  spec.yaml               description, tools, per-target model map, optional thinking/max_turns
  prompt.md               the subagent's system prompt body
prompts/<name>.md         canonical, manually-invoked "/name" commands (frontmatter + $ARGUMENTS body)
mcp/<name>/spec.yaml      non-canonical MCP server spec (stdio command + args) -- opt-in, see below
sync/
  generate.py             subagents/ + prompts/ + mcp/ -> build/<target>/... (native format per tool)
  lib.sh                  shared symlink + backup helpers
  mcp_merge.py            merges/removes one MCP server entry into a tool's native config file (--with-mcp only)
  refresh-context7.py     pulls Context7's skill/rule content from upstream, diffs against the repo
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

MCP servers (`mcp/`) are **opt-in and off by default** -- setting up MCP
servers is a coding agent's own responsibility, not this repo's, so
`sync-*.sh` skip them unless you pass `--with-mcp`. When you do opt in,
their native config files (`~/.claude.json`, `~/.codex/config.toml`,
`~/.pi/agent/mcp.json`) also hold each tool's own unrelated state -- auth,
project lists, other servers not managed by this repo -- so even the
*generated* fragment can't be symlinked into place. Instead
`sync-claude.sh`/`sync-codex.sh`/`sync-pi.sh` call `mcp_merge.py` to upsert
just that one server's entry/table, leaving the rest of the file untouched
(with a one-time backup on first write, see `mcp_merge.py`'s
`_backup_once`). `unsync-*.sh --with-mcp` reverses this by deleting just
that entry. OpenCode isn't included in `mcp/` sync at all -- MCP servers
there are configured through its own plugin ecosystem.

Practical effect: after editing anything under `subagents/`, `prompts/`,
or `mcp/`, re-run sync (regeneration isn't automatic on `git pull`):

```
git pull
./sync/sync-all.sh              # skills, memory, commands/prompts, subagents
./sync/sync-all.sh --with-mcp   # ...plus MCP servers under mcp/
```

Editing `context/GLOBAL.md` or `skills/` takes effect immediately since
those are direct symlinks -- no regeneration step.

## Undoing a sync

```
./sync/unsync-all.sh
```

or per tool: `./sync/unsync-claude.sh`, `./sync/unsync-codex.sh`, etc.

This removes every symlink `sync-*.sh` created and restores whatever file
or directory was backed up in its place (matched by the same
`.pre-llm-garage.<timestamp>` suffix `sync-*.sh` creates, newest wins). It
only ever touches symlinks that point into this repo -- anything else at
that path is left untouched. `unsync-all.sh` also deletes `build/`, since
it's just generated output. Safe to run repeatedly; a second run is a
no-op once everything is already unsynced.

MCP server entries aren't symlinks, so they're reversed separately: run
`unsync-*.sh --with-mcp` (matching however you synced) to also remove this
repo's entries from the relevant native config file (`~/.claude.json`,
`~/.codex/config.toml`, `~/.pi/agent/mcp.json`) via `mcp_merge.py`, leaving
everything else in those files untouched. Without `--with-mcp`, unsync
leaves MCP entries alone.

## Per-tool targets

| Tool | Context file | Skills | Subagents | Commands/prompts | MCP servers (`--with-mcp` only) |
|---|---|---|---|---|---|
| Claude Code | `~/.claude/CLAUDE.md` | `~/.claude/skills/<name>/` | `~/.claude/agents/<name>.md` | `~/.claude/commands/<name>.md` | merged into `~/.claude.json`'s `mcpServers` |
| Codex CLI | `~/.codex/AGENTS.md` | `~/.codex/skills/<name>/` | `~/.codex/agents/<name>.toml` | `~/.codex/prompts/<name>.md` (deprecated upstream -- prefer skills for anything auto-triggered) | merged into `~/.codex/config.toml`'s `[mcp_servers.<name>]` |
| OpenCode | `~/.config/opencode/AGENTS.md` | `~/.config/opencode/skills/<name>/` | `~/.config/opencode/agents/<name>.md` | `~/.config/opencode/commands/<name>.md` | not managed here (see `mcp/` section below) |
| pi | `~/.pi/agent/AGENTS.md` | none needed -- pi's `settings.json` already points at `~/.claude/skills` and `~/.codex/skills` | `~/.pi/agent/agents/<name>.md` | `~/.pi/agent/prompts/<name>.md` | merged into `~/.pi/agent/mcp.json`'s `mcpServers` |

## Setup on a new machine

```
git clone <this repo> ~/Documents/Code/llm-garage
cd ~/Documents/Code/llm-garage
./sync/sync-all.sh              # skip mcp/ (opt in with --with-mcp, see below)
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

**Subagents are non-canonical.** Subagent syncing is currently deferred:
the `link_dir_contents ... agents` line is commented out in each
`sync/sync-<target>.sh` -- skills now cover most of what subagents were
used for here. `subagents/` and `generate.py`'s subagent translation still
work (`build/<target>/agents/` still gets generated), it just isn't linked
into any live tool config. Uncomment that line per target to resume.

```
mkdir subagents/my-agent
$EDITOR subagents/my-agent/spec.yaml   # description, tools, model per target
$EDITOR subagents/my-agent/prompt.md   # system prompt body
./sync/sync-all.sh
```

`spec.yaml` is a deliberately small YAML subset (flat keys, plus two
nested maps -- `model:` and `mcp_tools:`) parsed by a ~30-line hand-rolled
parser in `generate.py` -- not a general YAML parser. Keep new specs
within that shape (see `subagents/subagent-or-skill/spec.yaml` for the
reference example).

### Tool names: portable vocab vs. raw MCP names

`tools:` (a flat CSV, e.g. `read, grep, bash`) uses a small canonical
vocabulary that `generate.py` translates per target -- `CLAUDE_TOOL_MAP`
and `OPENCODE_TOOL_MAP` at the top of the file. Codex has no per-tool
allow-list at all, so `tools:` is translated into a `sandbox_mode`
instead (`workspace-write` if `write`/`edit` is present, else
`read-only` -- see `codex_sandbox_mode()`; `bash` alone doesn't force
`workspace-write`, since a read-only sandbox still runs shell commands
for things like grep/find, it just blocks writes).

MCP tool names aren't portable across targets (Claude wants
`mcp__<server>__<tool>` or a `mcp__<server>__*` wildcard; OpenCode wants
`<server>_<tool>` or `<server>_*`), so they can't go through the
canonical vocab. Use the optional `mcp_tools:` nested map instead, with
one raw, target-specific CSV per key:

```yaml
mcp_tools:
  claude: mcp__context7__query-docs, mcp__context7__resolve-library-id
  opencode: context7_*
  pi: mcp__context7__query-docs
```

These bypass all translation and get appended straight into each
target's tool declaration. **Codex has no per-agent tool or MCP scoping
at all** -- its custom-agent TOML schema is only
`name`/`description`/`model_reasoning_effort`/`sandbox_mode`/
`developer_instructions`; MCP servers are wired up globally in
`~/.codex/config.toml`, not per role. A `mcp_tools.codex` key is
accepted but ignored, with a warning at generate time -- there's no
native mechanism to honor it.

## Adding a new MCP server

**MCP servers are opt-in.** Setting up MCP servers is a coding agent's own
responsibility, not this repo's -- `sync-*.sh` never touch them unless you
explicitly pass `--with-mcp`.

```
mkdir mcp/my-server
$EDITOR mcp/my-server/spec.yaml   # name, command, args (stdio only)
./sync/sync-all.sh --with-mcp
```

`spec.yaml` only supports stdio servers (`command` + a space-separated
`args` string) -- see `mcp/context7/spec.yaml` for the reference example.
There's no per-target model map here like subagents have; Claude Code and
pi share one JSON entry shape, and Codex gets the same command/args
translated into TOML. Add remote (HTTP/SSE) support to `generate.py`'s
`gen_mcp()` if you need it later.

Optional `auth_env` + `auth_flag` keys let a server take an API key from
your local shell environment at generate time instead of storing it in
the repo: if `auth_env`'s named variable is set when you run
`sync-all.sh`, `generate.py` appends `<auth_flag> <value>` to `args`; if
unset, the flag is silently omitted (the server just runs unauthenticated
-- this should never be a hard failure, only a capability downgrade). The
resolved value only ever lands in `build/` (gitignored) and the merged
live config file on your machine, never in a file this repo tracks.

## Keeping Context7 in sync with upstream

Context7's own skill (`skills/context7-mcp/SKILL.md`) and rule content
(the Context7 section in `context/GLOBAL.md`, inside `<!-- context7 -->`
markers) are pulled from Upstash's public sources -- the same ones their
`ctx7` setup CLI uses -- rather than maintained by hand. Run:

```
./sync/refresh-context7.py
```

to check for upstream changes. It only touches those two files in this
repo (never a live tool config) and never commits -- review with `git
diff` and commit if the update looks right.
