# `/agents`: live registry browser

Browse Pi and Claude agents recorded by the standalone
[`agents-registry` daemon](../../agents-registry/README.md). The extension reads
`agents.jsonl` and `registry-health.json`; it does not discover agents, publish
status, start the daemon, track jobs, or spawn agents.

## Setup

Install the Pi package dependencies and sync as described in
[extension development](../README.md), then `/reload` existing Pi sessions.
Start the registry explicitly from the repository root:

```bash
cd agents-registry
npm install
npm run build
node dist/cli.js start --background
```

To map tmux panes, start the daemon with the server socket explicitly configured:

```bash
node dist/cli.js start --background --tmux-socket /absolute/path/to/tmux/socket
```

The daemon does not automatically use `TMUX`. Stop an existing daemon before
changing its configuration. Multiple `--tmux-socket` arguments are supported.

Browser and publisher resolve the same directory: `AGENTS_REGISTRY_DIR`, then
`$XDG_STATE_HOME/agents-registry`, then `~/.local/state/agents-registry`.
The independent `registry-publisher.ts` extension reports Pi session, model, and
activity metadata. Without it, Pi processes still appear but have unknown activity
and limited metadata. Claude activity comes from the daemon's Claude CLI queries.

For a one-off browser without the package:

```bash
pi -e ./pi-custom-extensions/agents/index.ts
```

## Controls

| Key | Action |
|---|---|
| Up/Down or `j`/`k`, PageUp/PageDown, Home/End | Navigate; scroll in details |
| Enter | Attach to an eligible interactive pane; otherwise show details |
| `i` | Show metadata, including for attachable agents |
| `V` | Move the existing pane into a top/bottom split |
| `H` or Shift+Enter | Move the existing pane into a left/right split |
| Ctrl+X | Confirm killing the entire selected pane with `y`/`n` |
| `r` | Refresh |
| Escape, Ctrl+C, or `q` | Cancel confirmation, return from details, or close |

The centered modal opens immediately and refreshes every two seconds. Its size
fills the terminal with a one-cell margin, including on large displays. The current
session is pinned first, followed by **Interactive (tmux)** and **Non-tmux** groups.
The Non-tmux group also includes every non-interactive, background, or unknown-mode
agent, even when it has a mapped tmux pane. Only interactive agents with mapped
panes belong to Interactive (tmux); the pinned current session is the exception.
Within each group, sessions sort by **waiting → busy → idle → unknown**, then name.
Status badges, section headings, selection, and registry health use theme colors.
PID and tmux pane numbers are hidden in the list and remain available in details.
Selection follows harness + PID + numeric process start
time, independent of pane moves. Details show process identity, observation time,
activity and source, session, working directory, model, and tmux server/location.
Registry strings are sanitized before terminal rendering.

## Freshness and actions

The browser distinguishes:

- **fresh**: running writer and recent successful process discovery;
- **degraded**: recent observations with discovery errors or invalid snapshot lines;
- **stale**: stopped/starting writer, missing successful process discovery, or writer/
  process-discovery timestamps older than 30 seconds or excessively in the future;
- **unavailable**: missing/unreadable files or invalid health data.

Invalid lines are skipped independently, with a warning. An empty snapshot is
only an empty registry observation, not evidence of a healthy writer. Stale rows
remain inspectable but cannot authorize pane actions. Individual observations older
than 30 seconds are also read-only. Keep the daemon's scan interval comfortably
below this threshold (default: five seconds).

Pane actions require an interactive agent with a mapped pane on the invoking
Pi's tmux server. Agents on other servers, headless agents, and unmapped agents
remain inspectable. Both server and pane identify the current-pane marker.

Every action reopens registry health and checks the selected lifetime is still
listed. It then takes fresh UTC `ps` and tmux pane snapshots, checks PID/start
time and pane ancestry, and verifies the invoking pane exists before changing
tmux. Exited, reused, or moved processes are rejected. Registry health and snapshot
files are individually atomic, not a transactional pair; action-time verification
is therefore still necessary.

Attach switches the most recently active client in the invoking session, never
starts a nested attachment, and never redirects an unrelated session's client.
Split moves the entire existing pane; it does not clone or restart the agent.
Kill terminates all processes in the pane. The invoking pane cannot be moved or
killed; attaching to it is a verified no-op.

## Deliberately excluded

The browser has no job-store dependency, job history/results, job ownership,
job/process deduplication, cancel/acknowledge/background controls, or spawning.
Managed children appear like any other registry agent. Existing delegation and
spawning infrastructure remains separate; use the `jobs` tool for existing
job inspection/results/cancellation and the agent-task shortcut for backgrounding.

The old `/diagnostics:claude-endpoints` command and endpoint reader/prober have
been removed. No messaging socket paths are read, displayed, or dialed.

The existing opt-in Claude status-line capture scripts under `scripts/` are
retained unchanged for compatibility with installed wrappers. They write legacy
model/endpoint records, **not** registry publications. The new browser does not
consume them. To publish Claude models to the registry, use its separate
[opt-in status-line publisher](../../agents-registry/README.md#optional-claude-status-line-model-publisher).
To restore the original legacy status line:

```bash
node pi-custom-extensions/agents/scripts/install-claude-statusline.mjs --uninstall
```

Use the original `--settings` argument if installed at a custom location. Existing
legacy records are not automatically deleted.

## Implementation and checks

- `index.ts`: command registration and runtime configuration.
- `reader.ts`: canonical snapshot schema validation and health classification.
- `browser.ts`: modal state, refresh, navigation, confirmations, action dispatch.
- `view.ts`: list/details, responsive framing, action eligibility.
- `tmux-actions.ts`: numeric identity/ancestry checks and pane operations.

Snapshot types and schema come from `agents-registry`; the reader has no dependency
on its build output or daemon installation. Ajv is installed with the Pi package.

```bash
cd pi-custom-extensions
bun run check
```

Tests cover file-backed reader states, invalid data, selection, responsive rendering,
late async results, stale-action refusal, confirmations, identity checks, and pane
operations against an isolated real tmux server when available.
