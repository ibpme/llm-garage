#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { basename, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 4096 ? value : undefined;

async function identify(parseProcesses, fields) {
  const { stdout } = await execute('ps', ['-axo', fields], {
    encoding: 'utf8', timeout: 1000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
  });
  const processes = parseProcesses(stdout);
  const seen = new Set([process.pid]);
  let pid = processes.get(process.pid)?.ppid;
  while (pid > 1 && !seen.has(pid)) {
    seen.add(pid);
    const info = processes.get(pid);
    if (!info) return undefined;
    if (basename(info.command) === 'claude' ||
        (/^node(?:js)?$/.test(basename(info.command)) &&
         /^\S+\s+\S*\/node_modules\/@anthropic-ai\/claude-code\/cli\.js(?:\s|$)/.test(info.args))) {
      return { pid: info.pid, startedAt: info.startedAt };
    }
    pid = info.ppid;
  }
  return undefined;
}

async function publish(input) {
  try {
    if (!input) return;
    const data = JSON.parse(input.toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.agent_id) return;
    const patch = {}, session = {};
    for (const [target, source] of [['id', 'session_id'], ['file', 'transcript_path'], ['cwd', 'cwd']]) {
      const value = text(data[source]);
      if (value !== undefined) session[target] = value;
    }
    if (Object.keys(session).length) patch.session = session;
    if (data.model === null) patch.model = null;
    else if (text(data.model?.id)) {
      patch.model = { id: data.model.id };
      const displayName = text(data.model.display_name);
      if (displayName !== undefined) patch.model.displayName = displayName;
    }
    if (!Object.keys(patch).length) return;
    // A missing build must not prevent the existing renderer from running.
    const [{ request }, { parseProcesses, PS_FIELDS }] = await Promise.all([
      import('../../dist/client.js'), import('../../dist/discovery/processes.js'),
    ]);
    const reportedAt = Date.now();
    const identity = await identify(parseProcesses, PS_FIELDS);
    if (!identity) return;
    const directory = resolve(process.env.AGENTS_REGISTRY_DIR ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'agents-registry'));
    await request(directory, {
      version: 1, type: 'publish', harness: 'claude', source: 'claude-statusline',
      process: identity, reportedAt, patch,
    }, 500);
  } catch { /* Best-effort metadata never contaminates status-line output. */ }
}

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--command' || !args[1].trim()) {
  console.error('Usage: statusline-wrapper.mjs --command <existing shell command>');
  process.exit(2);
}

const child = spawn('/bin/bash', ['-c', args[1]], { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
// Node handles nonblocking output pipes and backpressure for native renderers too.
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
const signals = new Map();
const removeSignals = () => {
  for (const [signal, handler] of signals) process.removeListener(signal, handler);
};
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  const handler = () => {
    if (child.pid) {
      try { process.kill(-child.pid, signal); } catch { /* Renderer may have exited. */ }
    }
    removeSignals();
    process.kill(process.pid, signal);
  };
  signals.set(signal, handler);
  process.on(signal, handler);
}
const rendering = new Promise(done => {
  child.on('error', error => {
    console.error(`Status-line renderer failed to start: ${error.message}`);
    done({ code: 1 });
  });
  child.on('close', (code, signal) => done({ code, signal }));
});
const input = new Promise(done => {
  let bytes = 0;
  const chunks = [];
  process.stdin.on('data', chunk => {
    bytes += chunk.length;
    if (bytes <= 8 * 1024 * 1024) chunks.push(chunk);
    else chunks.length = 0;
  });
  process.stdin.on('end', () => done(bytes <= 8 * 1024 * 1024 ? Buffer.concat(chunks) : undefined));
  process.stdin.on('error', () => done(undefined));
  // Continue draining/capturing input even if a renderer exits without consuming it.
  child.stdin.on('error', () => {});
  child.stdin.on('close', () => process.stdin.resume());
  process.stdin.pipe(child.stdin);
});
const [result] = await Promise.all([rendering, input.then(publish)]);
removeSignals();
if (result.signal) process.kill(process.pid, result.signal);
else process.exitCode = result.code ?? 1;
