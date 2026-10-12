# One-shot prototype integration

Status: implementation plan; integration only, with hardening deferred.

## Goal and baseline

Integrate the background-job prototype from `origin/dev/impl-oneshot-proto`
(reviewed at `93519d1`) onto `dev/subagents` (reviewed at `9113635`). Preserve
current launcher and rendering behavior while adding configurable launch defaults
and a user action to send a running foreground delegation into the background.

This plan supersedes the implementation sequence and unconditional
background-default rollout in [background-subagents.md](background-subagents.md).
That document remains design reference for durable jobs, ownership, results and
viewer behavior. Where they differ, this plan controls the integration scope and
foreground/background contract.

## Scope

Include:

- Prototype job storage, independent supervision, receipts, management tool,
  completion indicator/notices and `/agents` job browsing.
- One local JSON config controlling the default mode and shortcut availability.
- One supervised execution path for foreground and background jobs.
- User-triggered foreground-to-background switching without restarting the child.
- Preservation of current child-role propagation, session-persistence flags,
  latest-call usage and context-window display.
- Targeted integration tests and user documentation.

Defer the separate hardening work identified in the prototype review: stronger
cross-process finalization, notice-persistence reconciliation, atomic concurrency
admission, expanded record/path validation, broad crash/PID-reuse testing,
retention redesign and polling-performance work. Preserve existing prototype
protections and tests; this integration is not a claim that those review findings
are resolved. Fix direct porting defects that prevent the included features from
working, rather than expanding this into a hardening pass.

Also defer interactive messaging/resume, background-to-foreground switching,
exit-confirmation prompts, a global daemon and a separate `/agents` config.

## User configuration

Tracked defaults: `pi-custom-config/oneshot-subagent.json`.
Local mutable config: `~/.pi/agent/oneshot-subagent.json`, resolved through Pi's
agent-directory mechanism rather than assuming the default directory at runtime.

Shipped defaults:

```json
{
  "defaultMode": "foreground",
  "allowBackgroundShortcut": true
}
```

To launch in the background by default:

```json
{
  "defaultMode": "background",
  "allowBackgroundShortcut": true
}
```

Rules:

- Explicit tool `mode` overrides `defaultMode`; omission uses the configured mode.
- Missing config/fields use shipped defaults. Invalid values produce a concise
  warning and fall back to defaults for those fields.
- Read config on extension load/reload. Live file watching and a command that
  edits the default are outside this integration.
- `allowBackgroundShortcut` controls the shortcut only. Explicit background
  launches and the `/agents` action remain available.
- Sync copies the tracked default only when the local file is missing, matching
  the mutable-default convention for `prompt-suggestions.json`. Existing local
  preferences survive sync and unsync.
- The tool description, prompt snippet and guidelines explain the effective
  default. Do not advertise an unconditional background default.
- Select a conflict-free shortcut during implementation using the installed Pi
  shortcut mechanism; document its actual customization mechanism after checking
  Pi's supported interface. Avoid a second shortcut configuration system here.

Execution preferences belong to the one-shot extension. `/agents` reads the same
job capabilities and invokes the shared job module; it owns no duplicate setting.

## Execution and waiting contract

Both modes create the same independently supervised, durable job. Foreground is
an attached parent wait, not a different child execution implementation.

Keep the supervisor detached independently of the parent. The current launcher
hosts the child in a detached tmux session; tmux is not the supervisor. Launching
requires tmux, but the parent need not run inside tmux. Durable history/result
browsing remains available without a live tmux server.

Persist the current parent waiting policy separately from execution state:
`foreground` or `background`. A foreground job can become background without
changing its job ID, child process, deadline, logs or task.

| Event | Foreground job | Accepted background job |
| --- | --- | --- |
| Normal completion | Tool returns final answer and usage | Result available through management tool |
| User sends to background | Tool releases wait and returns receipt | Already background; no change |
| Esc cancels launch/tool generation | Cancel job while still foreground | Continues after accepted launch |
| Parent shutdown/reload/session switch | Cancel still-attached foreground job | Continues |
| Explicit owned-job cancellation | Stop execution | Stop execution |
| Cancel management-tool wait | Stop waiting only | Stop waiting only |

Before releasing a foreground wait, record its background policy and remove it
from cancel-on-parent-shutdown tracking. Backgrounding must not use the execution
abort controller. The foreground wait needs a separate release mechanism.

If completion wins the transition, return the final answer. If backgrounding wins,
return a receipt even if completion follows immediately. An accepted job that
finishes before receipt delivery remains an accepted job, not a launch failure.
Receipt text reflects the observed state rather than always saying "running".

Timeout is chosen at launch: retain 600s for foreground and 1800s for background,
with the existing 3600s maximum. Sending a foreground job to the background does
not extend or reset its original deadline.

Usage is returned with the foreground answer or subsequent terminal-result
retrieval, never with a receipt. After a foreground answer is returned, use the
prototype's delivery/usage markers to prevent later duplicate accounting/notices.
Backgrounding returns no final usage and leaves the result pending retrieval.

## User action and targeting

The shortcut sends a foreground delegation into the background:

- One eligible owned foreground job: act immediately.
- Multiple eligible jobs: present a small chooser using job names and IDs.
- No eligible job: show a concise informational notice.
- Launch not yet acknowledged: no eligible job yet; do not invent a receipt.

`/agents` exposes "Send to background" for an owned, accepted foreground job that
still has an attached parent wait. Hide/disable it for background, terminal,
unowned or no-longer-attached jobs. The viewer invokes the same transition as the
shortcut, not a second implementation. Merely opening or closing the modal never
changes waiting policy.

After backgrounding, the original tool call returns a clearly labeled receipt.
Its renderer and model-facing text distinguish it from a final answer and explain
how to retrieve the result. The parent can then continue independent work.

## Implementation sequence

### 1. Port the prototype foundations

- Integrate the prototype commit onto current `dev/subagents`, resolving conflicts
  deliberately rather than replacing current files wholesale.
- Keep current `scripts/agent-spawn.sh`, including tmux JSON launch, explicit
  `PI_ONESHOT_SUBAGENT_CHILD` propagation and Pi `--no-session`.
- Port shared job storage, process identity helpers, supervisor, management tools,
  watcher and viewer modules. Preserve architecture checks.
- Adapt fake-agent launcher tests to isolated tmux servers. Explicitly provide
  required test environment to each launch so tests cannot use real agents or
  inherit unrelated server state.
- Keep supervisor Node/type-stripping validation separate from launcher needs.

Completion criterion: prototype modules load on the current branch; fake Pi and
Claude jobs launch through the current launcher and produce readable results.

### 2. Unify foreground and background execution

- Route both modes through the shared job module and supervisor.
- Add waiting-policy metadata and a runtime registry of attached foreground waits.
- Preserve foreground progress updates, final-answer rendering and cancellation.
- Separate wait release from execution cancellation and expose one shared
  foreground-to-background transition for tools/UI callers.
- Preserve terminal acceptance and usage/delivery behavior described above.

Completion criterion: both modes run the same child execution path; a foreground
wait can release a receipt while that exact job continues running.

### 3. Add configuration and sync support

- Add the tracked defaults and extension config reader.
- Apply explicit-mode/config/fallback precedence and effective-default tool text.
- Extend `sync/sync-pi.sh` to install the default only when missing.
- Add sync regression coverage preserving existing local settings.

Completion criterion: either configured default works after reload, explicit tool
mode overrides it, and syncing does not overwrite local preferences.

### 4. Wire the shortcut and `/agents` action

- Bind a conflict-free foreground-to-background shortcut.
- Implement immediate targeting, multi-job selection and no-job feedback.
- Add waiting-policy labels and the owned-job action to `/agents`.
- Reuse existing receipt rendering and background completion behavior.

Completion criterion: either user action releases the original foreground tool
call without restarting/cancelling its child, and ineligible rows cannot act.

### 5. Preserve rendering and finish integration

- Extend durable `JobDetails` and supervisor snapshots with `latestCallUsage` and
  verified `contextWindow`, separate from cumulative usage/accounting.
- Keep runtime Pi imports out of the supervisor. Separate pure context-window
  resolution from the Pi adapter if necessary; unknown capacity stays unknown.
- Carry current Pi/Claude latest-call parser behavior into background snapshots.
- Sanitize raw row/header values before theme styling so real ANSI colors render
  correctly. Align foreground progress and viewer token labels with current
  latest-call rendering.
- Update extension/launcher documentation for configurable defaults, deadline
  preservation, shortcut targeting, result retrieval and shutdown behavior.

Completion criterion: existing rendering improvements remain intact, foreground
and background displays use the right usage fields, and the documented workflows
match the implemented config and controls.

## Targeted validation

Use fake agents; no paid model calls for ordinary regression tests.

- Config missing, valid foreground/background, invalid values and explicit mode
  overrides; sync installs once and preserves existing local settings.
- Default foreground returns a final answer; default background returns a receipt.
- Shortcut and modal action release the same foreground job; child identity,
  task, logs and deadline remain unchanged.
- Single job, multiple jobs, no eligible jobs and shortcut disabled.
- Completion before/after backgrounding; accepted fast completion returns a
  receipt or foreground answer according to the selected waiting contract.
- Foreground Esc/shutdown cancellation versus background survival, and cancellation
  of a management-tool wait without cancellation of execution.
- Foreground final answer and later background retrieval do not double-count usage.
- Fake Pi/Claude jobs through isolated tmux preserve child-role and no-session flags.
- Latest-call tokens/context capacity survive snapshots; unknown capacity and real
  theme colors render correctly.
- Existing typecheck, architecture, extension-loading, one-shot, viewer and sync
  regression commands remain the validation surface. Record default-run failures
  separately from serialized reruns rather than treating them as equivalent.

## Integration acceptance

1. Users choose foreground or background defaults through local JSON config.
2. Explicit tool mode overrides the default.
3. A running foreground delegation can be sent to background through a shortcut
   or `/agents`, without restarting its child.
4. Foreground answers, background receipts and result retrieval remain distinct.
5. Parent shutdown policy follows the job's current waiting mode.
6. Current launcher and rendering changes remain in place.
7. Prototype browsing, management, indicators and notifications are integrated.
8. Hardening is explicitly deferred, not silently counted as completed.
