# Background one-shot subagents

Status: implementation plan; background execution is not implemented yet.
Builds on the leaf-only change ([leaf-oneshot-subagents.md](leaf-oneshot-subagents.md),
commit f88f251): only root sessions delegate, and every child is a leaf, so each
background job is a single process group with no descendants.

## Goal

Let the parent continue working after delegating a one-shot task, while the user
can see outstanding work, inspect activity/results, and cancel owned tasks through
`/agents`. Persist enough information to reconnect after reload/restart and view
finished work without relying on a live process.

One-shot is the child's conversation lifecycle. Foreground/background is how the
parent waits. Do not conflate background jobs with future interactive agents.

## Existing foundations

- `pi-custom-extensions/oneshot-subagent/index.ts`: model-facing tool (registered
  in root sessions only), progress updates, turn-bound abort and shutdown cleanup.
- `oneshot-subagent/role.ts`: root/child role from `PI_ONESHOT_SUBAGENT_CHILD` and
  the persisted `oneshot-subagent-role` session entry.
- `oneshot-subagent/runner.ts`: creates `oneshot-XXXX/<name>.XXXX/`, writes the
  `CHILD_NOTICE`-prefixed task, waits on the `launching` marker for the PID, tails
  events, enforces the timeout, stops the single process group, validates the
  result and writes `final-response.md`. There is no `children/`, `finished` or
  `delegation.json` state to carry forward.
- `oneshot-subagent/events.ts`, `claude-events.ts`, `rendering.ts`:
  backend event normalization and bounded activity/result snapshots.
- `scripts/agent-spawn.sh`: detached JSON jobs with logs, PID and exit markers.
- `pi-custom-extensions/agents/`: live Pi/Claude process discovery, private
  heartbeat registry, process-identity checks, tmux actions.
- `/agents` now opens immediately as a centered floating modal. Discovery is
  asynchronous, and the modal is responsive and stable during updates.

The detached launcher is not durable supervision by itself. Today timeout
checking, stream validation, final-response creation and cleanup require the
parent runner to remain alive. The current extension also aborts children on
every `session_shutdown`, and deletes `task.md` right after launch.

## Scope and proposed defaults

- Background is the default: launching an agent must not block the main session. Return a receipt with a stable job ID.
- Keep foreground as an explicit opt-in with its existing final-answer return
  contract, for tasks whose answer the parent needs before it can do anything else.
- Use the existing `/agents` modal for inspection, not a second dashboard.
- Default indicator: one compact line near the editor; optional bounded expansion.
- Completion is visible immediately but never steals focus or interrupts a turn.
- No automatic model continuation on completion in the first release.
- Background browsing works without tmux; pane actions still require tmux.
- Keep the leaf-only child policy, backend validation and permissions.
- Limit concurrently active background jobs per session (default 4). Launching
  beyond the limit is a tool error naming the active jobs, not a queue.
- Background default timeout is 1800s (max 3600s); foreground keeps 600s.
- Do not expose thinking or claim that background execution is sandboxed.

**Confirmed exit policy:** background jobs survive parent Pi exit by default,
under independent supervision. Foreground runs retain cancel-on-shutdown behavior.
Reload and session switching do not cancel background jobs. The
`session_shutdown` handler aborts only in-flight foreground runs and launches
not yet acknowledged; accepted background jobs are never in that set, whatever
the shutdown `reason`. Cancellation before exit is done through `/agents` or the job-management tool. An interactive
leave/cancel/stay prompt on `/exit` and `/quit` is a separate follow-up:
[background-subagents-exit-confirmation.md](background-subagents-exit-confirmation.md).

Non-goals: interactive messaging/resume, automatic tmux panes, always-visible
multi-pane dashboards, worktree isolation, an OS-wide daemon, and automatic
permission hosting for children.

## Lifecycle contract

| Event | Background job behavior |
| --- | --- |
| Parent turn settles | Continues |
| Esc stops parent generation | Continues after launch is accepted; indicator shows remaining work |
| Launch cancelled before acceptance | Clean up any partial launch; do not leave an untracked child |
| Modal closes | Continues; dispose viewer subscriptions only |
| Extension reloads | Reconnect by durable job identity |
| Parent switches sessions | Continues; ownership remains with originating root session |
| Parent exits, crashes, or loses its terminal | Continues under supervisor; no prompt in this plan |
| Explicit job cancellation | Stop the job's process group |
| Deadline exceeded | Supervisor stops the process group and records timed-out result |
| Supervisor/process disappears | Reconcile evidence; report interrupted/unknown, never fabricate success |
| Session forks/tree navigates | Preserve original ownership; do not silently transfer result delivery or cancellation |

## Architecture

### A deep job module at a shared seam

Introduce public modules under `pi-custom-extensions/shared/agent-jobs/` for the
job interface and durable storage. Move the `ps -o lstart` process-identity
parsing/comparison from `agents/tmux.ts` into `shared/` first, so the job module,
supervisor and viewer share it without importing another extension's internals. The delegation extension and viewer import
these modules, never each other's `index.ts` factories. Preserve the repository's
no-entry-point-import and no-runtime-cycle architecture checks.

Keep the caller interface small:

- `start(request)` -> acknowledged job receipt.
- `list(query)` -> bounded summaries.
- `inspect(jobId, options)` -> metadata/activity/result snapshot.
- `cancel(jobId, owner)` -> idempotent cancellation outcome.
- `subscribe(query, listener)` -> disposable local updates, backed by durable state.

Launch, cancellation races, reconciliation, log parsing and ownership validation
belong behind this interface, not duplicated across tools and UI. Existing Pi and
Claude event parsers remain the backend adapters. Use dependency injection at
internal seams for fake launchers, clocks and filesystem/process behavior.

### Independent per-run supervision

Add a minimal Node supervisor entry point that is separate from a Pi extension
factory. It owns a job's launch acknowledgement, deadline, event parsing,
terminal validation, result files and process-group cleanup. Reuse/refactor the
existing runner logic rather than creating a second implementation of success
and cancellation rules.

The extension waits only for accepted launch/failure, not task completion. The
supervisor must not inherit a turn-bound abort signal after acceptance. Resolve
its executable and TypeScript/runtime loading strategy explicitly: do not depend
on Pi's extension loader inside a detached Node process. Default: run
`node supervisor.ts` directly, relying on Node's built-in type stripping (on by
default in the installed Node 23.9; verified: `runner.ts` and `claude-events.ts`
import cleanly in plain Node outside Pi, since their Pi imports are type-only).
The supervisor and everything it imports must have no runtime imports from Pi
packages; extend `check:architecture` to enforce this. Type stripping is not
available on older Node, so extend the existing `node` check in
`agent-spawn.sh`/the launcher to require a version with it enabled by default.
Node's experimental-feature warning goes to the job's stderr log; it is not an
error.

Detach the supervisor the same way `agent-spawn.sh` detaches JSON jobs
(`spawn(..., { detached: true })`, new session, no controlling terminal), so it
survives Pi exit and terminal loss.

Foreground execution can wait through the same job module while retaining its
abort behavior. Keep parity tests before removing the old runner path.

Use files for durable state and cancellation requests in v1 unless measurements
show a need for sockets. No global daemon is required. Reconcile after supervisor
failure without automatically rerunning a potentially file-mutating task.

### Durable records

Use the existing private agent-spawn job roots and add versioned job metadata.
A lightweight index can reference roots; it must be rebuildable and not the only
source of truth. Directories without the new metadata (including all earlier
`oneshot-*` runs) are ignored: no legacy reading or adoption.

Record:

- Stable agent identity and unique run/job ID; name is display-only.
- Backend, model/effort, cwd, launch time/deadline.
- The plain task text (without `CHILD_NOTICE`) in a 0600 file inside the job,
  kept for the detail view instead of being deleted after launch.
- Owner root session ID/file, originating transcript entry/tool-call ID, branch
  anchor. Owners are always root sessions; children cannot own jobs.
- Supervisor and child process identity, including process start time.
- Execution state, sequence/version, timestamps and last meaningful activity.
- Log/result paths, bounded display snapshot, usage and partial/final designation.
- Terminal reason/error and result validation outcome.

Execution states: starting, running, cancelling, succeeded, failed, cancelled,
timed-out, interrupted. Unknown liveness is a reconciliation/display condition,
not proof of continued execution. No output is not proof of failure.

Store viewed/acknowledged and delivered markers separately from execution state.
Delivery/acknowledgement is scoped to its owner; another session merely viewing a
job does not deliver it into the owner's model context.

Requirements: private directories/files, atomic snapshot writes, bounded readers,
validated schema and paths, PID/start-time validation before signals, monotonic
terminal transitions, duplicate-event tolerance, and immutable terminal results.
Retain raw logs as the full-data fallback. Do not put sensitive task text into the
existing lightweight live-process heartbeat records.

Retention: prune lazily when jobs are listed. Delete terminal jobs older than 14
days, then the oldest terminal jobs beyond 200 per owner. Never delete active jobs,
or jobs whose result is not yet delivered/acknowledged by their owner.

## Model-facing interface

Extend `oneshot_subagent` with a `mode` parameter: `background` (default) or
`foreground`. A background result contains the job ID, accepted state,
task label, result-retrieval instructions and a durable path. A launch failure
remains a tool error. Never return the receipt as though it were the child's final
answer.

Because the default changes, rewrite the tool description and prompt guidelines:
the tool no longer "waits for completion and returns its final answer". Teach the
model to keep working after launch, to use `foreground` only when it is blocked on
the answer, and to retrieve or wait for results before relying on them. Do not
edit files a running background task is changing until its result is retrieved.

Add a small job-management tool with operations for list/status, result retrieval,
explicit bounded waiting, and cancellation. Final tool names/schema are decided
in phase 1. Register it in root sessions only, like `oneshot_subagent`; children
have no jobs. Restrict operations by owner identity rather than arbitrary paths or
PIDs. Querying a running result returns its state, not an error or an indefinite
wait. Wait cancellation stops waiting, not the background job itself.

Retrieval keeps the existing 40 KiB model-context limit and full-response path.
Persist job identity in launch result details so receipts remain meaningful after
compaction/resume. The model must know it has outstanding tasks and must retrieve
required results before claiming its dependent work is complete: while the owner
has active or undelivered jobs, add a short context line listing their IDs, names
and states via the `context` event (which may return replacement `messages`
before every model call), so the reminder survives compaction. It is not saved
to the session. Append it at the end of the message list: inserting it earlier
would change the cached prompt prefix on every call.

### Failed, timed-out, cancelled and interrupted jobs

- Retrieval of a non-succeeded terminal job returns `isError: true`, like a failed
  foreground run today: state, terminal reason, stderr tail, any partial answer
  and the job path. Never present it as a normal answer.
- That error states that the child may have left partial file changes in its cwd,
  and that the model should inspect them before relying on that tree or retrying.
- No automatic retry; relaunching is the model's or user's explicit decision.
- Partial usage (common for Claude) is still recorded once, through the same
  `usage-delivered` marker, and flagged as partial.
- Non-succeeded jobs stay in the indicator until acknowledged by the user (in
  `/agents`) or by the model retrieving the result; delivering the completion
  notice alone does not clear them.

### Usage and completion delivery

- Completion notification: short status/job-ID notice, not the full answer.
- Make terminal results accessible independently of notification delivery.
- Deliver model-visible notices to the originating session with
  `pi.sendMessage(notice, { triggerTurn: false })` and no `deliverAs`. When idle,
  Pi appends it to the session immediately (persisted, no turn started). While
  the agent is running, Pi holds it until `turn_end`, after all tool results, so
  it never interrupts a response or splits a tool call from its result; the
  agent sees it on its next model call in the same run.
- Do not use `deliverAs: "nextTurn"`: Pi keeps those only in memory and injects
  them only with the next user prompt, so they are lost on reload/exit and a
  completion during a run waits for the user to type.
- Send a notice only while the owner session is the active session; otherwise
  keep it pending in durable state and send it on that session's next
  `session_start`.
- Coalesce batch completions and surface failed/cancelled/timed-out jobs too.
- If the originating branch is no longer active, retain pending delivery; do not
  inject the result into a different conversation branch.
- Opening a modal result never implicitly changes model context.
- Record child usage exactly once per run. Launch receipts have no final usage.
  The first management-tool result that returns a terminal job's result carries
  its `usage`, guarded by a durable owner-scoped `usage-delivered` marker written
  atomically before returning. Later retrieval/wait calls and notices carry none.
- Jobs whose result is never retrieved do not reach session totals; `/agents`
  shows accurate per-job totals, and the docs state this limitation.

Verified against Pi 1.1.0: tool results carry a first-class `usage` field
(`agent-session.js`, the same path foreground results use), so the management
tool can report usage exactly like today's foreground tool.

## TUI

### Activity indicator

Default one line near the editor:

```text
Agents  2 running · 1 ready · 1 failed                         /agents
```

Optional expansion shows at most three named jobs, elapsed time and recent
meaningful activity. Show quiet duration when useful, never fabricated progress
percentages. Use text labels plus theme colors. Clear acknowledged completions
from the indicator without deleting their history. Do not replace the user's
custom footer or editor.

### Shared floating modal

Keep the existing lazy-opening modal and add filters: This session, All live,
Recent jobs. Default to the originating/current session's work. All inspectable
rows are selectable; actions depend on capabilities:

- Owned background job: activity, result, cancel.
- Interactive process: metadata, attach, pane moves/kill.
- Unmanaged headless process: available metadata only; no invented log/control access.
- Completed job: durable activity/result even without a live PID.

Join durable runs to live processes using verified identity, avoiding duplicate
rows. Keep process discovery separate from history: a persisted record cannot
make an exited process appear live. Load local jobs without waiting for Claude
or tmux discovery. Pane discovery is optional when outside tmux.

Detail view replaces the list inside the same modal:

- Activity: timestamped readable timeline and tool summaries.
- Result: Markdown answer, available partial answer preview, truncation notices.
- Task/metadata: instruction, backend/model, cwd, ownership, paths and diagnostics.

Enter inspects a job or attaches to an interactive process. Esc in details returns
to the list with selection/scroll preserved; Esc in the list closes the modal.
Tab changes detail sections; follow mode stops when the user scrolls up and shows
new-activity availability. Inline cancellation confirmation names the job. Never use a pane-kill action for a background job.

Future interactive agents can add attach/message/resume capabilities to the same
identity/row model; do not design the viewer around a mandatory headless PID.

## Implementation sequence

### 1. Lock contracts

- Implement the confirmed survive-by-default policy.
- Define versioned job/receipt schemas, state transitions, owner/branch semantics,
  tool operations, capability model and notification/usage accounting strategy.
- Already verified against Pi 1.1.0 and the installed Node (no further spike
  needed): tool-result `usage`; `sendMessage` with `triggerTurn: false`;
  `context` message replacement; `setWidget` with `aboveEditor`/`belowEditor`;
  `sessionManager.getSessionId/getSessionFile/getLeafId/getBranch`;
  `session_shutdown` reasons; plain-Node loading of the runner modules; detached
  supervision via the `agent-spawn.sh` pattern.
- Move process-identity helpers from `agents/tmux.ts` into `shared/`.
- Add fixtures for foreground Pi/Claude completion and cancellation.

Exit criterion: lifecycle decisions are explicit, and the current foreground
behavior has regression coverage before refactoring.

### 2. Durable execution and supervision

- Extract reusable runner behavior behind the shared job interface.
- Implement metadata/index writes, supervisor launch acknowledgement, deadlines,
  cancellation requests and reconciliation.
- Preserve backend terminal validation, output limits and the leaf-only policy.
- Prove execution survives reload, parent exit, and terminal loss by default.

Exit criterion: a fake-backend job can start, complete, fail, time out or cancel
without depending on a live parent extension, with readable durable results.

### 3. Model tools and receipts

- Add background launch as the default, plus management operations.
- Keep explicit foreground returns/rendering compatible; update tool description
  and prompt guidelines for the new default.
- Persist receipt references, implement bounded retrieval and waiting, and
  enforce owner checks, the concurrency limit and root-only registration.

Exit criterion: the parent receives a receipt promptly and can do unrelated work,
then retrieve the result without double-counting usage.

### 4. Viewer integration

- Make process snapshots independent of tmux pane snapshots.
- Merge job summaries with live discovery and capability-based selectable rows.
- Add filters and list-to-detail navigation to the existing modal.
- Add follow/scroll behavior, historical result access and job cancellation.

Exit criterion: current and recent tasks are inspectable outside tmux, and
interactive tmux actions remain unchanged and identity-safe.

### 5. Indicator and completion delivery

- Add compact widget and optional bounded expansion.
- Persist pending notices and owner-scoped delivery/acknowledgement markers.
- Implement safe-boundary delivery, batch coalescing and exactly-once accounting.
- Add the outstanding-jobs context line.

Exit criterion: completions are visible without focus theft, automatic model
continuation, delivery into the wrong session/branch, or repeated usage totals.

### 6. Hardening, documentation and rollout

- Validate permissions, malformed/missing files, stale/reused processes and crashes.
- Implement lazy retention pruning.
- Document exit semantics, SAFE-mode limitations, cancellation, retention and tools.
- Run tests/checks and manual TUI/backend smoke tests.
- Ship with background as the default; foreground stays available explicitly.

## Test matrix

Use fake Pi/Claude processes and the real launcher for integration tests; ordinary
regression tests must not make paid model calls.

- Launch acknowledgement/failure, late PID publication, cancellation during launch.
- Parent Esc, explicit wait cancellation, modal close, reload, session switch/exit;
  `session_shutdown` for every reason aborts foreground runs only.
- Parent `/quit`, crash, terminal loss and non-interactive shutdown preserve jobs.
- Supervisor crash; child disappears with/without exit marker; truncated JSONL;
  final response missing; exit 0 with invalid/aborted backend completion.
- Deadline and explicit cancellation stop the whole process group (tools included).
- Reconnect/replay, duplicate events, idempotent cancellation and result retrieval.
- Session forks/tree navigation, owner checks, pending notices, viewed vs delivered.
- Usage once per run, partial Claude usage, concurrent retrieval.
- Failed/timed-out/cancelled/interrupted retrieval returns `isError` with reason,
  stderr tail, partial answer and the partial-changes warning; partial usage is
  counted once; such jobs stay in the indicator until acknowledged.
- Same-name parallel jobs, live/history deduplication, PID reuse and missing logs.
- Modal opens before discovery; cancellation/close while discovery is pending;
  independent local-job rendering despite slow Claude/tmux discovery.
- Selection preservation, scrolling/follow, narrow widths, tiny terminals, resize,
  theme changes, regular/fullscreen modes, Unicode and existing custom footer.
- Directories without new metadata are ignored, never adopted or controlled.
- Concurrency limit errors; children never register either tool.
- Retention never prunes active or undelivered jobs.
- Supervisor imports nothing from Pi at runtime (architecture check).
- Outstanding-jobs context line appears while jobs are active/undelivered, and
  disappears after delivery; it survives compaction and is the last message.
- Notices: idle delivery appends without a turn; delivery during a run lands
  after `turn_end`; notices for an inactive owner wait for its `session_start`.
- Launcher refuses a Node version without default type stripping.

Validation commands:

```bash
cd pi-custom-extensions
bun run check
node --experimental-strip-types --test oneshot-subagent/*.test.ts agents/*.test.ts
```

## Release acceptance criteria

1. A background delegation returns an acknowledged receipt without waiting for
   the answer, and the parent can immediately continue.
2. `/agents` opens immediately and can inspect active/completed owned work,
   including outside tmux.
3. Results and activity remain viewable after reload/restart; liveness claims are
   reconciled from actual process/terminal evidence.
4. Explicit cancellation stops the job's process group without killing the parent pane.
5. Timeout and finalization do not disappear when the parent observer disconnects.
6. Completions never steal focus or trigger unsolicited model continuation.
   Failed jobs reach the model as errors and stay visible until acknowledged.
7. Foreground execution, leaf-only policy, result validation and usage remain correct.
8. Background execution is not represented as a sandbox or as interactive resumption.
9. Background jobs survive parent exit by default.
