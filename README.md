# llm-garage

Personal, source-of-truth repo for skills, subagents, prompts/commands, and
global context, shared across multiple AI coding agents (Claude Code, OpenAI
Codex CLI, OpenCode, pi). Edit here, then sync out to each tool's native
config location.

## Layout

```
context/GLOBAL.md        canonical global instructions (-> CLAUDE.md / AGENTS.md everywhere)
skills/<name>/SKILL.md    canonical skills (same SKILL.md format across all four tools)
prompts/<name>.md         canonical, manually-invoked "/name" commands (frontmatter + $ARGUMENTS body)
mcp/pi-mcp.json           native pi MCP server defaults -- opt-in, see below
pi-custom-extensions/      one local Pi package of TypeScript extensions + tracked Bun lockfile
pi-custom-config/           tracked defaults for mutable pi extension configuration
pi-custom-keybinds/         pi-specific keybindings.json override
sync/
  lib.sh                  shared symlink + backup helpers
  config_merge.py         merges/removes config entries (MCP servers, top-level JSON keys) in tool native config files
  refresh-context7.py     pulls Context7's skill/rule content from upstream, diffs against the repo
  sync-claude.sh
  sync-codex.sh
  sync-opencode.sh
  sync-pi.sh
  sync-all.sh             link shared config + optionally merge pi MCP defaults
```

## Sync strategy

Skills, context, and prompts are linked directly from this repo; no generation
step is needed. Editing those source files takes effect immediately. Re-run
sync when adding or removing entries. Subagent syncing is not managed here.

Pi extensions load as one local package through
`~/.pi/agent/extensions/llm-garage`, with explicit entry points in
`pi-custom-extensions/package.json`. Runtime and development dependencies share
one installation; see [extension development](pi-custom-extensions/README.md).
Sync migrates legacy individual extension symlinks and preserves unrelated
local extensions. Source and manifest changes require only `/reload`.

MCP servers are **opt-in and off by default**. Currently only pi MCP servers
are managed: `sync-pi.sh --with-mcp` reads `mcp/pi-mcp.json` and merges its
`mcpServers` entries into `~/.pi/agent/mcp.json`. No shared YAML spec or
per-tool translation is involved. Claude Code, Codex, and OpenCode MCP
configuration is left to each tool.

Tracked connection settings (URL, command, args, headers, environment, etc.)
are authoritative. Each computer keeps its existing `enabled`, `exposure`, and
`toolExposure` preferences, including changes made through pi's `/mcp` UI.
Tracked preference values are used only when that field is absent locally;
`toolExposure` is preserved as a whole map, not merged per tool. Unrelated
servers and top-level settings are preserved. The live file is not symlinked,
so pi's runtime changes do not modify the repository. A one-time backup is
made before changing an existing config file.

Environment references such as `${EXA_API_KEY}` are copied literally and
resolved by pi at runtime. OAuth credentials remain in pi's own local storage,
not in this repo. Only user-level configuration is synced; project `.pi/mcp.json`
files are untouched.

```bash
./sync/sync-all.sh              # skills, memory, prompts, pi extensions/config
./sync/sync-all.sh --with-mcp   # ...plus tracked native pi MCP servers
./sync/sync-pi.sh --with-mcp    # pi only
```

`sync-pi.sh` also sets the `skills` key in `~/.pi/agent/settings.json` so pi
shares Claude Code and Codex's skill directories.

`sync-pi.sh` also installs tracked defaults from `pi-custom-config/` as
ordinary files when their live config does not exist. This is intentional for
mutable extension state: pi can update the live copy without modifying this
repository, and later syncs preserve the user's local preference.

## Detached agent launcher

`scripts/agent-spawn.sh` starts Pi in its own detached tmux session, either
interactively or as a one-shot JSON event stream. The first version supports
Pi only; Claude can be added later.

```bash
./scripts/agent-spawn.sh --name review-api --cwd "$PWD" \
  --model sonnet:high --prompt-file /path/to/task.md
# Later: tmux attach -t review-api

./scripts/agent-spawn.sh --name review-once --mode json \
  --prompt-file /path/to/task.md
# Prints the job directory containing events.jsonl, stderr.log, and exit.status
```

JSON mode requires a prompt. Its `events.jsonl` can be followed while the job
runs or replayed later; `exit.status` appears after Pi exits. A missing status
file means the job did not record a normal exit. Pi can exit with status 0 even
when an agent response failed or was aborted; inspect the JSON events for that.
By default, files are saved under `~/.local/state/agent-spawn/`; use
`--output-dir` to override the parent directory. Files may contain sensitive
prompts, tool calls, and results and are stored in private job directories. `/agents` shows a JSON-mode job only while
its process is running.

Omit the prompt to open Pi ready for input, or use `--prompt '...'` instead of
`--prompt-file` for short tasks. `--shell zsh` (the default) or `--shell bash`
starts an interactive login shell before Pi, so its startup files can set the
agent's environment. Shell names are resolved on `PATH`, or supply an absolute
path such as `--shell /usr/local/bin/zsh`; Bash is required to run the launcher.
Optional `--provider` requires `--model`; `--socket` selects a non-default tmux
server. Interactive launches confirm the process stays running briefly;
JSON launches report startup separately from Pi's eventual exit status. Run
`./scripts/agent-spawn.sh --help` for the full interface.

## Undoing a sync

```
./sync/unsync-all.sh
```

or per tool: `./sync/unsync-claude.sh`, `./sync/unsync-codex.sh`, etc.

This removes every symlink `sync-*.sh` created and restores whatever file
or directory was backed up in its place (matched by the same
`.pre-llm-garage.<timestamp>` suffix `sync-*.sh` creates, newest wins). It
only ever touches symlinks that point into this repo -- anything else at
that path is left untouched. Safe to run repeatedly; a second run is a
no-op once everything is already unsynced.

MCP server entries aren't symlinks, so they're reversed separately:
`unsync-pi.sh --with-mcp` (or `unsync-all.sh --with-mcp`) removes only the
server names currently listed in `mcp/pi-mcp.json`, preserving unrelated
servers and top-level settings. It does not restore earlier same-name entries;
use the one-time backup for manual recovery. A server removed or renamed in
the tracked config must be removed manually from the live config. Without
`--with-mcp`, unsync leaves MCP entries alone. `unsync-pi.sh` additionally
removes the `skills` key it set in `~/.pi/agent/settings.json` during sync.

## Per-tool targets

| Tool | Context file | Skills | Subagents | Commands/prompts | MCP servers (`--with-mcp` only) |
|---|---|---|---|---|---|
| Claude Code | `~/.claude/CLAUDE.md` | `~/.claude/skills/<name>/` | not managed | `~/.claude/commands/<name>.md` | not managed |
| Codex CLI | `~/.codex/AGENTS.md` | `~/.codex/skills/<name>/` | not managed | `~/.codex/prompts/<name>.md` (deprecated upstream -- prefer skills for anything auto-triggered) | not managed |
| OpenCode | `~/.config/opencode/AGENTS.md` | `~/.config/opencode/skills/<name>/` | not managed | `~/.config/opencode/commands/<name>.md` | not managed |
| pi | `~/.pi/agent/AGENTS.md` | merged into `~/.pi/agent/settings.json`'s `skills` (`~/.claude/skills` + `~/.codex/skills`) | not managed | `~/.pi/agent/prompts/<name>.md` | merged into `~/.pi/agent/mcp.json`'s `mcpServers` |

## Setup on a new machine

```
git clone <this repo> ~/Documents/Code/llm-garage
cd ~/Documents/Code/llm-garage
(cd pi-custom-extensions && bun install --frozen-lockfile)
./sync/sync-all.sh              # skip MCP (opt in with --with-mcp, see below)
```

Any existing file at a target path is renamed aside as
`<file>.pre-llm-garage.<timestamp>` before the symlink is created --
nothing is silently overwritten. Sync requires bash and `uv` (the Python helper
uses only the standard library). Pi extensions additionally require Bun to
install their dependencies and Pi matching the pinned development version.

## Windows

Not supported yet. `sync/lib.sh` refuses to run on anything but
macOS/Linux (`uname` check) rather than silently failing halfway through a
sync. If/when this is worth solving: either run these scripts under WSL
(simplest -- symlinks work as-is against the WSL filesystem, though native
Windows-installed agents won't see them), or write a `sync-*.ps1` variant
using `New-Item -ItemType SymbolicLink` (requires Developer Mode or admin)
with a copy-file fallback when symlink creation is denied.

## Adding a new MCP server

Edit `mcp/pi-mcp.json` using pi's native `mcpServers` format. It supports
stdio (`command`, `args`, `env`, `cwd`) and streamable HTTP (`url`, `headers`,
`oauth`), plus pi-specific `exposure` and `toolExposure`. Keep secrets out of
tracked files; use environment references instead.

```bash
$EDITOR mcp/pi-mcp.json
./sync/sync-pi.sh --with-mcp
```

Run `/reload` in an existing pi session after syncing, or start a new session.
Use `/mcp` to inspect connections. MCP configuration for other tools is not
managed here.

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
