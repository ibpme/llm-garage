# `/agents`: subagent jobs and Pi/Claude Code processes

Browse one-shot subagent jobs and live Pi and Claude Code processes. Pi discovery
uses a fresh `ps` snapshot; Claude discovery uses `claude agents --json`, then
matches live PIDs in that snapshot. Both work without tmux. Inside tmux, process
ancestry also maps processes to panes, including processes behind wrapper shells
and panes in detached sessions. Saved transcripts and `pane_current_command` are
not used to establish liveness.

Jobs come from the durable job store (`shared/agent-jobs`), are loaded without
waiting for process or tmux discovery, and show their own recorded state. Running
foreground jobs are labeled `foreground`, or `foreground (detached)` when no
foreground wait in this Pi process is attached to them (for example after the
launching Pi crashed). Job headers show the latest completed call's tokens and
context capacity, like the tool display; cumulative totals are not shown.

## Load

From the repository root:

```bash
./sync/sync-pi.sh
```

Run `/reload` in each existing Pi instance, or start a new one. For a one-off
invocation without syncing:

```bash
pi -e ./pi-custom-extensions/agents/index.ts
```

## Controls

Run `/agents` in any Pi TUI. tmux is only needed for pane actions.

List view:

| Key | Action |
|---|---|
| Up/Down or `j`/`k`, PageUp/PageDown, Home/End | Navigate |
| Tab / Shift+Tab | Cycle filters: **This session** (default: jobs started by this Pi session, followed by live processes), **All live** (running jobs of any session and all live processes), **Recent jobs** (up to 100, newest first) |
| Enter | Job or headless process: open details. Interactive tmux pane: switch the existing tmux client to its session, window and pane |
| `c` | Cancel the selected job after an inline `[y/n]` confirmation naming it (owned, unfinished jobs only) |
| `a` | Acknowledge the selected finished job (owned only). This clears it from this session's indicator and does not notify the model |
| `b` | Send the selected foreground job to the background: its tool call returns a receipt and the same child keeps running. Only for running jobs of this session whose foreground wait is attached in this Pi; the same transition as the one-shot shortcut. Opening or closing the modal never changes a job's waiting mode |
| Shift+V (`V`) | Move the selected pane into the invoking window, above/below the invoking pane (`join-pane -v`) |
| Shift+H (`H`) or Shift+Enter | Move the selected pane into the invoking window, left/right of the invoking pane (`join-pane -h`) |
| Ctrl+X | Kill the selected agent's entire tmux pane (the current pane is protected; never offered for jobs) |
| `r` | Refresh immediately |
| Escape, Ctrl+C or `q` | Close |

Detail view (replaces the list inside the same modal; refreshes every second):

| Key | Action |
|---|---|
| Tab / Shift+Tab | Cycle **Activity**, **Result**, **Task** (jobs) |
| Up/Down or `j`/`k`, PageUp/PageDown, Home/End | Scroll. At the bottom the view follows new activity; scrolling up stops following and shows "new activity — End to follow" |
| `b` / `c` / `a` | Send to background / cancel / acknowledge, as in the list |
| Escape, Ctrl+C or `q` | Back to the list with selection and scroll preserved |

Pane actions outside tmux, or on rows without a pane, show a "require tmux" error.

The viewer opens immediately as a centered, focused floating modal over the
existing TUI. It shows **Discovering agents…** while process discovery runs in
the background; slow discovery does not delay opening or closing the modal.
The underlying conversation remains visible around it. Closing restores the
previous focus without replacing the editor.

The modal has a themed border with header/footer separators. On larger terminals
it uses roughly 85% of the width and 75% of the height, capped at 120 columns and
36 rows. Smaller terminals use an almost-full-area compact layout. Dimensions
adapt on resize, and the modal stays the same size during refreshes and kill
confirmations. Shift+Enter requires tmux to forward modified
keys (see Pi's tmux setup docs); Shift+H remains available as an alternative.

Process discovery refreshes every two seconds and job state every second; selection
is preserved. Rows show provider or job name, state, pane location, PID,
current-pane marker, and available session name, working directory, model and
waiting reason. Job rows show state (with "supervisor lost" when the supervisor
died but the child still runs), elapsed time, quiet time for running jobs, and
whether another session owns them.

Every row is selectable; its capabilities decide the actions:

- **Owned job**: details (activity timeline, result, task and metadata), cancel,
  acknowledge. **Other session's job**: details only.
- **Interactive process in a tmux pane**: attach, split, kill (as before). Its
  details are available outside tmux too, minus the pane.
- **Unmanaged headless process** (print/RPC/JSON, Claude background, no pane):
  process metadata only; no log or control access.

A live process that descends from a running job's verified child process-group
leader (PID and start time both match) is shown as the job, not as a separate row.
A stored job record never makes a process look alive: liveness comes from the job
reconciliation, and processes only come from the live `ps` snapshot.

Opening or viewing a job writes nothing. The Result section renders the final
answer as Markdown (first 256 KiB, with a truncation notice) or, while running,
a "partial preview". The Task section shows the task and metadata (cwd, owner
session, job directory, result path, PIDs, terminal reason, stderr tail).

Splitting **moves the entire existing pane**; it does not restart or
clone the agent. If that was the last pane in its source window, tmux removes the empty
window (and possibly its session). Moving the current pane into itself is rejected.

Ctrl+X asks for confirmation: `y` kills the selected pane with `kill-pane`;
`n` or Escape cancels. The picker stays open and refreshes after a kill. Killing terminates
all processes in that pane. The invoking pane is protected, even when
another agent in the same pane is selected. PID, start time and pane ancestry are
rechecked before killing; stale or moved agents are rejected.

Enter uses `switch-client`, never a nested `attach-session`. If multiple clients
are attached to the invoking session, the most recently active one is switched.
An unattached invoking session cannot redirect an unrelated session's client.

## Status

Claude Code supplies **busy**, **waiting** and **idle** status directly through
`claude agents --json`, along with a waiting reason when available. No Claude
hooks or custom status files are needed. Background processes may also report
job state when a live status is unavailable.

Pi reports:

- **working**: this extension reports the agent is busy.
- **idle**: this extension reports the agent is idle.
- **running (status unknown)**: the process is alive, but has not loaded this
  extension, uses a different agent directory, or has no valid recent heartbeat.

Each Pi instance, including instances outside tmux, publishes private metadata
to `<agent-dir>/agents-live/<pid>.json` (default: `~/.pi/agent/agents-live/`).
It contains process start time, session ID and file path, optional name, working
directory and selected model, plus whether it is in interactive TUI mode, but
no prompts, responses or credentials. Updates happen on lifecycle events and every five
seconds. Normal shutdown/reload/session replacement removes the record; records
left by crashes expire from the UI after twenty seconds. PID/start-time checks
prevent stale records from being trusted after PID reuse. A record alone never
makes a process appear in the picker.

## Claude model metadata

Claude's live-session CLI does not expose the model. The optional status-line
wrapper saves `model.id` and `model.display_name` from Claude's status-line JSON,
then passes the **unchanged input bytes** to the existing renderer. Its stdout,
stderr and exit status are preserved; metadata failures do not break rendering.
Cancellation is forwarded to the renderer's process group.

Install from the repository root (requires Node on `PATH` and an existing
command-based Claude status line):

```bash
node pi-custom-extensions/agents/scripts/install-claude-statusline.mjs
```

This changes only `statusLine.command` in Claude's user settings, preserves the
existing renderer and other settings, and creates a timestamped settings backup.
It does not change `subagentStatusLine`. Re-running it is safe. Claude reloads
settings automatically; run `/reload` in Pi to load the discovery changes.

Custom locations are supported:

```bash
node pi-custom-extensions/agents/scripts/install-claude-statusline.mjs \
  --settings /path/to/claude/settings.json \
  --agent-dir /path/to/pi/agent
```

Defaults respect `CLAUDE_CONFIG_DIR` and `PI_CODING_AGENT_DIR`. The configured
registry path and absolute wrapper path are fixed at installation time. Before
changing the registry directory or moving the repo/scripts, uninstall using the
same settings file, then install again from the new location with the desired
`--agent-dir`. Running the installer again without uninstalling does not update
these paths.
This integration is opt-in and is not modified by the normal sync scripts.

Records live at `<agent-dir>/agents-live/claude/<session_id>.json`, with private
permissions and atomic writes using unique temporary files. The wrapper also
tightens existing Claude registry and endpoint directories to mode `0700`. They contain only:

```json
{
  "version": 1,
  "sessionId": "session-uuid",
  "updatedAt": 1791517140387,
  "model": "model-id",
  "displayName": "Model display name"
}
```

Discovery joins the record to `sessionId` from `claude agents --json`. The model
ID is shown first in row descriptions; the display name is also available in
metadata. No prompts, transcripts, credentials or cost data are stored. Records
alone never create a row or make a process selectable.

Unlike Pi's heartbeat, these are **last-reported model snapshots**. They remain
usable during long idle periods, but must be written after the current process
started. Old-process records, invalid session IDs, malformed data and future
timestamps are ignored. A resumed session needs a new status-line update before
its model is shown. Records are not automatically removed on Claude exit.
Updates follow Claude's status-line triggers; optionally set `statusLine.refreshInterval`
in Claude settings for periodic refreshes. A session that does not execute the
status line, including some headless sessions, has no captured model metadata.

Undo with:

```bash
node pi-custom-extensions/agents/scripts/install-claude-statusline.mjs --uninstall
```

Use the same `--settings` argument if installed at a custom location. Uninstall
restores only the original renderer command, preserving later changes to other
settings. It refuses to overwrite a renderer manually changed after installation.
The adjacent `settings.json.agents-statusline-backup.json` stores installation
state for undo; timestamped backups and captured metadata are retained.

## Claude messaging endpoint registry

When Claude's status-line subprocess has `CLAUDE_CODE_MESSAGING_SOCKET` in its
environment, the same opt-in wrapper records it **separately** from the model
snapshot at `<agent-dir>/agents-live/claude/endpoints/<session_id>.json`:

```json
{
  "version": 1,
  "sessionId": "session-uuid",
  "capturedAt": 1791517140387,
  "socketPath": "/path/to/claude/messaging.sock"
}
```

The path is sensitive connection metadata: the directory is created with mode
`0700`, the file with `0600`, and writes are atomic. The wrapper never prints the
path or passes it to the renderer except through the renderer's pre-existing
environment. If the variable is absent or invalid, no endpoint record is written.
Old records may remain after exit; they do not imply a live or reachable endpoint.

For a temporary live diagnostic, run `/reload` in Pi and then:

```text
/diagnostics:claude-endpoints             # list live Claude sessions and endpoint capture state
/diagnostics:claude-endpoints --probe     # additionally attempt a short connection (sends no message)
/diagnostics:claude-endpoints --paths     # explicitly reveal stored socket paths in the Pi UI
```

This command does not require tmux. It shows only sessions with live PIDs returned
by `claude agents --json`; a missing endpoint may simply mean Claude has not run
its status line since loading the updated wrapper. Paths are hidden by default.
A successful probe establishes only socket reachability, not messaging support.

`readClaudeEndpoint()` checks the session ID, record shape, timestamp, and the
supplied process start time; it does not independently establish liveness. For
future messaging integrations, `connectClaudeEndpoint()`
rechecks the session/PID through `claude agents --json`, checks `ps` for PID reuse,
checks that the path is an owned Unix socket (not a symlink), and attempts a
short-timeout connection. It returns a connected socket or `undefined`; callers
must close the socket and implement their own protocol, authorization, and error
handling. `/agents` does not connect to or display messaging sockets.

The endpoint is best-effort: it requires the optional wrapper, a status-line
invocation with a session ID, and the environment variable reaching that subprocess.
It can be captured even if the status-line input has no model ID.
Inheritance was verified for an interactive session on Claude Code 2.1.295;
background/headless coverage has not been verified. Hook-based startup/exit
capture remains a possible follow-up, not a current dependency.

## Scope and limitations

- macOS/Linux and interactive Pi are required; tmux is only needed for pane actions.
- Only the server identified by the invoking process's `TMUX` variable is scanned
  for panes. Processes elsewhere are displayed read-only, even if they belong to
  another tmux server.
- Claude Code must be on `PATH` and support `claude agents --json`. A missing
  executable simply leaves Pi discovery enabled; command failures or invalid JSON
  show a warning while preserving the Pi list. Discovery follows the current
  `CLAUDE_CONFIG_DIR` when set. Onboarding processes not yet registered by Claude
  are not discovered.
- Pi process identification recognizes the `pi` executable/process title, or Node/Bun
  with Pi's CLI path as the first argument. Custom launchers that hide both are
  not recognized. Processes on another machine reached through SSH are not local
  descendants and are not discovered.
- Pi's busy/idle is not a full agent-state model: it does not distinguish waiting
  for an extension dialog, success, or failure. Uninstrumented Pi processes use
  CLI flags to identify headless mode; if a launcher hides those flags, mode may
  be unknown until the extension loads. Claude's live status comes from its CLI.
- Actions recheck the PID, start time and pane before changing tmux; exits, moves,
  missing clients and insufficient split space are reported as errors.

## Development checks

```bash
cd pi-custom-extensions
bun run typecheck
bun test ./agents/
```
