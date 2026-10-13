import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { validateMessage } from '../dist/protocol.js';
const exec = promisify(execFile);
const publishers = resolve('publishers/claude');
const payload = { session_id: 'session-1', transcript_path: '/repo/session.jsonl', cwd: '/repo' };

async function fixture(t, { ancestor = true, reply = true, root } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'arp-'));
  const bin = join(directory, 'bin');
  await mkdir(bin);
  // ps is the external process-observation boundary; the socket/protocol stay real.
  await writeFile(join(bin, 'ps'), `#!/bin/sh\nprintf '%s\\n' "$$ $PPID Wed Oct 7 10:00:00 2026 ps ps" "$PPID 700 Wed Oct 7 10:00:01 2026 node node publisher.mjs" "700 42 Wed Oct 7 09:59:59 2026 bash bash -c publisher" "42 1 Wed Oct 7 09:00:00 2026 ${root ?? (ancestor ? '/opt/bin/claude claude' : 'node node other.js')}"\n`, { mode: 0o700 });
  const messages = [];
  const sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let input = '';
    socket.on('data', chunk => {
      input += chunk;
      if (!input.includes('\n')) return;
      messages.push(validateMessage(JSON.parse(input.split('\n')[0])));
      if (reply) socket.end('{"ok":true}\n');
    });
  });
  await new Promise(done => server.listen(join(directory, 'registry.sock'), done));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(done => server.close(done));
    await rm(directory, { recursive: true, force: true });
  });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, AGENTS_REGISTRY_DIR: directory };
  async function run(script, input, args = []) {
    return new Promise((done, reject) => {
      const child = spawn(process.execPath, [join(publishers, script), ...args], { env });
      let stdout = '', stderr = '';
      child.stdout.on('data', data => { stdout += data; });
      child.stderr.on('data', data => { stderr += data; });
      child.on('error', reject);
      child.on('close', code => done({ code, stdout, stderr }));
      child.stdin.on('error', () => {});
      child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
    });
  }
  return { directory, messages, run };
}

test('hook publishes activity with the Claude ancestor lifetime, never the hook PID', async t => {
  const { run, messages } = await fixture(t);
  assert.deepEqual(await run('hook.mjs', { ...payload, hook_event_name: 'UserPromptSubmit', prompt: 'secret' }), { code: 0, stdout: '', stderr: '' });
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0].process, { pid: 42, startedAt: 1791363600000 });
  assert.equal(messages[0].source, 'claude-hook');
  assert.equal(messages[0].harness, 'claude');
  assert.deepEqual(messages[0].patch, { session: { id: 'session-1', file: '/repo/session.jsonl', cwd: '/repo' }, activity: { state: 'busy', rawState: 'UserPromptSubmit' } });
});

test('hook maps lifecycle, tool, and permission events without treating subagent completion as idle', async t => {
  const { run, messages } = await fixture(t);
  for (const [event, state, waitingFor] of [
    ['SessionStart', 'idle'], ['PreToolUse', 'busy'], ['PostToolUse', 'busy'],
    ['PostToolUseFailure', 'busy'], ['PermissionRequest', 'waiting', 'permission'],
    ['Stop', 'idle'], ['SessionEnd', 'unknown'],
  ]) {
    await run('hook.mjs', { ...payload, hook_event_name: event });
    assert.deepEqual(messages.at(-1).patch.activity, { state, rawState: event, ...(waitingFor ? { waitingFor } : {}) });
  }
  const count = messages.length;
  await run('hook.mjs', { ...payload, hook_event_name: 'SubagentStop' });
  await run('hook.mjs', { ...payload, hook_event_name: 'Notification', notification_type: 'auth_success' });
  assert.equal(messages.length, count);
  await run('hook.mjs', { ...payload, hook_event_name: 'Notification', notification_type: 'idle_prompt' });
  assert.deepEqual(messages.at(-1).patch.activity, { state: 'waiting', rawState: 'Notification', waitingFor: 'idle_prompt' });
});

test('missing identity, malformed input, and unknown events are silent no-ops', async t => {
  const { run, messages } = await fixture(t, { ancestor: false });
  for (const input of ['not JSON', 'null', { ...payload, hook_event_name: 'Stop' }]) {
    assert.deepEqual(await run('hook.mjs', input), { code: 0, stdout: '', stderr: '' });
  }
  assert.equal(messages.length, 0);
});

test('an unresponsive registry is bounded and does not break the hook', { timeout: 6000 }, async t => {
  const { run } = await fixture(t, { reply: false });
  assert.deepEqual(await run('hook.mjs', { ...payload, hook_event_name: 'Stop' }), { code: 0, stdout: '', stderr: '' });
});

test('installer merges hooks, leaves statusline untouched, and uninstalls without losing later settings', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ari-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const settings = join(directory, 'settings.json');
  const original = { env: { KEEP: 'yes' }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo existing' }] }] }, statusLine: { type: 'command', command: 'cat', padding: 2 } };
  await writeFile(settings, JSON.stringify(original));
  const run = (...args) => exec(process.execPath, [join(publishers, 'install.mjs'), '--settings', settings, ...args]);
  await run();
  const installed = JSON.parse(await readFile(settings, 'utf8'));
  assert.equal(installed.hooks.Stop.length, 2);
  assert.deepEqual(installed.hooks.Stop[0], original.hooks.Stop[0]);
  assert.deepEqual(installed.statusLine, original.statusLine);
  assert.match(installed.hooks.Stop[1].hooks[0].command, /hook\.mjs/);
  assert.equal(installed.hooks.Stop[1].hooks[0].async, undefined);
  await run();
  assert.deepEqual(JSON.parse(await readFile(settings, 'utf8')), installed);
  installed.env.LATER = 'kept';
  installed.hooks.Stop.push({ hooks: [{ type: 'command', command: 'echo later' }] });
  await writeFile(settings, JSON.stringify(installed));
  await run('--uninstall');
  const restored = JSON.parse(await readFile(settings, 'utf8'));
  assert.deepEqual(restored.hooks.Stop, [original.hooks.Stop[0], { hooks: [{ type: 'command', command: 'echo later' }] }]);
  assert.equal(restored.env.LATER, 'kept');
  assert.deepEqual(restored.statusLine, original.statusLine);
  assert.equal(restored.hooks.UserPromptSubmit, undefined);
  await run('--uninstall');
});

test('installer creates missing settings without configuring a statusline', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ari-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const settings = join(directory, 'nested', 'settings.json');
  await exec(process.execPath, [join(publishers, 'install.mjs'), '--settings', settings]);
  const config = JSON.parse(await readFile(settings, 'utf8'));
  assert.ok(config.hooks.PermissionRequest);
  assert.equal(config.statusLine, undefined);
});

test('AskUserQuestion waits for input and unrelated subagent hooks cannot overwrite main activity', async t => {
  const { run, messages } = await fixture(t);
  await run('hook.mjs', { ...payload, hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' });
  assert.deepEqual(messages.at(-1).patch.activity, { state: 'waiting', rawState: 'PreToolUse', waitingFor: 'user_input' });
  await run('hook.mjs', { ...payload, hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion' });
  assert.equal(messages.at(-1).patch.activity.state, 'busy');
  const count = messages.length;
  await run('hook.mjs', { ...payload, hook_event_name: 'Stop', agent_id: 'subagent-1' });
  assert.equal(messages.length, count);
});

test('missing daemon, invalid optional metadata, and oversized input never block Claude', async t => {
  const { run, messages, directory } = await fixture(t);
  await run('hook.mjs', { session_id: 5, transcript_path: 'x'.repeat(4097), cwd: '/repo', hook_event_name: 'Stop', model: 'secret' });
  assert.deepEqual(messages.at(-1).patch, { session: { cwd: '/repo' }, activity: { state: 'idle', rawState: 'Stop' } });
  const count = messages.length;
  assert.deepEqual(await run('hook.mjs', 'x'.repeat(8 * 1024 * 1024 + 1)), { code: 0, stdout: '', stderr: '' });
  assert.equal(messages.length, count);
  await rm(join(directory, 'registry.sock'));
  assert.deepEqual(await run('hook.mjs', { ...payload, hook_event_name: 'Stop' }), { code: 0, stdout: '', stderr: '' });
});

test('npm Claude entrypoints are identified but unrelated Node processes mentioning Claude are not', async t => {
  const { run, messages } = await fixture(t, { root: '/usr/bin/node /usr/bin/node /opt/node_modules/@anthropic-ai/claude-code/cli.js --resume session-1' });
  assert.deepEqual(await run('hook.mjs', { ...payload, hook_event_name: 'Stop' }), { code: 0, stdout: '', stderr: '' });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].process.pid, 42);
  const other = await fixture(t, { root: 'node node other.js /opt/node_modules/@anthropic-ai/claude-code/cli.js' });
  await other.run('hook.mjs', { ...payload, hook_event_name: 'Stop' });
  assert.equal(other.messages.length, 0);
});

test('installer refuses invalid settings and symlinks without changing their contents', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ari-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const settings = join(directory, 'settings.json');
  const run = path => exec(process.execPath, [join(publishers, 'install.mjs'), '--settings', path]);
  const invalid = '{"hooks":{"Stop":"not an array"}}';
  await writeFile(settings, invalid);
  await assert.rejects(run(settings), /must be an array/);
  assert.equal(await readFile(settings, 'utf8'), invalid);
  await writeFile(settings, '{}');
  const { symlink } = await import('node:fs/promises');
  const link = join(directory, 'linked.json');
  await symlink(settings, link);
  await assert.rejects(run(link), /symlink/);
  assert.equal(await readFile(settings, 'utf8'), '{}');
});
