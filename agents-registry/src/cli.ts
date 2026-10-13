#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from './client.js';
import { startDaemon } from './daemon.js';
import { privateDirectory } from './persistence.js';
import { MAX_MESSAGE_BYTES, validateMessage } from './protocol.js';

const usage = `agents-registry <start|status|stop|publish> [options]
  --directory PATH       Runtime directory (or AGENTS_REGISTRY_DIR)
  --background           Explicit detached launch (start only)
  --foreground           Foreground launch, the default (start only)
  --interval MS          Discovery interval, default 5000 (start only)
  --activity-ttl MS      Activity expiry, default 20000 (start only)
  --tmux-socket PATH     Tmux server socket; repeat for multiple servers (start only)

publish reads one versioned publisher message from stdin.
No hooks, Pi extensions, or OS startup configuration are installed.`;
const delay = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms));

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args[0] === 'help') { console.log(usage); return; }
  const command = args.shift();
  if (!command || !['start', 'status', 'stop', 'publish'].includes(command)) throw new Error(usage);
  const stateHome = process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state');
  let directory = resolve(process.env.AGENTS_REGISTRY_DIR ?? join(stateHome, 'agents-registry'));
  let background = false, foreground = false;
  let intervalMs = 5000, activityTtlMs = 20000;
  const tmuxServers: string[] = [];
  while (args.length) {
    const option = args.shift()!;
    if (option === '--background' || option === '--foreground') {
      if (command !== 'start') throw new Error(`${option} is only valid for start`);
      if (option === '--background') background = true; else foreground = true;
      continue;
    }
    if (!['--directory', '--interval', '--activity-ttl', '--tmux-socket'].includes(option)) throw new Error(`Unknown option: ${option}`);
    const value = args.shift();
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${option}`);
    if (option === '--directory') { directory = resolve(value); continue; }
    if (command !== 'start') throw new Error(`${option} is only valid for start`);
    if (option === '--tmux-socket') {
      if (!isAbsolute(value)) throw new Error('--tmux-socket must be an absolute path');
      tmuxServers.push(value); continue;
    }
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 100 || number > 2147483647) throw new Error(`${option} must be an integer between 100 and 2147483647`);
    if (option === '--interval') intervalMs = number; else activityTtlMs = number;
  }
  if (background && foreground) throw new Error('Choose either --background or --foreground');
  if (command === 'status') {
    const response = await request(directory, { version: 1, type: 'status' });
    if (!response.ok || !response.health) throw new Error(response.error ?? 'Registry did not return health');
    console.log(JSON.stringify(response.health, null, 2)); return;
  }
  if (command === 'publish') {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      const buffer = Buffer.from(chunk); bytes += buffer.length;
      if (bytes > MAX_MESSAGE_BYTES) throw new Error('Message exceeds size limit');
      chunks.push(buffer);
    }
    const message = validateMessage(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (message.type !== 'publish') throw new Error('publish requires a publish message');
    const response = await request(directory, message, 10000);
    if (!response.ok) throw new Error(response.error);
    console.log(JSON.stringify(response)); return;
  }
  if (command === 'stop') {
    const response = await request(directory, { version: 1, type: 'stop' }, 10000);
    if (!response.ok) throw new Error(response.error);
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const exists = await lstat(join(directory, 'writer.lock')).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
      if (!exists) { console.log('Registry stopped'); return; }
      await delay(50);
    }
    throw new Error('Stop requested, but writer did not release ownership within 15 seconds');
  }
  if (background) {
    try {
      const response = await request(directory, { version: 1, type: 'status' });
      if (!response.ok) throw new Error(response.error);
      console.log(`Registry already running (PID ${response.health?.pid})`); return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ECONNREFUSED') throw error;
    }
    await privateDirectory(directory);
    const log = openSync(join(directory, 'daemon.log'), 'a', 0o600);
    const childArgs = [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), 'start', '--foreground', '--directory', directory,
      '--interval', String(intervalMs), '--activity-ttl', String(activityTtlMs), ...tmuxServers.flatMap(server => ['--tmux-socket', server])];
    const child = spawn(process.execPath, childArgs, { detached: true, stdio: ['ignore', log, log, 'ipc'] });
    closeSync(log);
    await new Promise<void>((done, reject) => {
      const timeout = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`Registry startup timed out; inspect ${join(directory, 'daemon.log')}`)); }, 20000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Registry startup exited (${code}); inspect ${join(directory, 'daemon.log')}`)); });
      child.once('message', (message: { ready?: boolean; error?: string }) => {
        clearTimeout(timeout);
        if (message.ready) done(); else reject(new Error(message.error ?? 'Registry startup failed'));
      });
    });
    child.unref();
    console.log(`Registry running in background (PID ${child.pid}) at ${directory}`); return;
  }
  const daemon = await startDaemon({ directory, intervalMs, activityTtlMs, tmuxServers });
  const stop = (): void => { void daemon.stop().catch(error => { console.error(error); process.exitCode = 1; }); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  if (process.send) process.send({ ready: true }, () => process.disconnect());
  console.log(`Registry running (PID ${process.pid}) at ${directory}`);
  await daemon.closed;
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
}

main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  if (process.send) process.send({ error: message }, () => process.disconnect());
  process.exitCode = 1;
});
