import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, mkdir, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import test from 'node:test';
import { startDaemon } from '../src/daemon.js';
import { request } from '../src/client.js';
import type { DiscoveryResult, PublishMessage } from '../src/types.js';
const processInfo = { pid: 101, startedAt: 100, ppid: 1, command: 'pi', args: 'pi' };
const discovery = (): DiscoveryResult => ({ observedAt: Date.now(), processes: new Map([[101, processInfo]]), agents: [], errors: [], successfulTmuxServers: [] });
const publish = (): PublishMessage => ({ version: 1, type: 'publish', harness: 'pi', process: { pid: 101, startedAt: processInfo.startedAt }, source: 'pi', reportedAt: Date.now(), patch: { activity: { state: 'busy' }, session: { cwd: '/repo' } } });

async function directory(): Promise<string> { return mkdtemp(join(tmpdir(), 'ar-')); }

test('socket publishes complete private snapshots and stops gracefully', async () => {
  const dir = await directory();
  const daemon = await startDaemon({ directory: dir, intervalMs: 60000, collect: async () => discovery(), verify: async () => processInfo });
  try {
    assert.equal((await request(dir, { version: 1, type: 'status' })).health?.state, 'running');
    assert.equal((await request(dir, publish())).ok, true);
    const contents = await readFile(join(dir, 'agents.jsonl'), 'utf8');
    assert.ok(contents.endsWith('\n'));
    const row = JSON.parse(contents.trim());
    assert.equal(row.activity.state, 'busy');
    assert.equal(row.session.cwd, '/repo');
    assert.equal((await stat(join(dir, 'agents.jsonl'))).mode & 0o777, 0o600);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.equal((await stat(join(dir, 'registry.sock'))).mode & 0o777, 0o600);
    assert.equal((await request(dir, { version: 1, type: 'stop' })).ok, true);
    await daemon.closed;
    assert.equal(JSON.parse(await readFile(join(dir, 'registry-health.json'), 'utf8')).state, 'stopped');
    await assert.rejects(stat(join(dir, 'writer.lock')));
  } finally { await daemon.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('second writer cannot acquire ownership or disturb the first socket', async () => {
  const dir = await directory();
  const options = { directory: dir, intervalMs: 60000, collect: async () => discovery() };
  const daemon = await startDaemon(options);
  try {
    await assert.rejects(startDaemon(options), { code: 'ELOCKED' });
    assert.equal((await request(dir, { version: 1, type: 'status' })).ok, true);
  } finally { await daemon.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('stale lock recovery starts fresh instead of trusting saved rows', async () => {
  const dir = await directory();
  await mkdir(join(dir, 'writer.lock'));
  await utimes(join(dir, 'writer.lock'), new Date(0), new Date(0));
  await writeFile(join(dir, 'agents.jsonl'), '{"pid":999}\n');
  const daemon = await startDaemon({ directory: dir, intervalMs: 60000, collect: async () => discovery() });
  try { assert.equal(await readFile(join(dir, 'agents.jsonl'), 'utf8'), ''); }
  finally { await daemon.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('rejects invalid, oversized and unverified publications without changing the snapshot', async () => {
  const dir = await directory();
  const daemon = await startDaemon({ directory: dir, intervalMs: 60000, collect: async () => discovery(), verify: async () => undefined });
  try {
    assert.equal((await request(dir, publish())).ok, false);
    assert.equal((await request(dir, { ...publish(), reportedAt: Date.now() + 60000 })).ok, false);
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(join(dir, 'registry.sock'));
      let output = '';
      socket.on('error', reject);
      socket.on('data', data => { output += data.toString(); });
      socket.on('end', () => resolve(output));
      socket.on('connect', () => socket.write('x'.repeat(65537)));
    });
    assert.equal(JSON.parse(reply).ok, false);
    assert.equal(await readFile(join(dir, 'agents.jsonl'), 'utf8'), '');
    assert.equal((await request(dir, { version: 1, type: 'status' })).ok, true);
  } finally { await daemon.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('publishing during slow discovery is not overwritten by the older scan', async () => {
  const dir = await directory();
  let release!: (result: DiscoveryResult) => void;
  let started!: () => void;
  const scanStarted = new Promise<void>(resolve => { started = resolve; });
  let scans = 0;
  const daemon = await startDaemon({ directory: dir, intervalMs: 50, verify: async () => processInfo, collect: async () => {
    if (++scans === 1) return discovery();
    started();
    return new Promise<DiscoveryResult>(resolve => { release = resolve; });
  } });
  try {
    await scanStarted;
    const old = discovery();
    old.observedAt -= 1000;
    assert.equal((await request(dir, publish())).ok, true);
    release(old);
    await daemon.reconcile();
    assert.equal(JSON.parse((await readFile(join(dir, 'agents.jsonl'), 'utf8')).trim()).activity.state, 'busy');
  } finally { release?.(discovery()); await daemon.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('bounded-time client reports unavailable daemon', async () => {
  const dir = await directory();
  try { await assert.rejects(request(dir, { version: 1, type: 'status' }, 100)); }
  finally { await rm(dir, { recursive: true, force: true }); }
});

test('concurrent publishers do not lose independently updated fields', async () => {
  const dir = await directory();
  const daemon = await startDaemon({ directory: dir, intervalMs: 60000, collect: async () => discovery(), verify: async () => processInfo });
  try {
    const first = publish();
    const second = { ...publish(), patch: { model: { id: 'sonnet' } } };
    const replies = await Promise.all([request(dir, first), request(dir, second)]);
    assert.ok(replies.every(reply => reply.ok));
    const row = JSON.parse((await readFile(join(dir, 'agents.jsonl'), 'utf8')).trim());
    assert.equal(row.model.id, 'sonnet');
    assert.equal(row.session.cwd, '/repo');
    assert.equal(row.activity.state, 'busy');
  } finally { await daemon.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('unavailable discovery preserves published rows and exposes degraded health', async () => {
  const dir = await directory();
  let failed = false;
  const daemon = await startDaemon({ directory: dir, intervalMs: 60000, collect: async () => {
    if (failed) throw new Error('process collection failed');
    return discovery();
  }, verify: async () => processInfo });
  try {
    await request(dir, publish());
    failed = true;
    await daemon.reconcile();
    const health = (await request(dir, { version: 1, type: 'status' })).health!;
    assert.match(health.errors[0]!, /process collection failed/);
    assert.equal(health.agentCount, 1);
    assert.equal(JSON.parse((await readFile(join(dir, 'agents.jsonl'), 'utf8')).trim()).activity.state, 'busy');
  } finally { await daemon.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('rejects malformed JSON without crashing the writer', async () => {
  const dir = await directory();
  const daemon = await startDaemon({ directory: dir, intervalMs: 60000, collect: async () => discovery() });
  try {
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(join(dir, 'registry.sock'));
      let data = '';
      socket.on('connect', () => socket.write('{not json}\n'));
      socket.on('data', chunk => { data += chunk; });
      socket.on('end', () => resolve(data));
      socket.on('error', reject);
    });
    assert.equal(JSON.parse(reply).ok, false);
    assert.equal((await request(dir, { version: 1, type: 'status' })).ok, true);
  } finally { await daemon.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('numeric process start time rejects publications from before that lifetime', async () => {
  const dir = await directory();
  const daemon = await startDaemon({ directory: dir, intervalMs: 60000, collect: async () => discovery(), verify: async () => processInfo });
  try {
    const response = await request(dir, { ...publish(), reportedAt: 99 });
    assert.equal(response.ok, false);
    assert.match(response.error!, /predates process lifetime/);
    assert.equal(await readFile(join(dir, 'agents.jsonl'), 'utf8'), '');
    assert.equal((await request(dir, publish())).ok, true);
    const row = JSON.parse((await readFile(join(dir, 'agents.jsonl'), 'utf8')).trim());
    assert.equal(row.process.startedAt, 100);
    assert.equal(typeof row.observedAt, 'number');
    assert.equal(typeof row.activity.reportedAt, 'number');
  } finally { await daemon.stop(); await rm(dir, { recursive: true, force: true }); }
});
