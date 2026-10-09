#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: agent-spawn.sh --name NAME [--prompt TEXT | --prompt-file PATH] [options]

Start Pi in a detached tmux session. JSON mode requires a prompt.

Options:
  --name NAME          Unique tmux session name (letters, digits, _ or -)
  --prompt TEXT        Initial prompt
  --prompt-file PATH   Read the initial prompt from a file
  --cwd PATH           Working directory (default: current directory)
  --shell SHELL        Login/interactive shell to initialize (bash or zsh; default: zsh)
  --agent pi           Agent CLI (only pi is supported in v1)
  --mode MODE          interactive (default) or json (one-shot event stream)
  --output-dir PATH    Parent directory for JSON job files (default: ~/.local/state/agent-spawn)
  --model ID           Pi model ID
  --provider NAME      Pi model provider (requires --model)
  --thinking LEVEL     Pi thinking level
  --socket PATH        Use a specific tmux server socket
  -h, --help           Show this help

Interactive success means Pi survived a brief startup check. JSON success
means Pi was launched; its final result is recorded separately in exit.status.
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
  shift 4
  cd "$cwd" || exit 1
  agent_bin=$(command -v pi) || {
    printf 'pi is not on PATH after shell initialization\n' > "$status_dir/error"
    exit 1
  }
  if [[ -f $status_dir/prompt ]]; then
    prompt=$(cat "$status_dir/prompt") || exit 1
    set -- "$@" -- "$prompt"
  fi
  printf 'starting\n' > "$status_dir/started"
  if [[ $mode == json ]]; then
    if "$agent_bin" "$@" > "$job_dir/events.jsonl" 2> "$job_dir/stderr.log"; then
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

name='' prompt='' prompt_file='' cwd=$PWD shell=zsh agent=pi mode=interactive output_dir='' model='' provider='' thinking='' socket=''
has_prompt=0
while (( $# )); do
  case $1 in
    --name|--prompt|--prompt-file|--cwd|--shell|--agent|--mode|--output-dir|--model|--provider|--thinking|--socket)
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
        --thinking) thinking=$2 ;;
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
[[ $agent == pi ]] || fail 'only --agent pi is supported in v1'
[[ $mode == interactive || $mode == json ]] || fail '--mode must be interactive or json'
if [[ $mode == json ]]; then
  if (( !has_prompt )) && [[ -z $prompt_file ]]; then
    fail '--mode json requires --prompt or --prompt-file'
  fi
elif [[ -n $output_dir ]]; then
  fail '--output-dir is only available with --mode json'
fi
[[ -z $provider || -n $model ]] || fail '--provider requires --model'
[[ -z $prompt_file || -f $prompt_file && -r $prompt_file ]] || fail 'prompt file is not readable'
[[ -d $cwd ]] || fail 'working directory does not exist'
cwd=$(cd "$cwd" && pwd -P)
command -v tmux >/dev/null 2>&1 || fail 'tmux is not installed'
[[ $shell == bash || $shell == zsh || $shell == */bash || $shell == */zsh ]] \
  || fail '--shell must select bash or zsh'
shell_bin=$(command -v "$shell") || fail "shell '$shell' is not on PATH"
[[ $shell_bin == /* && -x $shell_bin ]] || fail "shell '$shell' is not an executable path"
bash_bin=$(command -v bash) || fail 'bash is not on PATH'
script=$(cd "$(dirname "$0")" && pwd -P)/$(basename "$0")
tmux_cmd=(tmux)
[[ -z $socket ]] || tmux_cmd+=(-S "$socket")

# An exact target avoids accidentally matching another session with a similar name.
if "${tmux_cmd[@]}" has-session -t "=$name" 2>/dev/null; then
  fail "tmux session '$name' already exists"
fi

status_dir=$(mktemp -d "${TMPDIR:-/tmp}/agent-spawn.XXXXXXXX")
trap 'rm -rf "$status_dir"' EXIT
job_dir=''
if [[ $mode == json ]]; then
  output_dir=${output_dir:-${XDG_STATE_HOME:-${HOME:?}/.local/state}/agent-spawn}
  mkdir -p "$output_dir"
  job_dir=$(mktemp -d "$output_dir/$name.XXXXXXXX")
  : > "$job_dir/events.jsonl"
  : > "$job_dir/stderr.log"
fi
if [[ -n $prompt_file ]]; then
  cp "$prompt_file" "$status_dir/prompt"
elif (( has_prompt )); then
  printf '%s' "$prompt" > "$status_dir/prompt"
fi

agent_args=(--run "$status_dir" "$cwd" "$mode" "$job_dir")
[[ $mode != json ]] || agent_args+=(--mode json)
[[ -z $model ]] || agent_args+=(--model "$model")
[[ -z $provider ]] || agent_args+=(--provider "$provider")
[[ -z $thinking ]] || agent_args+=(--thinking "$thinking")

# tmux passes these as argv. Only the fixed exec command is interpreted by
# the login shell; prompt text stays in a private file, never in shell syntax.
"${tmux_cmd[@]}" new-session -d -s "$name" -c "$cwd" "$shell_bin" -lic \
  'exec "$@"' agent-spawn-shell "$bash_bin" "$script" "${agent_args[@]}" \
  || fail_launch 'could not create tmux session'

started=0
for (( i=0; i<30; i++ )); do
  if [[ -f $status_dir/started ]]; then started=1; break; fi
  if ! "${tmux_cmd[@]}" has-session -t "=$name" 2>/dev/null; then break; fi
  sleep 0.1
done
if (( !started )); then
  [[ ! -f $status_dir/error ]] || fail_launch "$(cat "$status_dir/error")"
  fail_launch "agent did not start in tmux session '$name'"
fi
if [[ $mode == json ]]; then
  printf 'Started JSON job %s. Files: %s\n' "$name" "$job_dir"
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
