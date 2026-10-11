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
| `agent` | `pi`; use `claude` for Claude Code |
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
turns, tool calls, token/cost figures, recent tool activity, and an answer preview.
For Pi and Claude, tokens are the latest completed model call (`last call: ↓ input · ↑ output
· cached`, where cached is cache reads plus cache writes); cost is cumulative for
the whole run. Before a call completes, no token figure is shown. Cumulative totals
are reported to Pi as tool usage, not displayed.

The context segment (`context 34.2k / 200k · 17%`) is a **last-call snapshot**: the
latest completed call's input plus cache reads and cache writes. Output and
cumulative run totals are excluded. Its capacity is the verified context window of
that call's actual model, never the parent's:

- Pi: the child's last completed assistant message names its provider and model.
  That pair is looked up in the parent's model registry. An entry whose
  `models.json` declaration omits `contextWindow` is unknown, because Pi fills
  those with 128k. Other registry values are trusted as Pi reports them, including
  models registered by extensions. Models Pi cannot resolve are unknown.
- Claude: the terminal `result` supplies `modelUsage[model].contextWindow` for the
  last call's model only. Helper models are ignored and windows are never summed.
  Capacity stays unknown while the run is live, and after an interrupted run.
- Unverified capacity displays `context 34.2k / unknown` with no percentage and no
  warning. The segment is omitted until a call completes.

The tone is the theme's `dim` below 70%, `warning` from 70% up to 90%, and `error`
at 90% and above. Percentages are floored, so the displayed figure agrees with the tone.
The rest of the stats line keeps its existing dim styling.
Expand the result using Pi's normal tool expansion to see activity, working
directory/model, Markdown output, and the job directory. Thinking content is not
displayed or returned.

Results saved by earlier versions that contain nested subagent snapshots still
render: only the top-level run is shown, with a "nested runs: see job logs" notice.

## Lifecycle and failures

- Esc / tool cancellation, timeout, or session shutdown terminates the child's
  process group, including its tools, with SIGTERM then SIGKILL.
- Cancellation during launch waits for launch acknowledgement (up to 15 seconds)
  so the detached PID can be cleaned up.
- Exit status 0 alone is not success: the JSON stream must settle without abort
  and end with a completed, nonempty assistant answer. Errors, missing exit
  status, malformed JSON, and incomplete responses are returned as tool errors.
- Pi usage is summed from completed assistant/tool-result messages for run
  accounting and cost. Claude cumulative usage is summed the same way, per message
  ID, before a result. The displayed token breakdown for both backends is the latest
  completed assistant call only: tool-result, user, and nested-subagent events never
  replace it, and a completion without usage clears it rather than showing older
  data. Terminal totals do not replace it either; the last completed call stays
  displayed through the final result. Claude completion is a `message_stop` or
  full `assistant` event, deduplicated by message ID. Claude uses
  terminal `modelUsage` totals (falling back to `usage` for older streams) and
  `total_cost_usd`, replacing provisional streamed usage rather than adding it
  again. Before a result, cumulative per-message usage is deduplicated by message
  ID and marked partial for accounting. Interrupted runs preserve those partial token totals;
  cost is unavailable until a result. Both are reported once to Pi as tool usage.
  Pi's `totalTokens` remains cumulative accounting, not the display.
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
The leaf rule and Claude leaf policy still apply. Switching modes does not
revoke already-running children; cancel them first if needed.

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

The runner tests use the real launcher with fake login shells and fake Pi/Claude;
they do not make model calls. Interactive rendering and live-provider calls
still need a manual smoke test.
