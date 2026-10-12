# Agent launcher

[`agent-spawn.sh`](agent-spawn.sh) starts interactive Pi or a single-task
Pi/Claude Code JSON job in a detached tmux session. It initializes
an interactive login shell before resolving the agent executable, so shell
startup files can supply credentials and update `PATH`.

Examples below run from the repository root.

## Requirements

- Bash to run the launcher.
- Zsh (default) or Bash for login-shell initialization.
- `pi` or `claude` available on `PATH` **after** login-shell initialization.
- tmux available on the launcher's `PATH` for both modes; Node.js is not required
  by the launcher.

Claude Code must support the flags used by the launcher, including
`--permission-mode auto` and `--permission-prompts none`. Unsupported flags
cause the agent to fail; the launcher does not fall back to a weaker policy.

## Interactive Pi

Start Pi ready for input, then attach:

```bash
./scripts/agent-spawn.sh --name coding --cwd "$PWD"
tmux attach -t coding
```

Or supply an initial task:

```bash
./scripts/agent-spawn.sh --name review-api --cwd "$PWD" \
  --prompt 'Review src/api for correctness. Do not edit files.'
```

Detach using tmux's usual `Ctrl-b`, then `d`. The session stays alive while Pi
runs. A name that already exists on the selected tmux server is rejected.
Claude is not supported in interactive mode.

To use Bash and a separate tmux server socket:

```bash
./scripts/agent-spawn.sh --name coding --shell bash --socket /tmp/agent-tmux.sock
tmux -S /tmp/agent-tmux.sock attach -t coding
```

A successful launch means Pi survived a brief startup check, not that its task
has completed.

## Detached JSON jobs

JSON mode requires `--prompt` or `--prompt-file` and returns after startup;
it does **not** wait for the agent's final answer. Session persistence is disabled
for both agents: Pi uses `--no-session`, and Claude uses `--no-session-persistence`.
Interactive Pi keeps its normal session persistence. JSON job logs remain on disk.

```bash
# Pi
./scripts/agent-spawn.sh --name review-once --mode json \
  --cwd "$PWD" --prompt-file /path/to/task.md

# Claude Code
./scripts/agent-spawn.sh --name claude-review --agent claude --mode json \
  --model sonnet --effort high \
  --prompt 'Review src/api. Do not edit files. Return findings with paths.'
```

The launcher prints the wrapper PID and absolute job-directory path:

```text
Started JSON job review-once (PID 12345). Files: /…/agent-spawn/review-once.ABCDEFGH
```

Each launch gets a unique directory and tmux session, even when reusing a job
name. The session name is recorded in `tmux.session`; the session normally closes
when the job exits. The default
parent is `${XDG_STATE_HOME:-$HOME/.local/state}/agent-spawn`. Override it with
`--output-dir /path/to/jobs`; relative paths resolve from the launcher's current
directory, not `--cwd`.

### Job files

| File | Contents |
| --- | --- |
| `pid` | Bash wrapper PID inside the tmux pane. |
| `tmux.session` | Unique detached tmux session name. |
| `events.jsonl` | Agent stdout: Pi JSON events or Claude's verbose streaming JSON, including partial messages. |
| `stderr.log` | Shell and agent stderr. |
| `launch.log` | Login-shell stdout before the agent starts. |
| `exit.status` | Numeric agent exit code; written atomically after the agent exits. |
| `launch.error` | Launcher error message, when launch fails after creating the job directory. |

Inspect a job using the directory printed by the launcher:

```bash
job=/absolute/path/to/agent-spawn/review-once.ABCDEFGH
tail -f "$job/events.jsonl"
# Once finished:
cat "$job/exit.status"
cat "$job/stderr.log"
```

**Launcher exit status 0 means startup was acknowledged, not task success.**
Inspect both `exit.status` and the event stream. An agent can exit with status 0
while its response reports an error or abort. A missing `exit.status` means no
normal exit was recorded yet: the job may still be running, may have failed
before agent execution, or may have been forcibly terminated.

The launcher does not impose a timeout or clean up completed job files. To stop
an active job, terminate its tmux session:

```bash
tmux kill-session -t "=$(cat "$job/tmux.session")"
```

Job directories are private, but logs can contain sensitive prompts, tool
arguments, credentials, and results. Remove them manually when no longer needed.

## Options

```text
agent-spawn.sh --name NAME [--prompt TEXT | --prompt-file PATH] [options]
```

| Option | Default / behavior |
| --- | --- |
| `--name NAME` | Required. Starts with a letter or digit; remaining characters may be letters, digits, `_`, or `-`. tmux session name or JSON job label. |
| `--prompt TEXT` | Initial prompt. Optional for interactive Pi; required in JSON mode unless using `--prompt-file`. |
| `--prompt-file PATH` | Read a prompt from a readable file. Mutually exclusive with `--prompt`. |
| `--cwd PATH` | Current directory. Must exist. |
| `--shell SHELL` | `zsh`. Accepts `bash`, `zsh`, or a path ending in `/bash` or `/zsh`; resolved via `PATH`. |
| `--agent AGENT` | `pi`; alternatively `claude` in JSON mode only. |
| `--mode MODE` | `interactive`; alternatively `json`. |
| `--output-dir PATH` | JSON-only parent directory for persistent job files. |
| `--model ID` | Forwarded unchanged to the agent; omission uses its own defaults. |
| `--provider NAME` | Pi only; requires `--model`. Ignored for Claude, even without a model. |
| `--thinking LEVEL` | Pi only; nonempty values are forwarded to Pi for validation. |
| `--effort LEVEL` | Claude only: `low`, `medium`, `high`, `xhigh`, or `max`. Model/version compatibility is validated by Claude. |
| `--socket PATH` | Interactive-only tmux server socket. |
| `-h`, `--help` | Show usage. |

The raw launcher does not translate model IDs or normalize reasoning suffixes.
For Claude, use `--model sonnet --effort high`, not an extension-specific
`sonnet:high` shorthand.

Prompt text is copied to a temporary private file and passed as a literal
argument, not interpolated into shell syntax. Quote inline prompts to prevent
expansion by your calling shell. Trailing newlines are stripped when the prompt
is read into a shell variable.

## Permissions and delegation

**This launcher is not a sandbox.** Agents run with the local user's access and
configuration; shell startup files also execute. A prompt saying “do not edit”
is not an enforced read-only boundary.

Pi uses its normal configuration and tools. The raw launcher does not mark Pi
as an agent-task leaf or disable its delegation extensions.

Claude JSON jobs use a restricted built-in tool set:
`Read`, `Glob`, `Grep`, `Edit`, `Write`, `Bash`, `WebFetch`, and `WebSearch`.
Native `Agent`/`Task` delegation is explicitly denied, MCP servers are disabled,
and the advisor tool is disabled. Permission mode is `auto`, with unattended
permission prompts denied and no permission-bypass flag. Session persistence
is disabled.

Claude's normal settings, hooks, plugins, and discovered skill context can
still load. Allowed shell commands or hooks can launch other processes, so the
leaf tool policy is not process isolation. See the
[agent-task extension's Claude leaf policy](../pi-custom-extensions/agent-task/README.md#claude-leaf-capabilities)
for details.

The [agent-task extension](../pi-custom-extensions/agent-task/README.md)
wraps this launcher with a detached per-job supervisor, final-answer extraction,
cancellation, timeouts, foreground/background waiting and root/leaf delegation
guards. Those are extension features, not guarantees of the raw script. The [`/agents` extension](../pi-custom-extensions/agents/README.md)
can discover running jobs; it displays JSON jobs as read-only entries. The raw
launcher now uses tmux for JSON jobs too, but their output remains in job files
rather than in the pane.

## Troubleshooting

- **Agent not on `PATH` after shell initialization:** check the selected shell's
  login/interactive startup files, or select the appropriate `--shell`.
- **Agent did not start:** inspect `launch.error`, `stderr.log`, and `launch.log`
  if a job directory was created. Startup acknowledgement is checked for roughly
  three seconds; slow shell startup can exceed that window.
- **Agent exited immediately in tmux:** run the agent directly in the same
  working directory and shell to inspect its startup error.
- **JSON launch succeeds but the task fails:** inspect `exit.status` and
  `events.jsonl`; startup and completion are separate outcomes.
- **Claude tool permission denial:** configure appropriate Claude allow rules.
  The launcher does not offer an interactive permission host or bypass denials.

## Tests

```bash
bash scripts/test-agent-spawn.sh
```

The regression tests use fake agents and login shells with a real tmux server
on an isolated socket. They cover Pi/Claude JSON argument forwarding, literal
prompts, output capture, exit-status recording, concurrent same-label jobs,
interactive session startup and collision handling, Claude policy flags, and
option validation. They make no model calls.
