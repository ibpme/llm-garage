import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, stat, copyFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { validateMessage } from '../dist/protocol.js';

const exec = promisify(execFile);
const publishers = resolve('publishers/claude');
const rendered = child => new Promise((done, reject) => {
  child.stdout.once('data', done);
  child.once('close', () => reject(new Error('wrapper exited before rendering')));
});
const payload = { session_id: 'session-1', transcript_path: '/repo/session.jsonl', cwd: '/repo',
  model: { id: 'claude-test', display_name: 'Test Model' }, prompt: 'secret', cost: { total_cost_usd: 42 } };

async function fixture(t, { root = '/opt/bin/claude claude', reply = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ars-'));
  const bin = join(directory, 'bin');
  await mkdir(bin);
  // Only process observation is faked; publication uses the real socket client and schema.
  await writeFile(join(bin, 'ps'), `#!/bin/sh\nprintf '%s\\n' "$$ $PPID Wed Oct 7 10:00:00 2026 ps ps" "$PPID 700 Wed Oct 7 10:00:01 2026 node node publisher.mjs" "700 42 Wed Oct 7 09:59:59 2026 bash bash -c publisher" "42 1 Wed Oct 7 09:00:00 2026 ${root}"\n`, { mode: 0o700 });
  const messages = [], sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let input = '';
    socket.on('data', chunk => {
      input += chunk;
      if (!input.includes('\n')) return;
      messages.push(validateMessage(JSON.parse(input.split('\n')[0])));
      if (reply) socket.end(typeof reply === 'string' ? reply : '{"ok":true}\n');
    });
  });
  await new Promise(done => server.listen(join(directory, 'registry.sock'), done));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(done => server.close(done));
    await rm(directory, { recursive: true, force: true });
  });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, AGENTS_REGISTRY_DIR: directory };
  const start = (input, command = 'cat') => {
    const child = spawn(process.execPath, [join(publishers, 'statusline-wrapper.mjs'), '--command', command], { env });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    return child;
  };
  const collect = child => new Promise((done, reject) => {
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', (code, signal) => done({ code, signal, stdout, stderr }));
  });
  return { directory, messages, env, start, collect, run: (input, command) => collect(start(input, command)) };
}

test('statusline publishes normalized session/model with Claude ancestry and preserves original bytes', async t => {
  const { run, messages } = await fixture(t);
  const input = ` ${JSON.stringify(payload)}\n\n`;
  assert.deepEqual(await run(input), { code: 0, signal: null, stdout: input, stderr: '' });
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0].process, { pid: 42, startedAt: 1791363600000 });
  assert.equal(messages[0].source, 'claude-statusline');
  assert.equal(messages[0].harness, 'claude');
  assert.deepEqual(messages[0].patch, { session: { id: 'session-1', file: '/repo/session.jsonl', cwd: '/repo' },
    model: { id: 'claude-test', displayName: 'Test Model' } });
  assert.ok(Number.isSafeInteger(messages[0].reportedAt));
});

test('statusline omits unavailable/invalid fields and only explicit null clears model', async t => {
  const { run, messages } = await fixture(t);
  for (const [data, patch] of [
    [{ cwd: '/repo', session_id: 5, transcript_path: 'x'.repeat(4097), model: { id: '', display_name: 'Invalid' } }, { session: { cwd: '/repo' } }],
    [{ model: { id: 'model', display_name: 5 } }, { model: { id: 'model' } }],
    [{ model: null }, { model: null }],
  ]) {
    await run(JSON.stringify(data));
    assert.ok(messages.length > 0, 'expected metadata publication');
    assert.deepEqual(messages.at(-1).patch, patch);
  }
  const count = messages.length;
  for (const input of ['not JSON', 'null', '[]', '{}', JSON.stringify({ ...payload, agent_id: 'subagent' }), 'x'.repeat(8 * 1024 * 1024 + 1)]) {
    const result = await run(input);
    assert.equal(result.stdout, input);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
  }
  assert.equal(messages.length, count);
});

test('statusline identifies npm Claude but skips unrelated ancestry without affecting rendering', async t => {
  for (const [root, count] of [
    ['/usr/bin/node /usr/bin/node /opt/node_modules/@anthropic-ai/claude-code/cli.js --resume session-1', 1],
    ['node node other.js /opt/node_modules/@anthropic-ai/claude-code/cli.js', 0],
  ]) {
    const { run, messages } = await fixture(t, { root });
    assert.equal((await run(JSON.stringify(payload), "printf 'rendered' ")).stdout, 'rendered');
    assert.equal(messages.length, count);
  }
});

test('registry failures are silent and rendering starts before publication completes', { timeout: 6000 }, async t => {
  const { run, start, collect, directory } = await fixture(t, { reply: false });
  const child = start(JSON.stringify(payload), "printf 'rendered'; printf 'renderer stderr' >&2; exit 7");
  const completion = collect(child);
  await rendered(child);
  // The registry has not answered; the renderer must already have produced output.
  assert.equal(child.exitCode, null);
  assert.deepEqual(await completion, { code: 7, signal: null, stdout: 'rendered', stderr: 'renderer stderr' });
  await rm(join(directory, 'registry.sock'));
  assert.deepEqual(await run(JSON.stringify(payload), 'exit 0'), { code: 0, signal: null, stdout: '', stderr: '' });
});

test('statusline forwards cancellation to the renderer process group', { timeout: 6000 }, async t => {
  const { start, collect, directory } = await fixture(t);
  const marker = join(directory, 'cancelled');
  const child = start('{}', `trap 'printf stopped > "${marker}"; exit 0' TERM; printf ready; while :; do sleep 0.1; done`);
  const completion = collect(child);
  await rendered(child);
  child.kill('SIGTERM');
  assert.equal((await completion).signal, 'SIGTERM');
  for (let i = 0; i < 50; i++) {
    try { assert.equal(await readFile(marker, 'utf8'), 'stopped'); return; } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await new Promise(done => setTimeout(done, 20));
    }
  }
  assert.fail('renderer did not receive cancellation');
});

async function installation(t) {
  const directory = await mkdtemp(join(tmpdir(), 'arsi-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const settings = join(directory, "settings with 'quote.json");
  const run = (...args) => exec(process.execPath, [join(publishers, 'install-statusline.mjs'), '--settings', settings, ...args]);
  return { directory, settings, run };
}

test('opt-in installer wraps renderer idempotently and uninstall preserves later settings', async t => {
  const { settings, run } = await installation(t);
  const original = { hooks: { Stop: [] }, env: { KEEP: 'yes' }, statusLine: { type: 'command', command: "printf \"renderer's output\"", padding: 2 } };
  await writeFile(settings, JSON.stringify(original));
  await run();
  const installed = JSON.parse(await readFile(settings, 'utf8'));
  assert.notEqual(installed.statusLine.command, original.statusLine.command);
  assert.equal(installed.statusLine.padding, 2);
  assert.deepEqual(installed.hooks, original.hooks);
  const rendering = exec('/bin/bash', ['-c', installed.statusLine.command], { env: process.env });
  rendering.child.stdin.end('{}');
  const { stdout } = await rendering;
  assert.equal(stdout, "renderer's output");
  assert.equal((await stat(`${settings}.agents-registry-statusline.json`)).mode & 0o777, 0o600);
  await run();
  assert.deepEqual(JSON.parse(await readFile(settings, 'utf8')), installed);
  installed.statusLine.padding = 4;
  installed.env.LATER = 'kept';
  await writeFile(settings, JSON.stringify(installed));
  await run('--uninstall');
  assert.deepEqual(JSON.parse(await readFile(settings, 'utf8')), { ...original, env: { KEEP: 'yes', LATER: 'kept' }, statusLine: { ...original.statusLine, padding: 4 } });
  await run('--uninstall');
});

test('installer refuses missing renderer, symlinks, and changed commands without overwriting settings', async t => {
  const { settings, directory, run } = await installation(t);
  await assert.rejects(run(), /existing.*status.*line/i);
  for (const content of ['{}', 'null', '{"statusLine":{"type":"command","command":""}}']) {
    await writeFile(settings, content);
    await assert.rejects(run());
    assert.equal(await readFile(settings, 'utf8'), content);
  }
  const content = '{"statusLine":{"type":"command","command":"cat"}}';
  await writeFile(settings, content);
  const link = join(directory, 'linked.json');
  await symlink(settings, link);
  await assert.rejects(exec(process.execPath, [join(publishers, 'install-statusline.mjs'), '--settings', link]), /symlink/);
  assert.equal(await readFile(settings, 'utf8'), content);
  await run();
  const changed = { statusLine: { type: 'command', command: 'echo different' } };
  await writeFile(settings, JSON.stringify(changed));
  await assert.rejects(run(), /changed/i);
  await assert.rejects(run('--uninstall'), /changed/i);
  assert.deepEqual(JSON.parse(await readFile(settings, 'utf8')), changed);
});

test('rejected publications and missing builds preserve renderer output and exit status', async t => {
  const { run, directory, env } = await fixture(t, { reply: '{"ok":false,"error":"rejected"}\n' });
  assert.deepEqual(await run(JSON.stringify(payload), 'cat; exit 9'), {
    code: 9, signal: null, stdout: JSON.stringify(payload), stderr: '',
  });
  const copy = join(directory, 'statusline-wrapper.mjs');
  await copyFile(join(publishers, 'statusline-wrapper.mjs'), copy);
  const rendering = exec(process.execPath, [copy, '--command', 'cat'], { env });
  rendering.child.stdin.end(JSON.stringify(payload));
  const result = await rendering;
  assert.equal(result.stdout, JSON.stringify(payload));
  assert.equal(result.stderr, '');
});

test('installer refuses corrupt recovery state and completes interrupted installs safely', async t => {
  const { settings, run } = await installation(t);
  const original = { statusLine: { type: 'command', command: 'cat', padding: 2 }, keep: true };
  const content = JSON.stringify(original);
  const backup = `${settings}.agents-registry-statusline.json`;
  await writeFile(settings, content);
  for (const invalid of ['null', '{}', '{"version":1,"originalStatusLine":{},"installedCommand":""}']) {
    await writeFile(backup, invalid);
    await assert.rejects(run(), /invalid.*backup/i);
    assert.equal(await readFile(settings, 'utf8'), content);
    assert.equal(await readFile(backup, 'utf8'), invalid);
  }
  await rm(backup);
  await run();
  const installed = JSON.parse(await readFile(settings, 'utf8'));
  // Simulate a crash after writing the backup but before replacing settings.
  await writeFile(settings, content);
  await run();
  assert.deepEqual(JSON.parse(await readFile(settings, 'utf8')), installed);
  // Uninstall also tolerates an interrupted restore without losing later settings.
  await writeFile(settings, JSON.stringify({ ...original, later: true }));
  await run('--uninstall');
  assert.deepEqual(JSON.parse(await readFile(settings, 'utf8')), { ...original, later: true });
});
