# Background subagents: exit confirmation

Status: follow-up plan; blocked on a Pi pre-exit hook. Depends on
[background-subagents.md](background-subagents.md) shipping first.

## Goal

When the user explicitly exits Pi while owned background jobs are still active,
let them choose whether to leave the jobs running or cancel them. This is a
convenience on top of the survive-by-default policy, not a safety requirement:
without it, background jobs keep running and can be cancelled from `/agents`.

## Policy

Background jobs survive parent Pi exit by default, under independent
supervision (defined in the main plan). When the user invokes `/exit` or `/quit`
with owned background jobs still active, ask whether to leave them running or
cancel them before exiting. Default selection is **Leave running and exit**;
cancellation always requires an explicit choice. Reload and session switching
do not prompt or cancel background jobs.

| Event | Behavior |
| --- | --- |
| `/exit` or `/quit` with active owned background jobs | Prompt: leave running and exit (default), cancel jobs and exit, or stay in Pi |
| `/exit` or `/quit` without active owned background jobs | Exit normally, without a prompt |
| Other exit paths, crash, terminal loss, signals | No prompt; jobs survive |

## UX

Before explicit `/exit` or `/quit` tears down the TUI, show a focused confirmation:

```text
3 background jobs are still active in this session.

> Leave running and exit
  Cancel jobs and exit
  Stay in Pi

Leaving them running preserves their deadlines and saves results for /agents.
Cancelling stops these jobs.
```

- Scope the prompt to jobs owned by the exiting session, not every job on the machine.
  Include previously launched jobs recovered when resuming that same session.
- Count active jobs. Treat starting/running/cancelling jobs as active and reconcile stale records.
- Enter accepts the selected action; default to leave running. Esc dismisses the
  prompt and stays in Pi, rather than choosing an exit action implicitly.
- Leave: disconnect observers and exit; supervisors continue deadline enforcement
  and result finalization.
- Cancel: request cancellation of each job's process group, show progress, verify cleanup, then exit.
  If cleanup cannot be verified, explain which jobs may remain and let the user
  retry, stay, or explicitly leave them running. Never claim they were killed merely
  because a cancellation request was written.
- Stay: return focus to the editor with no cancellation or shutdown side effects.
- Reconcile again when the choice is applied: jobs may finish while the prompt is
  open. Block new launches from this session while cancellation-and-exit commits;
  preserve the existing partial-launch acknowledgement/cleanup guarantees.
- If UI is unavailable, the default is survival, not automatic cancellation.
  Crash, terminal loss and signals cannot depend on an interactive choice.
- Ctrl+D/Ctrl+C shutdown paths retain survival by default; extending this same
  pre-exit confirmation to keyboard exits is a separate integration decision.

## Pi integration requirement

Verify a supported pre-shutdown interception seam for both commands before
implementing. In installed Pi 1.1.0, built-in `/quit` is handled in
`interactive-mode.js` before extension `input` dispatch, and ordinary interactive
shutdown stops the TUI before `session_shutdown`. Therefore registering another
`/quit` command or showing a dialog from `session_shutdown` is not sufficient.
The implementation must intercept explicit quit while the TUI is still active,
using a supported extension mechanism if available; otherwise add/request a
small Pi pre-exit hook. Define `/exit` as the same guarded exit path. Do not
silently ship protection for only `/exit`, fragile simulated input, a replaced
editor component, or a prompt after terminal teardown.

## Implementation sequence

1. Confirm or land the Pi pre-exit hook; record the chosen seam.
2. Implement the owner-scoped active-job query on the shared job module
   (reuses `list(query)` and reconciliation from the main plan).
3. Add the confirmation dialog with leave/cancel/stay paths and verified
   cancel-and-exit, including the launch block during commit.
4. Document exit semantics alongside the main background-mode docs.

## Tests

- `/exit` and `/quit`: no active jobs, default leave, explicit cancel, Esc/stay,
  jobs completing while prompted, pending launches, cancellation failures,
  and resumed-session jobs; never prompt for unrelated sessions' jobs.
- Confirmation executes before TUI teardown, never from `session_shutdown`.
- Non-interactive shutdown and keyboard exits preserve jobs without prompting.

## Acceptance criteria

1. Both `/exit` and `/quit` offer leave/cancel/stay when owned jobs are active.
2. Cancel-and-exit verifies that each job stopped before exiting.
3. Dismissing the prompt keeps Pi open with no side effects.
