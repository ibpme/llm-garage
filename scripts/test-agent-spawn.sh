#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd -P)
tmp=$(mktemp -d)
real_tmux=$(command -v tmux)
export TEST_TMUX_SOCKET="$tmp/tmux.sock" TEST_REAL_TMUX="$real_tmux"
trap '"$real_tmux" -S "$TEST_TMUX_SOCKET" kill-server 2>/dev/null || :; rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/login-bin" "$tmp/work"
# Skip real login profiles while preserving the launcher's argv contract.
cat > "$tmp/bin/bash" <<'SH'
#!/bin/bash
if [[ ${1:-} == -lic ]]; then
  printf 'login stdout\n'
  printf 'login stderr\n' >&2
  export PATH="$TEST_LOGIN_BIN:$PATH"
  shift 3
  exec "$@"
fi
exec /bin/bash "$@"
SH
cat > "$tmp/bin/pi" <<'SH'
#!/bin/bash
printf '%s\n' "$@" > "$TEST_ARGS"
printf '%s\n' "${CLAUDE_CODE_DISABLE_ADVISOR_TOOL:-unset}" > "$TEST_ADVISOR"
printf '%s\n' "${PI_AGENT_TASK_CHILD:-unset}" > "$TEST_CHILD"
sleep 1
printf '{"type":"test"}\n'
printf 'test stderr\n' >&2
exit "$(cat "$TEST_EXIT_FILE")"
SH
# Claude is only discoverable after the login shell initializes PATH.
cat > "$tmp/login-bin/claude" <<'SH'
#!/bin/bash
printf '%s\n' "$@" > "$TEST_ARGS"
printf '%s\n' "${CLAUDE_CODE_DISABLE_ADVISOR_TOOL:-unset}" > "$TEST_ADVISOR"
sleep 1
printf '{"type":"claude-test"}\n'
printf 'claude test stderr\n' >&2
exit "$(cat "$TEST_EXIT_FILE")"
SH
cat > "$tmp/bin/tmux" <<'SH'
#!/bin/bash
exec "$TEST_REAL_TMUX" -S "$TEST_TMUX_SOCKET" -f /dev/null "$@"
SH
chmod +x "$tmp/bin/"* "$tmp/login-bin/claude"
export PATH="$tmp/bin:$PATH" TEST_ARGS="$tmp/args" TEST_LOGIN_BIN="$tmp/login-bin"
export TEST_EXIT_FILE="$tmp/exit-code" TEST_CHILD="$tmp/child-marker"
export TEST_ADVISOR="$tmp/advisor" CLAUDE_CODE_DISABLE_ADVISOR_TOOL=0
prompt='Literal $(touch unwanted) ; "quoted" prompt'
for code in 0 7; do
  printf '%s\n' "$code" > "$TEST_EXIT_FILE"
  output=$(cd "$tmp" && /bin/bash "$root/scripts/agent-spawn.sh" \
    --name test --mode json --shell bash --cwd "$tmp/work" \
    --output-dir jobs --prompt "$prompt")
  job=${output##*Files: }
  [[ $job == /* && -f $job/pid ]]
  pid=$(cat "$job/pid")
  kill -0 "$pid"
  pgid=$(ps -o pgid= -p "$pid" | tr -d ' ')
  caller_pgid=$(ps -o pgid= -p "$$" | tr -d ' ')
  [[ $pgid != "$caller_pgid" ]]
  if [[ ! -f $job/tmux.session ]]; then
    echo 'Expected JSON job to record its detached tmux session' >&2
    exit 1
  fi
  tmux has-session -t "=$(cat "$job/tmux.session")"
  for ((i=0; i<50; i++)); do
    [[ ! -f $job/exit.status ]] || break
    sleep 0.1
  done
  [[ $(cat "$job/exit.status") == "$code" ]]
  [[ $(cat "$TEST_ADVISOR") == 0 ]]
  printf '%s\n' --mode json --no-session -- "$prompt" > "$tmp/expected"
  diff -u "$tmp/expected" "$TEST_ARGS"
  grep -Fx '{"type":"test"}' "$job/events.jsonl" >/dev/null
  grep -Fx 'test stderr' "$job/stderr.log" >/dev/null
  grep -Fx 'login stdout' "$job/launch.log" >/dev/null
  grep -Fx 'login stderr' "$job/stderr.log" >/dev/null
  [[ ! -e $tmp/work/unwanted ]]
done
if /bin/bash "$root/scripts/agent-spawn.sh" --name test --mode json \
  --prompt test --socket "$tmp/socket" >"$tmp/error" 2>&1; then
  echo 'Expected JSON --socket rejection' >&2
  exit 1
fi
grep -F -- '--socket is only available' "$tmp/error" >/dev/null
wait_for_job() {
  local job=$1
  for ((i=0; i<50; i++)); do
    [[ ! -f $job/exit.status ]] || break
    sleep 0.1
  done
  [[ -f $job/exit.status ]]
}

# Reusing a label must not collide with an already-running JSON session.
printf '0\n' > "$TEST_EXIT_FILE"
output=$(/bin/bash "$root/scripts/agent-spawn.sh" --name concurrent --mode json \
  --shell bash --cwd "$tmp/work" --output-dir "$tmp/jobs" --prompt test)
first_job=${output##*Files: }
output=$(/bin/bash "$root/scripts/agent-spawn.sh" --name concurrent --mode json \
  --shell bash --cwd "$tmp/work" --output-dir "$tmp/jobs" --prompt test)
second_job=${output##*Files: }
[[ $first_job != "$second_job" ]]
[[ $(cat "$first_job/tmux.session") != "$(cat "$second_job/tmux.session")" ]]
tmux has-session -t "=$(cat "$first_job/tmux.session")"
tmux has-session -t "=$(cat "$second_job/tmux.session")"
wait_for_job "$first_job"
wait_for_job "$second_job"
[[ $(cat "$first_job/exit.status") == 0 && $(cat "$second_job/exit.status") == 0 ]]

# Interactive sessions still use their requested name and reject duplicates.
/bin/bash "$root/scripts/agent-spawn.sh" --name interactive --shell bash \
  --cwd "$tmp/work" > "$tmp/interactive-launch"
tmux has-session -t '=interactive'
printf '\n' > "$tmp/expected"
diff -u "$tmp/expected" "$TEST_ARGS"
if /bin/bash "$root/scripts/agent-spawn.sh" --name interactive --shell bash \
  --cwd "$tmp/work" > "$tmp/error" 2>&1; then
  echo 'Expected duplicate interactive session rejection' >&2
  exit 1
fi
grep -F "already exists" "$tmp/error" >/dev/null
tmux kill-session -t '=interactive'

# Pi's optional arguments retain their exact ordering and values.
printf '0\n' > "$TEST_EXIT_FILE"
output=$(/bin/bash "$root/scripts/agent-spawn.sh" --name pi-options \
  --mode json --shell bash --cwd "$tmp/work" --output-dir "$tmp/jobs" \
  --model 'provider/model:literal' --provider provider --thinking high --prompt "$prompt")
job=${output##*Files: }
wait_for_job "$job"
printf '%s\n' --mode json --no-session --model 'provider/model:literal' --provider provider \
  --thinking high -- "$prompt" > "$tmp/expected"
diff -u "$tmp/expected" "$TEST_ARGS"

claude_base=(-p --output-format stream-json --verbose --include-partial-messages
  --no-session-persistence --tools 'Read,Glob,Grep,Edit,Write,Bash,WebFetch,WebSearch'
  --disallowedTools 'Agent,Task' --strict-mcp-config --mcp-config '{"mcpServers":{}}'
  --permission-mode auto --permission-prompts none)
# Provider is ignored even without a model; prompt-file content stays literal.
printf '%s' "$prompt" > "$tmp/prompt"
output=$(/bin/bash "$root/scripts/agent-spawn.sh" --name claude-default \
  --agent claude --mode json --shell bash --cwd "$tmp/work" \
  --output-dir "$tmp/jobs" --provider ignored --prompt-file "$tmp/prompt")
job=${output##*Files: }
wait_for_job "$job"
[[ $(cat "$job/exit.status") == 0 ]]
[[ $(cat "$TEST_ADVISOR") == 1 ]]
[[ $CLAUDE_CODE_DISABLE_ADVISOR_TOOL == 0 ]]
printf '%s\n' "${claude_base[@]}" -- "$prompt" > "$tmp/expected"
diff -u "$tmp/expected" "$TEST_ARGS"
grep -Fx '{"type":"claude-test"}' "$job/events.jsonl" >/dev/null
grep -Fx 'claude test stderr' "$job/stderr.log" >/dev/null

for effort in low medium high xhigh max; do
  printf '7\n' > "$TEST_EXIT_FILE"
  output=$(/bin/bash "$root/scripts/agent-spawn.sh" --name "claude-$effort" \
    --agent claude --mode json --shell bash --cwd "$tmp/work" \
    --output-dir "$tmp/jobs" --provider ignored --model 'literal/model:unchanged' \
    --effort "$effort" --prompt "$prompt")
  job=${output##*Files: }
  wait_for_job "$job"
  [[ $(cat "$job/exit.status") == 7 ]]
  [[ $(cat "$TEST_ADVISOR") == 1 ]]
  printf '%s\n' "${claude_base[@]}" --model 'literal/model:unchanged' \
    --effort "$effort" -- "$prompt" > "$tmp/expected"
  diff -u "$tmp/expected" "$TEST_ARGS"
  [[ ! -e $tmp/work/unwanted ]]
done

# The internal non-JSON execution path preserves advisor configuration for
# future regular Claude launches, even though the public CLI is JSON-only today.
mkdir -p "$tmp/interactive-status"
printf '0\n' > "$TEST_EXIT_FILE"
PATH="$tmp/login-bin:$PATH" /bin/bash "$root/scripts/agent-spawn.sh" \
  --run "$tmp/interactive-status" "$tmp/work" interactive '' claude \
  > "$tmp/interactive-output" 2> "$tmp/interactive-error"
[[ $(cat "$TEST_ADVISOR") == 0 ]]

expect_error() {
  local message=$1
  shift
  if /bin/bash "$root/scripts/agent-spawn.sh" --name invalid --prompt test \
    "$@" >"$tmp/error" 2>&1; then
    printf 'Expected rejection: %s\n' "$message" >&2
    exit 1
  fi
  grep -F -- "$message" "$tmp/error" >/dev/null
}
expect_error '--agent claude requires --mode json' --agent claude
expect_error '--agent claude requires --mode json' --agent claude --mode interactive
expect_error '--effort must be low, medium, high, xhigh or max' \
  --agent claude --mode json --effort invalid
expect_error '--effort must be low, medium, high, xhigh or max' \
  --agent claude --mode json --effort ''
expect_error '--thinking is only available with --agent pi' \
  --agent claude --mode json --thinking high
expect_error '--thinking is only available with --agent pi' \
  --agent claude --mode json --thinking ''
expect_error '--effort is only available with --agent claude' --mode json --effort high
expect_error '--effort is only available with --agent claude' --mode json --effort ''
expect_error '--provider requires --model' --mode json --provider provider
expect_error '--agent must be pi or claude' --agent unknown --mode json
if /bin/bash "$root/scripts/agent-spawn.sh" --name invalid --agent claude \
  --mode json >"$tmp/error" 2>&1; then
  echo 'Expected Claude JSON prompt requirement' >&2
  exit 1
fi
grep -F -- '--mode json requires --prompt or --prompt-file' "$tmp/error" >/dev/null
# The child marker must survive a tmux server that was started without it, and
# a stale marker in the server's global environment must not leak into normal launches.
# Bash 3.2 (macOS /bin/bash) ignores failed [[ ]] under set -e, so assert explicitly.
expect_child() {
  local name=$1 marker=$2 expected=$3 output job marker_env=(-u PI_AGENT_TASK_CHILD)
  [[ $marker != 1 ]] || marker_env=(PI_AGENT_TASK_CHILD=1)
  rm -f "$TEST_CHILD"
  output=$(env "${marker_env[@]}" /bin/bash "$root/scripts/agent-spawn.sh" --name "$name" \
    --mode json --shell bash --cwd "$tmp/work" --output-dir "$tmp/jobs" --prompt test)
  job=${output##*Files: }
  wait_for_job "$job"
  [[ $(cat "$job/exit.status") == 0 ]] || { echo "$name: pi did not exit cleanly" >&2; exit 1; }
  [[ $(cat "$TEST_CHILD") == "$expected" ]] \
    || { printf '%s: expected child marker %s, got %s\n' "$name" "$expected" "$(cat "$TEST_CHILD")" >&2; exit 1; }
}
tmux kill-server 2>/dev/null || :
env -u PI_AGENT_TASK_CHILD tmux new-session -d -s anchor sleep 600
expect_child marked-child 1 1
expect_child normal-root unset unset
tmux kill-server 2>/dev/null || :
PI_AGENT_TASK_CHILD=1 tmux new-session -d -s anchor sleep 600
expect_child stale-root unset unset
expect_child stale-marked-child 1 1
tmux kill-server 2>/dev/null || :

printf 'agent-spawn Pi/Claude JSON tests passed\n'
