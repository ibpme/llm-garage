import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { listProcesses } from '../src/discovery/processes.js';
const exec = promisify(execFile);
const cli = resolve('dist/cli.js');

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'arc-'));
  const bin = join(directory, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'claude'), '#!/bin/sh\nprintf "[]\\n"\n', { mode: 0o700 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  const run = (...args: string[]) => exec(process.execPath, [cli, ...args, '--directory', directory], { env, timeout: 20000 });
  return { directory, env, run };
}

test('compiled CLI launches detached, publishes via stdin, reports status and stops', { timeout: 30000 }, async () => {
  const { directory, env, run } = await setup();
  try {
    const initial = await run('start', '--background', '--interval', '1000');
    assert.match(initial.stdout, /running/i);
    const health = JSON.parse((await run('status')).stdout);
    assert.equal(health.state, 'running');
    assert.notEqual(health.pid, process.pid);
    assert.match((await run('start', '--background')).stdout, /already running/i);
    const info = (await listProcesses()).get(process.pid)!;
    const payload = { version: 1, type: 'publish', harness: 'pi', source: 'pi', process: { pid: info.pid, startedAt: info.startedAt }, reportedAt: Date.now(), patch: { activity: { state: 'idle' }, session: { name: 'Integration', cwd: '/repo' } } };
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
      const child = spawn(process.execPath, [cli, 'publish', '--directory', directory], { env });
      let stdout = '', stderr = '';
      child.stdout.on('data', data => { stdout += data; });
      child.stderr.on('data', data => { stderr += data; });
      child.on('error', reject);
      child.on('exit', code => done({ code, stdout, stderr }));
      child.stdin.end(JSON.stringify(payload));
    });
    assert.equal(result.code, 0, result.stderr);
    const rows = (await readFile(join(directory, 'agents.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(rows.find(row => row.process.pid === process.pid).session.name, 'Integration');
    assert.equal(rows.find(row => row.process.pid === process.pid).activity.state, 'idle');
    await run('stop');
    await assert.rejects(run('status'));
    assert.equal(JSON.parse(await readFile(join(directory, 'registry-health.json'), 'utf8')).state, 'stopped');
  } finally { await run('stop').catch(() => {}); await rm(directory, { recursive: true, force: true }); }
});

test('CLI rejects invalid arguments without launching a daemon', async () => {
  const { directory, run } = await setup();
  try {
    for (const args of [['start', '--interval', '0'], ['start', '--unknown'], ['bogus'], ['status', '--background']]) {
      await assert.rejects(run(...args));
    }
  } finally { await run('stop').catch(() => {}); await rm(directory, { recursive: true, force: true }); }
});

test('a killed writer is replaced after its lease expires and stale socket is removed', { timeout: 30000 }, async () => {
  const { directory, run } = await setup();
  try {
    await run('start', '--background');
    const health = JSON.parse((await run('status')).stdout);
    process.kill(health.pid, 'SIGKILL');
    // Wait until the old socket refuses connections before expiring the test lease.
    for (let i = 0; i < 100; i++) {
      try { await run('status'); } catch { break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await utimes(join(directory, 'writer.lock'), new Date(0), new Date(0));
    await run('start', '--background');
    const replacement = JSON.parse((await run('status')).stdout);
    assert.notEqual(replacement.pid, health.pid);
    assert.equal(replacement.state, 'running');
    await run('stop');
  } finally { await run('stop').catch(() => {}); await rm(directory, { recursive: true, force: true }); }
});
