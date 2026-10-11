import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Installs fake login shells and fake `pi`/`claude` executables in `<root>/bin`
 * for the real agent-spawn launcher. The fake agents read ONESHOT_TEST_CASE
 * (success, large, error, exit, hang, missing-result) and record their
 * arguments in `<root>/args.json`. No model calls are made.
 */
export async function installFakeAgents(root: string): Promise<string> {
  const bin = join(root, "bin");
  await mkdir(bin);
  const shell = '#!/bin/bash\nif [[ ${1:-} == -lic ]]; then shift 3; exec "$@"; fi\nexec /bin/bash "$@"\n';
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
    { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: output }], usage, stopReason: mode === 'error' ? 'error' : 'stop', errorMessage: mode === 'error' ? 'provider failed' : undefined } },
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
