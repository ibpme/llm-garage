#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: agent-spawn.sh --name NAME [--prompt TEXT | --prompt-file PATH] [options]

Start Pi in tmux (interactive) or Pi/Claude as a detached job (JSON).
JSON requires a prompt; Claude supports JSON mode only.

Options:
  --name NAME          Session name or JSON job label (letters, digits, _ or -)
  --prompt TEXT        Initial prompt
  --prompt-file PATH   Read the initial prompt from a file
  --cwd PATH           Working directory (default: current directory)
  --shell SHELL        Login/interactive shell to initialize (bash or zsh; default: zsh)
  --agent AGENT        pi (default) or claude (JSON only)
  --mode MODE          interactive (default) or json (one-shot event stream)
  --output-dir PATH    Parent directory for JSON job files (default: ~/.local/state/agent-spawn)
  --model ID           Model ID, forwarded unchanged
  --provider NAME      Pi model provider (requires --model); ignored for Claude
  --thinking LEVEL     Pi-only thinking level
  --effort LEVEL       Claude-only effort: low, medium, high, xhigh or max
  --socket PATH        Use a specific tmux server socket (interactive only)
  -h, --help           Show this help

Interactive success means Pi survived a brief startup check. JSON success
means the agent was launched; its final result is recorded separately in exit.status.
Claude is restricted to built-in leaf tools with MCP disabled and unattended
permission prompts denied. User settings, hooks and skills still load; this is
not a sandbox.
EOF
}

fail() { printf 'agent-spawn: %s\n' "$*" >&2; exit 1; }

fail_launch() {
  if [[ -n $job_dir ]]; then
    printf '%s\n' "$*" > "$job_dir/launch.error"
    printf 'agent-spawn: job files: %s\n' "$job_dir" >&2
  fi
  fail "$*"
}

if [[ ${1:-} == --run ]]; then
  shift
  status_dir=$1
  cwd=$2
  mode=$3
  job_dir=$4
  agent=$5
  shift 5
  cd "$cwd" || exit 1
  [[ $agent == pi || $agent == claude ]] || fail 'invalid internal agent'
  agent_bin=$(command -v "$agent") || {
    printf '%s is not on PATH after shell initialization\n' "$agent" > "$status_dir/error"
    exit 1
  }
  if [[ -f $status_dir/prompt ]]; then
    prompt=$(cat "$status_dir/prompt") || exit 1
    set -- "$@" -- "$prompt"
  fi
  printf 'starting\n' > "$status_dir/started"
  if [[ $mode == json ]]; then
    if [[ $agent == claude ]]; then
      export CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1
    fi
    if "$agent_bin" "$@" > "$job_dir/events.jsonl" 2>> "$job_dir/stderr.log"; then
      exit_code=0
    else
      exit_code=$?
    fi
    printf '%s\n' "$exit_code" > "$job_dir/exit.status.tmp"
    mv "$job_dir/exit.status.tmp" "$job_dir/exit.status"
    exit "$exit_code"
  fi
  exec "$agent_bin" "$@"
fi

name='' prompt='' prompt_file='' cwd=$PWD shell=zsh agent=pi mode=interactive output_dir='' model='' provider='' thinking='' effort='' socket=''
has_prompt=0 has_thinking=0 has_effort=0
while (( $# )); do
  case $1 in
    --name|--prompt|--prompt-file|--cwd|--shell|--agent|--mode|--output-dir|--model|--provider|--thinking|--effort|--socket)
      (( $# >= 2 )) || { usage >&2; exit 2; }
      case $1 in
        --name) name=$2 ;;
        --prompt) prompt=$2; has_prompt=1 ;;
        --prompt-file) prompt_file=$2 ;;
        --cwd) cwd=$2 ;;
        --shell) shell=$2 ;;
        --agent) agent=$2 ;;
        --mode) mode=$2 ;;
        --output-dir) output_dir=$2 ;;
        --model) model=$2 ;;
        --provider) provider=$2 ;;
        --thinking) thinking=$2; has_thinking=1 ;;
        --effort) effort=$2; has_effort=1 ;;
        --socket) socket=$2 ;;
      esac
      shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

[[ $name =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]*$ ]] || fail 'provide --name using letters, digits, _ or - (starting with a letter or digit)'
if (( has_prompt )) && [[ -n $prompt_file ]]; then
  fail 'provide at most one of --prompt or --prompt-file'
fi
[[ $agent == pi || $agent == claude ]] || fail '--agent must be pi or claude'
[[ $mode == interactive || $mode == json ]] || fail '--mode must be interactive or json'
if [[ $agent == claude ]]; then
  [[ $mode == json ]] || fail '--agent claude requires --mode json'
  (( !has_thinking )) || fail '--thinking is only available with --agent pi'
  if (( has_effort )); then
    case $effort in
      low|medium|high|xhigh|max) ;;
      *) fail '--effort must be low, medium, high, xhigh or max' ;;
    esac
  fi
else
  (( !has_effort )) || fail '--effort is only available with --agent claude'
  [[ -z $provider || -n $model ]] || fail '--provider requires --model'
fi
if [[ $mode == json ]]; then
  if (( !has_prompt )) && [[ -z $prompt_file ]]; then
    fail '--mode json requires --prompt or --prompt-file'
  fi
elif [[ -n $output_dir ]]; then
  fail '--output-dir is only available with --mode json'
fi
[[ -z $prompt_file || -f $prompt_file && -r $prompt_file ]] || fail 'prompt file is not readable'
[[ -d $cwd ]] || fail 'working directory does not exist'
cwd=$(cd "$cwd" && pwd -P)
if [[ $mode == interactive ]]; then
  command -v tmux >/dev/null 2>&1 || fail 'tmux is not installed'
else
  [[ -z $socket ]] || fail '--socket is only available with interactive mode'
  node_bin=$(command -v node) || fail 'node is required for detached JSON jobs'
fi
[[ $shell == bash || $shell == zsh || $shell == */bash || $shell == */zsh ]] \
  || fail '--shell must select bash or zsh'
shell_bin=$(command -v "$shell") || fail "shell '$shell' is not on PATH"
[[ $shell_bin == /* && -x $shell_bin ]] || fail "shell '$shell' is not an executable path"
bash_bin=$(command -v bash) || fail 'bash is not on PATH'
script=$(cd "$(dirname "$0")" && pwd -P)/$(basename "$0")
tmux_cmd=(tmux)
[[ -z $socket ]] || tmux_cmd+=(-S "$socket")

# An exact target avoids accidentally matching another session with a similar name.
if [[ $mode == interactive ]] && "${tmux_cmd[@]}" has-session -t "=$name" 2>/dev/null; then
  fail "tmux session '$name' already exists"
fi

status_dir=$(mktemp -d "${TMPDIR:-/tmp}/agent-spawn.XXXXXXXX")
trap 'rm -rf "$status_dir"' EXIT
job_dir=''
if [[ $mode == json ]]; then
  output_dir=${output_dir:-${XDG_STATE_HOME:-${HOME:?}/.local/state}/agent-spawn}
  mkdir -p "$output_dir"
  output_dir=$(cd "$output_dir" && pwd -P)
  job_dir=$(mktemp -d "$output_dir/$name.XXXXXXXX")
  : > "$job_dir/events.jsonl"
  : > "$job_dir/stderr.log"
fi
if [[ -n $prompt_file ]]; then
  cp "$prompt_file" "$status_dir/prompt"
elif (( has_prompt )); then
  printf '%s' "$prompt" > "$status_dir/prompt"
fi

agent_args=(--run "$status_dir" "$cwd" "$mode" "$job_dir" "$agent")
if [[ $agent == claude ]]; then
  agent_args+=(-p --output-format stream-json --verbose --include-partial-messages
    --no-session-persistence
    --tools 'Read,Glob,Grep,Edit,Write,Bash,WebFetch,WebSearch'
    --disallowedTools 'Agent,Task'
    --strict-mcp-config --mcp-config '{"mcpServers":{}}'
    --permission-mode dontAsk --permission-prompts none)
  [[ -z $model ]] || agent_args+=(--model "$model")
  (( !has_effort )) || agent_args+=(--effort "$effort")
else
  [[ $mode != json ]] || agent_args+=(--mode json)
  [[ -z $model ]] || agent_args+=(--model "$model")
  [[ -z $provider ]] || agent_args+=(--provider "$provider")
  [[ -z $thinking ]] || agent_args+=(--thinking "$thinking")
fi

if [[ $mode == json ]]; then
  # A separate session isolates the job from Pi's bash-tool process-group cleanup.
  "$node_bin" - "$job_dir" "$cwd" "$shell_bin" "$bash_bin" "$script" "${agent_args[@]}" <<'JS' \
    || fail_launch 'could not create detached JSON job'
const { spawn } = require('node:child_process');
const { openSync, closeSync, writeFileSync } = require('node:fs');
const [jobDir, cwd, shell, bash, script, ...args] = process.argv.slice(2);
const out = openSync(`${jobDir}/launch.log`, 'a');
const err = openSync(`${jobDir}/stderr.log`, 'a');
const child = spawn(shell, ['-lic', 'exec "$@"', 'agent-spawn-shell', bash, script, ...args], {
  cwd,
  detached: true,
  stdio: ['ignore', out, err],
});
closeSync(out);
closeSync(err);
child.once('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.once('spawn', () => {
  writeFileSync(`${jobDir}/pid`, `${child.pid}\n`);
  child.unref();
});
JS
else
  # Prompt text stays in a private file, never in shell syntax.
  "${tmux_cmd[@]}" new-session -d -s "$name" -c "$cwd" "$shell_bin" -lic \
    'exec "$@"' agent-spawn-shell "$bash_bin" "$script" "${agent_args[@]}" \
    || fail_launch 'could not create tmux session'
fi

started=0
for (( i=0; i<30; i++ )); do
  if [[ -f $status_dir/started ]]; then started=1; break; fi
  if [[ $mode == json ]]; then
    [[ ! -f $status_dir/error ]] || break
    kill -0 "$(cat "$job_dir/pid")" 2>/dev/null || break
  elif ! "${tmux_cmd[@]}" has-session -t "=$name" 2>/dev/null; then
    break
  fi
  sleep 0.1
done
if (( !started )); then
  [[ ! -f $status_dir/error ]] || fail_launch "$(cat "$status_dir/error")"
  fail_launch "agent did not start: '$name'"
fi
if [[ $mode == json ]]; then
  printf 'Started JSON job %s (PID %s). Files: %s\n' "$name" "$(cat "$job_dir/pid")" "$job_dir"
  exit 0
fi

# Interactive sessions should remain alive so they can be attached to.
sleep 0.3
"${tmux_cmd[@]}" has-session -t "=$name" 2>/dev/null || fail "agent exited immediately in tmux session '$name'"
[[ $("${tmux_cmd[@]}" list-panes -t "=$name" -F '#{pane_dead}' 2>/dev/null) == 0 ]] \
  || fail "agent exited immediately in tmux session '$name'"

printf 'Started %s. Attach with: ' "$name"
if [[ -n $socket ]]; then
  printf 'tmux -S %q attach -t %q\n' "$socket" "$name"
else
  printf 'tmux attach -t %q\n' "$name"
fi
