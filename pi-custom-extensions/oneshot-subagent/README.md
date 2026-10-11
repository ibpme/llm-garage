# One-shot subagent

This is a prototype for the broader subagent feature under development. Its
one-shot lifecycle and Claude leaf policy are intentionally limited; the
interface may evolve as that feature takes shape.

Adds `oneshot_subagent`, a model-callable tool that delegates a standalone task to
a fresh Pi or Claude Code process using this repository's `scripts/agent-spawn.sh --mode json`,
and `subagent_jobs`, which manages the resulting background jobs. Both are
registered in root sessions only. They work in interactive, print, and JSON modes.

By default a delegation runs in the **background**: the tool returns a job receipt
as soon as the child has started, and the main agent keeps working. With
`mode: "foreground"` the call waits for the child and returns its final answer, as
earlier versions always did.

## Use

Ask Pi to delegate a task, or call the tool through codemode:

```js
const receipt = await tools.oneshot_subagent({
  name: "review-api",
  task: "Review src/api for correctness and missing tests. Do not edit files. Return findings with file paths and line numbers.",
});
// ... unrelated work ...
text(await tools.subagent_jobs({ action: "result", job_id: receipt.details.jobId }));
```

| Parameter | Default |
|---|---|
| `agent` | `pi`; use `claude` for Claude Code |
| `task` | Required complete, standalone task |
| `name` | `subagent`; letters, digits, underscores, hyphens |
| `cwd` | Main agent's working directory; relative paths resolve from there |
| `model` | Pi: parent model ID; Claude: its own configured default |
| `provider` | Pi: parent provider when inheriting the model, otherwise requires explicit `model`; Claude: ignored, even without `model` |
| `thinking` | Pi: parent level when inheriting the model, otherwise CLI default/suffix; Claude: compatibility alias for `effort` at common levels |
| `effort` | Optional shared reasoning level: `low`, `medium`, `high`, `xhigh`, `max`; mapped to Pi `--thinking` or Claude `--effort` |
| `mode` | `background` (receipt now, answer via `subagent_jobs`) or `foreground` (wait for the answer) |
| `timeout_seconds` | 1,800 in background, 600 in foreground; range 1–3,600 |

Every call is a new session. The child does **not** inherit the parent's transcript:
include context, constraints, paths, and deliverables in `task`. Pi inherits the
local user's configuration, credentials, extensions, skills, and project context
according to its normal headless loading/trust rules. Explicit CLI-only resources
and temporary parent tool selection are not copied.

## Background jobs

A background launch returns once the child has published its PID. The receipt
names the job ID (`job-` plus 12 hex digits) and its directory; it is not the
child's answer and carries no usage. A launch failure is a tool error. Up to four
background jobs may be active per session; launching a fifth is a tool error
naming the active jobs (there is no queue).

`subagent_jobs` operates only on jobs owned by the calling session:

| `action` | Behavior |
|---|---|
| `list` | This session's jobs, newest first, with state and whether the result was retrieved |
| `status` | One job's state |
| `result` | A finished job's answer (40 KiB model limit, full-response path); a running job returns its state, not an error |
| `wait` | Wait up to `timeout_seconds` (default 60, max 600) for `job_ids` (default: all running jobs), then return their results/states. Cancelling the wait never cancels the jobs |
| `cancel` | Stop the job's process group; idempotent |

A failed, timed-out, cancelled or interrupted job is returned as a tool error with
its state, reason, any partial answer, the stderr tail, the job path, and a warning
that the child may have left partial file changes in its working directory. Nothing
is retried automatically.

Child usage is reported to Pi once per job: the first `result`/`wait`/`cancel`
response that returns a finished job carries its usage (partial for interrupted
Claude runs), guarded by a durable `usage-delivered` marker. Usage of jobs whose
result is never retrieved does not reach the session totals; `/agents` still
shows per-job totals.

While a session has running jobs or finished jobs whose result was not retrieved
(or acknowledged in `/agents`), a short reminder listing them is appended as the
last message of each model request. It is not saved to the session, so it
survives compaction without changing the cached prompt prefix.

When jobs finish, a short completion notice (state and job ID, not the answer) is
added to the owning session with `triggerTurn: false`: immediately when idle, or
after the current turn's tool results while the agent runs. It never starts a turn
or steals focus. Notices are sent once, only while the owning session is active
and the branch that launched the job is the current branch; otherwise they wait
for that session's next start or for the branch to become active again. Batch
completions are coalesced. Forks and other sessions never receive or control
another session's jobs.

The editor shows a one-line indicator while the session has running, unretrieved
or unacknowledged jobs, for example `Agents  2 running · 1 ready · 1 failed`.
`/jobs-indicator expanded` additionally lists up to three jobs with elapsed time,
quiet time and recent activity; `/jobs-indicator compact` restores one line.
Finished jobs leave the indicator once their result is retrieved by the model or
acknowledged in `/agents`; a completion notice alone does not clear them.

### Supervision and exit

Each background job runs under its own detached supervisor
(`node oneshot-subagent/supervisor.ts <root> <job-id>`, a new session without a
terminal). The supervisor owns the launch, deadline, event parsing, result
validation and `final-response.md`, using the same runner code as foreground runs.

| Event | Background job |
|---|---|
| Turn ends, Esc, modal closes | Continues |
| `/reload`, session switch, `/new`, `/resume`, fork | Continues; ownership stays with the launching session |
| Pi exits, crashes or loses its terminal | Continues; results stay viewable in `/agents` |
| Explicit cancel (`subagent_jobs` or `/agents`) | Process group stopped (SIGTERM, then SIGKILL) |
| Deadline | Process group stopped; recorded as timed-out |
| Supervisor killed with SIGTERM/SIGINT | Child stopped; recorded as interrupted |
| Supervisor disappears | While the child still runs the job is shown as status unknown and remains cancellable; otherwise it is recorded as interrupted. Success is never inferred |

Foreground runs keep the previous behavior: every `session_shutdown` (quit,
reload, new, resume, fork) cancels them, as it cancels background launches not yet
acknowledged. Accepted background jobs are never cancelled by shutdown. There is
no exit prompt yet; cancel jobs from `/agents` or with `subagent_jobs` before
exiting if they should not continue.

The supervisor runs TypeScript directly with Node's built-in type stripping and
loads nothing from Pi at runtime (`check:architecture` enforces this). Launching
requires a Node.js with type stripping enabled by default (22.18+ or 23.6+);
older versions are refused with an error.

## Model and effort selection

Models are backend-specific. Claude accepts its CLI aliases (for example `sonnet`
or `opus`) and full model IDs; arbitrary Pi provider/model patterns are not
translated. Claude never inherits the parent's Pi model, provider, or thinking.
When omitted, Claude's own model and effort configuration applies.

Use separate `model` and `effort` fields for portable call structure:

```js
text(await tools.oneshot_subagent({
  agent: "claude",
  name: "review-api",
  task: "Review src/api. Read files only; return findings with paths and line numbers.",
  model: "sonnet",
  effort: "high",
}));
```

For Claude, `model: "sonnet:high"` is normalized into `--model sonnet --effort high`.
An explicit `effort` or `thinking` overrides the suffix. Pi's existing suffix
handling remains with Pi. If both `effort` and `thinking` are supplied they must
agree. Claude rejects `off`/`minimal` (including suffixes without an explicit
common-level override): they have no exact effort equivalent. Available Claude
effort levels depend on its model/version; the CLI validates model compatibility.
This interface intentionally excludes Claude-only effort presets such as
`ultracode`, which activate additional behavior rather than a shared level.

The raw launcher uses backend-native flags: Pi `--thinking`, Claude `--effort`.
It forwards `--model` unchanged; suffix normalization and the shared alias are
features of the extension, not the raw shell script.

## Claude leaf capabilities

Claude launches with `-p --output-format stream-json --verbose
--include-partial-messages --no-session-persistence`. Every call is fresh and
cannot be resumed through Claude; our job files still persist.

The built-in tool allowlist is exactly:

- `Read`, `Glob`, `Grep`: file inspection and search.
- `Edit`, `Write`: file changes, subject to Claude permissions.
- `Bash`: commands, subject to Claude permissions.
- `WebFetch`, `WebSearch`: web access, subject to Claude permissions.

All other built-in tools are excluded by `--tools`. In particular:

| Disabled capability | Mechanism |
|---|---|
| Advisor tool and configured advisor model | `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1` for Claude JSON-mode children only; set after login-shell initialization. Future non-JSON launches retain their advisor configuration |
| Native subagents, including Explore/Plan agents | `Agent` and legacy `Task` omitted from allowlist and explicitly denied with `--disallowedTools Agent,Task` |
| Agent teams, task-management tools, scheduling, worktree tools and other built-in orchestration | Not in the tool allowlist |
| Interactive questions and planning-mode transitions (`AskUserQuestion`, `EnterPlanMode`, `ExitPlanMode`) | Not in the tool allowlist |
| Model-invoked skill execution (`Skill`) and tool discovery | Not in the tool allowlist |
| MCP tools, including configured delegation/browser integrations | `--strict-mcp-config --mcp-config '{"mcpServers":{}}'` |
| Permission prompts / automatic permission bypass | `--permission-mode auto --permission-prompts none`; no bypass flag |
| Session persistence and continuation | `--no-session-persistence`; no resume/continue flags |

Claude still loads its normal credentials, project context, settings, hooks,
plugins and discovered skill context according to its headless rules. The `Skill`
tool is unavailable, but this is not a complete customization-disable mode.
Read-only tools normally work; edits/commands that require approval need existing
Claude allow rules and otherwise are denied. Pi's UI is not a permission host.
Permission denials appear in activity; a completed answer explaining a denial is
not automatically a failed run. This leaf policy is not a sandbox: permitted
shell commands or hooks can still launch other processes. Stronger restrictions
on arbitrary process spawning/customizations are deferred.

## Leaf children

Only a root session (a Pi session not launched by this extension) can delegate:

```text
main agent (root) -> one-shot child (leaf)
```

Every child, Pi or Claude, is a leaf. There is no depth setting; to turn
delegation off, disable the extension in Pi.

The runner launches children with `PI_ONESHOT_SUBAGENT_CHILD=1`, and a child does
not register `oneshot_subagent` at all. On `session_start` a child appends an
`oneshot-subagent-role` session entry, so reload, resume, and fork restore the
role without the environment. A child's task is prefixed with a short note that it cannot
delegate.

The marker means "one-shot child", not "any spawned agent": only this runner sets
it. `scripts/agent-spawn.sh` is a plain launcher with no child guard, so other
launches (such as future interactive tmux agents) are not restricted by it.

This is a recursion guard, not a sandbox. A child with shell access can still run
`agent-spawn.sh`, `pi -p`, or `claude -p`. The Claude leaf policy above separately
disables native Claude delegation.

Each job directory holds one child's files and is stopped as a single process
group. Directories from earlier versions, including any `children/`, are inert
history and are never deleted.

## TUI

The transcript displays a named task with a themed progress gutter, elapsed time,
turns, tool calls, token/cost totals, recent tool activity, and an answer preview.
Expand the result using Pi's normal tool expansion to see activity, working
directory/model, Markdown output, and the job directory. Thinking content is not
displayed or returned.

Results saved by earlier versions that contain nested subagent snapshots still
render: only the top-level run is shown, with a "nested runs: see job logs" notice.

## Lifecycle and failures

- Foreground: Esc / tool cancellation, timeout, or session shutdown terminates the
  child's process group, including its tools, with SIGTERM then SIGKILL.
- Cancellation during launch waits for launch acknowledgement (up to 15 seconds)
  so the detached PID can be cleaned up.
- Exit status 0 alone is not success: the JSON stream must settle without abort
  and end with a completed, nonempty assistant answer. Errors, missing exit
  status, malformed JSON, and incomplete responses are returned as tool errors.
- Pi usage is summed from completed assistant/tool-result messages. Claude uses
  terminal `modelUsage` totals (falling back to `usage` for older streams) and
  `total_cost_usd`, replacing provisional streamed usage rather than adding it
  again. Before a result, per-message usage is deduplicated by message ID and
  displayed as partial. Interrupted runs preserve those partial token totals;
  cost is unavailable until a result. Both are reported once to Pi as tool usage.
- Claude requires a terminal `result` with `subtype: "success"`, `is_error: false`,
  a nonempty answer and normal completion. An incomplete/aborted/error result
  fails even with exit status 0; Pi retains its `agent_settled` checks.
- Responses over 40 KiB are truncated for model context, with a path to the full
  `final-response.md`. Expand shows the same bounded result; read the file for more.

Foreground job directories remain under
`${XDG_STATE_HOME:-~/.local/state}/agent-spawn/oneshot-*/<name>.*/`, with
`events.jsonl`, `stderr.log`, `exit.status`, `pid`, and `final-response.md`.
Remove them manually when no longer needed.

Background jobs live in private (`0700`/`0600`) directories under
`${XDG_STATE_HOME:-~/.local/state}/agent-spawn/jobs/<job-id>/`:

| File | Contents |
|---|---|
| `job.json` | Versioned request: name, backend/model, cwd, deadline, owner session/tool call/branch anchor |
| `task.md` | The plain task (without the child notice), kept for `/agents` |
| `status.json` | State, supervisor/child PID and start time, bounded activity snapshot, usage, terminal reason |
| `cancel.request`, `marker.*` | Cancellation request; notified/delivered/usage-delivered/acknowledged markers |
| `child/<name>.*/` | The agent-spawn job: `events.jsonl`, `stderr.log`, `pid`, `exit.status`, `final-response.md` |
| `supervisor.log` | Supervisor diagnostics (Node warnings land here) |

States: starting, running, cancelling, succeeded, failed, cancelled, timed-out,
interrupted. Terminal results are immutable, and PID plus process start time are
verified before any signal. Directories without this metadata, including earlier
`oneshot-*` runs, are ignored. Retention is lazy, on listing: finished jobs whose
result was retrieved or acknowledged are deleted after 14 days, and beyond the
newest 200 finished jobs per session. Running jobs and unretrieved results are
never pruned. These files can contain sensitive prompts, tool arguments and
results.

## Permission boundary

This is **not** a sandbox. A child can edit files, run commands, and use its own
configured tools (Pi may also use MCP; Claude MCP is disabled). Parent permission
prompts/tool restrictions are not forwarded. **Delegation remains available in
Pi SAFE mode for both backends for now. SAFE does not make the child read-only.**
The leaf rule and Claude leaf policy still apply. Switching modes does not
revoke already-running children, including background jobs that outlive the
session; cancel them first if needed. Background execution is not a sandbox and
not an interactive agent: a job cannot be messaged or resumed.

Requires the repository launcher, Node.js, Bash, and Pi on PATH after the
launcher's login shell initializes (Zsh by default), or Claude Code for
`agent: "claude"`. Claude flags were checked against installed version 2.1.295;
older versions lacking these flags will fail rather than silently relax policy.
The canonical package manifest includes this extension; use `/reload` after updating the repository.
No extra dependencies or configuration are needed.

## Tests

```bash
cd pi-custom-extensions
node --experimental-strip-types --test oneshot-subagent/*.test.ts
bun run check
```

The runner, supervisor and extension tests use the real launcher and detached
supervisor with fake login shells and fake Pi/Claude (`fake-agents.fixture.ts`);
they do not make model calls. Interactive rendering and live-provider calls
still need a manual smoke test.
