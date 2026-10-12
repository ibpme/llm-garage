import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const execText = (file: string, args: string[]) => new Promise<string>((resolve, reject) =>
  execFile(file, args, { encoding: "utf8" }, (error, stdout) => error ? reject(error) : resolve(stdout.trim())));

/**
 * Installs fake login shells, a fake `tmux` and fake `pi`/`claude` executables
 * in `<root>/bin` for the real agent-spawn launcher. The fake agents read
 * ONESHOT_TEST_CASE (success, large, error, exit, hang, missing-result) and
 * record their arguments in `<root>/args.json`. No model calls are made.
 *
 * tmux sessions inherit the server's environment, not the launching client's,
 * so `tmux` targets a private server and passes PATH and ONESHOT_TEST_CASE to
 * every new session; the fake shell also puts this bin first. A launch can
 * therefore never reach real agents or another tmux server's state. Call
 * stopFakeAgents(root) to kill the private server.
 */
export async function installFakeAgents(root: string): Promise<string> {
  const bin = join(root, "bin");
  await mkdir(bin);
  // Short fixed directory: Unix socket paths are limited to ~100 bytes on macOS.
  const socket = `/tmp/oneshot-tmux-${randomBytes(6).toString("hex")}.sock`;
  await writeFile(join(root, "tmux.socket"), socket);
  const realTmux = await execText("/bin/bash", ["-c", "command -v tmux"]);
  await writeFile(join(bin, "tmux"), `#!/bin/bash
tmux=(${JSON.stringify(realTmux)} -S ${JSON.stringify(socket)} -f /dev/null)
if [[ \${1:-} == new-session ]]; then
  shift
  exec "\${tmux[@]}" new-session -e "PATH=$PATH" -e "ONESHOT_TEST_CASE=\${ONESHOT_TEST_CASE-}" "$@"
fi
exec "\${tmux[@]}" "$@"
`, { mode: 0o755 });
  // Keep the private server alive between jobs, as a user's server normally is,
  // instead of starting and exiting it around every job session.
  await execText(realTmux, ["-S", socket, "-f", "/dev/null", "new-session", "-d", "-s", "keepalive", "sleep 3600"]);
  const shell = `#!/bin/bash\nexport PATH=${JSON.stringify(bin)}:"$PATH"\nif [[ \${1:-} == -lic ]]; then shift 3; exec "$@"; fi\nexec /bin/bash "$@"\n`;
  for (const name of ["bash", "zsh"]) await writeFile(join(bin, name), shell, { mode: 0o755 });
  await writeFile(join(bin, "pi"), `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(join(root, "args.json"))}, JSON.stringify({ args: process.argv.slice(2), child: process.env.PI_ONESHOT_SUBAGENT_CHILD, cwd: process.cwd() }));
const mode = process.env.ONESHOT_TEST_CASE;
if (mode === 'hang') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); }
else {
  const usage = { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } };
  const output = mode === 'large' ? 'x'.repeat(50000) : 'Final 😀 answer';
  const events = [
    { type: 'session', id: 'test' },
    { type: 'tool_execution_start', toolName: 'read', args: { path: 'file.ts' } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Final 😀' } },
    { type: 'message_end', message: { role: 'assistant', provider: 'fake-provider', model: 'fake-model', content: [{ type: 'text', text: output }], usage, stopReason: mode === 'error' ? 'error' : 'stop', errorMessage: mode === 'error' ? 'provider failed' : undefined } },
    { type: 'agent_settled', aborted: false },
  ];
  const buffer = Buffer.from(events.map(e => JSON.stringify(e)).join('\\n') + '\\n');
  const split = buffer.indexOf(Buffer.from('😀')) + 1;
  fs.writeSync(1, buffer.subarray(0, split));
  setTimeout(() => { fs.writeSync(1, buffer.subarray(split)); if (mode === 'exit') process.exitCode = 7; }, 300);
}
`, { mode: 0o755 });
  await writeFile(join(bin, "claude"), `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(join(root, "args.json"))}, JSON.stringify({ args: process.argv.slice(2), child: process.env.PI_ONESHOT_SUBAGENT_CHILD }));
const mode = process.env.ONESHOT_TEST_CASE;
if (mode === 'hang') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); }
else {
  const events = [
    { type: 'system', subtype: 'init', model: 'claude-model' },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Live 😀' } } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'file.ts' } }] } },
  ];
  if (mode !== 'missing-result') events.push({ type: 'result', subtype: mode === 'error' ? 'error_during_execution' : 'success',
    is_error: mode === 'error', errors: mode === 'error' ? ['Claude provider failed'] : [], result: mode === 'large' ? 'x'.repeat(50000) : 'Claude final 😀 answer',
    num_turns: 2, total_cost_usd: 0.02, usage: { input_tokens: 7, output_tokens: 3 } });
  const buffer = Buffer.from(events.map(e => JSON.stringify(e)).join('\\n') + '\\n');
  const split = buffer.lastIndexOf(Buffer.from('😀')) + 1;
  fs.writeSync(1, buffer.subarray(0, split));
  setTimeout(() => { fs.writeSync(1, buffer.subarray(split)); if (mode === 'exit') process.exitCode = 7; }, 1200);
}
`, { mode: 0o755 });
  return bin;
}

/** Kills the private tmux server started by installFakeAgents. */
export async function stopFakeAgents(root: string): Promise<void> {
  const socket = await readFile(join(root, "tmux.socket"), "utf8").catch(() => undefined);
  if (!socket) return;
  const realTmux = await execText("/bin/bash", ["-c", "command -v tmux"]).catch(() => undefined);
  if (realTmux) await execText(realTmux, ["-S", socket, "kill-server"]).catch(() => {});
  await rm(socket, { force: true });
}
