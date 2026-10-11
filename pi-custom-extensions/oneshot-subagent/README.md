# One-shot subagent

This is a prototype for the broader subagent feature under development. Its
one-shot lifecycle and Claude leaf policy are intentionally limited; the
interface may evolve as that feature takes shape.

Adds `oneshot_subagent`, a model-callable tool that delegates a standalone task to
a fresh Pi or Claude Code process using this repository's `scripts/agent-spawn.sh --mode json`.
The call waits for the child to finish and returns its final assistant text to
the main agent. It works in interactive, print, and JSON modes.

## Use

Ask Pi to delegate a task, or call the tool through codemode:

```js
text(await tools.oneshot_subagent({
  name: "review-api",
  task: "Review src/api for correctness and missing tests. Do not edit files. Return findings with file paths and line numbers.",
  timeout_seconds: 600,
}));
```

| Parameter | Default |
|---|---|
| `agent` | `pi`; use `claude` for the leaf Claude Code backend |
| `task` | Required complete, standalone task |
| `name` | `subagent`; letters, digits, underscores, hyphens |
| `cwd` | Main agent's working directory; relative paths resolve from there |
| `model` | Pi: parent model ID; Claude: its own configured default |
| `provider` | Pi: parent provider when inheriting the model, otherwise requires explicit `model`; Claude: ignored, even without `model` |
| `thinking` | Pi: parent level when inheriting the model, otherwise CLI default/suffix; Claude: compatibility alias for `effort` at common levels |
| `effort` | Optional shared reasoning level: `low`, `medium`, `high`, `xhigh`, `max`; mapped to Pi `--thinking` or Claude `--effort` |
| `timeout_seconds` | 600; range 1–3,600 |

Every call is a new session. The child does **not** inherit the parent's transcript:
include context, constraints, paths, and deliverables in `task`. Pi inherits the
local user's configuration, credentials, extensions, skills, and project context
according to its normal headless loading/trust rules. Explicit CLI-only resources
and temporary parent tool selection are not copied.

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
| Permission prompts / automatic permission bypass | `--permission-mode dontAsk --permission-prompts none`; no bypass flag |
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

## Delegation depth

The default `maxDepth: 2` permits exactly:

```text
main agent (depth 0) -> subagent (depth 1) -> subagent (depth 2)
        can delegate          can delegate          cannot delegate
```

The durable local configuration is `<Pi agent directory>/oneshot-subagent.json`
(`~/.pi/agent/oneshot-subagent.json` by default; respects `PI_AGENT_DIR`):

```json
{ "maxDepth": 2 }
```

The canonical default is `pi-custom-config/oneshot-subagent.json`.
`sync/sync-pi.sh` copies it only if the local file is missing, preserving local
preferences. A missing file also defaults to 2. Values 0–16 are accepted:
0 disables delegation and 1 allows only direct children. Invalid configuration
fails closed. Changes apply on reload/new processes; start a new root session to
increase a previously persisted session's budget.

Each Pi child receives a versioned `PI_ONESHOT_SUBAGENT_CONTEXT` containing its
incremented depth, immutable inherited maximum, and owned run directory. Tool
arguments cannot override the budget. Leaf agents register the tool as
`hidden` (not model-visible or callable through codemode), with a second check
inside execution and the runner.

Claude consumes one level of the same parent budget, but is always a leaf:
its recorded child `maxDepth` is capped to its own depth, even when the parent
has budget remaining. Inherited metadata also makes a Pi process launched by
Claude terminal if it retains the environment. Native Claude delegation is
disabled separately by the tool policy above.

A `oneshot-subagent-context` custom session entry persists the identity before
the first prompt. Reload, resume, and fork restore that identity; tree navigation
cannot reset session-wide depth. Restoration never lowers recorded depth or
raises the inherited maximum. Malformed metadata disables delegation rather than
treating the agent as a fresh root. Old `PI_ONESHOT_SUBAGENT_CHILD=1` launches
without new metadata remain terminal for safe migration.

Job roots also contain `delegation.json`. Descendant roots live in their active
parent's `children/` directory, providing durable ownership for recursive
cancellation of separately detached process groups. Finished and cancellation
markers avoid revisiting old jobs and block new descendants of cancelled parents.
A resumed session retains its depth but does not reuse an old job's process
ownership directory.

## TUI

The transcript displays a named task with a themed progress gutter, elapsed time,
turns, tool calls, token/cost totals, recent tool activity, and an answer preview.
Expand the result using Pi's normal tool expansion to see activity, working
directory/model, Markdown output, and the job directory. Progress also shows
child depth and its inherited maximum. Thinking content is not
displayed or returned.

The expanded child result also contains nested subagent sections with their
names, tasks, live activity, Markdown responses, status/depth/usage, and job
paths. Nested gutters show the hierarchy without colored background panels.
Compact results show only the number of nested subagents. Updates are correlated
by tool-call ID, including calls made through codemode, so parallel agents with
the same name remain distinct.

Nested display snapshots are saved in tool-result details, so they remain
available on session resume even if the job logs are removed. Capture applies to
new delegations after reload; older saved tool results without nested snapshots
are not automatically backfilled. Snapshots are bounded to 32 descendant runs,
16 levels, and 256 Ki characters of nested text, with per-field limits and visible
truncation/omission notices. Full data remains in the job JSONL logs. Nested
snapshots are display-only: they do not change the final answer returned to the
main model or double-count nested usage.

## Lifecycle and failures

- Esc / tool cancellation, timeout, or session shutdown terminates the owned
  process tree, including separately detached subagents and child tools, with
  SIGTERM then SIGKILL.
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
  cost is unavailable until a result. Both are reported to Pi as nested tool usage.
- Claude requires a terminal `result` with `subtype: "success"`, `is_error: false`,
  a nonempty answer and normal completion. An incomplete/aborted/error result
  fails even with exit status 0; Pi retains its `agent_settled` checks.
- Responses over 40 KiB are truncated for model context, with a path to the full
  `final-response.md`. Expand shows the same bounded result; read the file for more.

Private job directories remain under
`${XDG_STATE_HOME:-~/.local/state}/agent-spawn/oneshot-*/<name>.*/`, with
`events.jsonl`, `stderr.log`, `exit.status`, `pid`, and `final-response.md`.
These files can contain sensitive prompts, tool arguments, and results. Remove
them manually when no longer needed.

## Permission boundary

This is **not** a sandbox. A child can edit files, run commands, and use its own
configured tools (Pi may also use MCP; Claude MCP is disabled). Parent permission
prompts/tool restrictions are not forwarded. **Delegation remains available in
Pi SAFE mode for both backends for now. SAFE does not make the child read-only.**
The depth budget and Claude leaf policy still apply. Switching modes does not
revoke already-running children; cancel them first if needed.

The depth budget applies to this extension, not arbitrary shell commands or
other delegation tools. It is a recursion guard, not a security boundary; agents
with unrestricted shell access can alter files/environment or launch Pi directly.

Requires the repository launcher, Node.js, Bash, and Pi on PATH after the
launcher's login shell initializes (Zsh by default), or Claude Code for
`agent: "claude"`. Claude flags were checked against installed version 2.1.295;
older versions lacking these flags will fail rather than silently relax policy.
The canonical package manifest includes this extension; use `/reload` after updating the repository.
No extra dependencies are needed. Run sync to install the new local depth
configuration file; the default budget also works before syncing.

## Tests

```bash
cd pi-custom-extensions
node --experimental-strip-types --test oneshot-subagent/*.test.ts
bun run check
```

The runner tests use the real launcher with fake login shells and fake Pi/Claude;
they do not make model calls. Interactive rendering and live-provider calls
still need a manual smoke test.
