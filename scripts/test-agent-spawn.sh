#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd -P)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/login-bin" "$tmp/work"
# Skip real login profiles while preserving the launcher's argv contract.
cat > "$tmp/bin/bash" <<'SH'
#!/bin/bash
if [[ ${1:-} == -lic ]]; then
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
sleep 1
printf '{"type":"test"}\n'
printf 'test stderr\n' >&2
exit "${TEST_EXIT:-0}"
SH
# Claude is only discoverable after the login shell initializes PATH.
cat > "$tmp/login-bin/claude" <<'SH'
#!/bin/bash
printf '%s\n' "$@" > "$TEST_ARGS"
printf '%s\n' "${CLAUDE_CODE_DISABLE_ADVISOR_TOOL:-unset}" > "$TEST_ADVISOR"
sleep 1
printf '{"type":"claude-test"}\n'
printf 'claude test stderr\n' >&2
exit "${TEST_EXIT:-0}"
SH
cat > "$tmp/bin/tmux" <<'SH'
#!/bin/bash
printf 'tmux must not be invoked for JSON\n' >&2
exit 99
SH
chmod +x "$tmp/bin/"* "$tmp/login-bin/claude"
export PATH="$tmp/bin:$PATH" TEST_ARGS="$tmp/args" TEST_LOGIN_BIN="$tmp/login-bin"
export TEST_ADVISOR="$tmp/advisor" CLAUDE_CODE_DISABLE_ADVISOR_TOOL=0
prompt='Literal $(touch unwanted) ; "quoted" prompt'
for code in 0 7; do
  export TEST_EXIT=$code
  output=$(cd "$tmp" && /bin/bash "$root/scripts/agent-spawn.sh" \
    --name test --mode json --shell bash --cwd "$tmp/work" \
    --output-dir jobs --prompt "$prompt")
  job=${output##*Files: }
  [[ $job == /* && -f $job/pid ]]
  pid=$(cat "$job/pid")
  kill -0 "$pid"
  pgid=$(ps -o pgid= -p "$pid" | tr -d ' ')
  [[ $pgid == "$pid" ]]
  for ((i=0; i<50; i++)); do
    [[ ! -f $job/exit.status ]] || break
    sleep 0.1
  done
  [[ $(cat "$job/exit.status") == "$code" ]]
  [[ $(cat "$TEST_ADVISOR") == 0 ]]
  printf '%s\n' --mode json -- "$prompt" > "$tmp/expected"
  diff -u "$tmp/expected" "$TEST_ARGS"
  grep -Fx '{"type":"test"}' "$job/events.jsonl" >/dev/null
  grep -Fx 'test stderr' "$job/stderr.log" >/dev/null
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

# Pi's optional arguments retain their exact ordering and values.
export TEST_EXIT=0
output=$(/bin/bash "$root/scripts/agent-spawn.sh" --name pi-options \
  --mode json --shell bash --cwd "$tmp/work" --output-dir "$tmp/jobs" \
  --model 'provider/model:literal' --provider provider --thinking high --prompt "$prompt")
job=${output##*Files: }
wait_for_job "$job"
printf '%s\n' --mode json --model 'provider/model:literal' --provider provider \
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
  export TEST_EXIT=7
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
TEST_EXIT=0 PATH="$tmp/login-bin:$PATH" /bin/bash "$root/scripts/agent-spawn.sh" \
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
printf 'agent-spawn Pi/Claude JSON tests passed\n'
