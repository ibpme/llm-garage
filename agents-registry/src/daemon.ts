import { chmod, lstat, unlink } from 'node:fs/promises';
import { createConnection, createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { discover } from './discovery/index.js';
import { listProcesses } from './discovery/processes.js';
import { AgentStore } from './store.js';
import { MAX_MESSAGE_BYTES, validateMessage } from './protocol.js';
import { persist, privateDirectory } from './persistence.js';
import type { DiscoveryResult, Health, ProcessInfo, Response } from './types.js';

export interface DaemonOptions { directory: string; intervalMs?: number; tmuxServers?: string[]; activityTtlMs?: number; collect?: () => Promise<DiscoveryResult>; verify?: (pid: number) => Promise<ProcessInfo | undefined> }
export interface Daemon { closed: Promise<void>; stop(): Promise<void>; reconcile(): Promise<void> }
const errorText = (error: unknown): string => String(error).slice(0, 2048);

async function clearStaleSocket(path: string): Promise<void> {
  const info = await lstat(path).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (!info) return;
  if (!info.isSocket() || (process.getuid && info.uid !== process.getuid())) throw new Error('Refusing to remove an unowned or non-socket registry path');
  const alive = await new Promise<boolean>((resolve, reject) => {
    const socket = createConnection(path);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Existing socket probe timed out')); }, 500);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.once('error', error => {
      clearTimeout(timer); socket.destroy();
      if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED' || (error as NodeJS.ErrnoException).code === 'ENOENT') resolve(false);
      else reject(error);
    });
  });
  if (alive) throw new Error('A registry socket is already running');
  await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
}

export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  const directory = options.directory;
  const socketPath = join(directory, 'registry.sock');
  if (Buffer.byteLength(socketPath) > 100) throw new Error('Registry socket path is too long; choose a shorter --directory');
  await privateDirectory(directory);
  const release = await lockfile.lock(join(directory, 'agents.jsonl'), {
    realpath: false, lockfilePath: join(directory, 'writer.lock'), stale: 30000, update: 10000, retries: 0,
    onCompromised: error => { console.error(`Registry ownership compromised: ${error.message}`); process.exit(1); },
  });
  const store = new AgentStore({ activityTtlMs: options.activityTtlMs });
  const health: Health = { version: 1, pid: process.pid, state: 'starting', startedAt: Date.now(), updatedAt: Date.now(), agentCount: 0, errors: [] };
  const collect = options.collect ?? (() => discover({ tmuxServers: options.tmuxServers ?? [] }));
  const verify = options.verify ?? (async pid => (await listProcesses()).get(pid));
  let stopping = false;
  let stopped: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let scan: Promise<void> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let pending = 0;
  let resolveClosed!: () => void;
  const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
  const sockets = new Set<Socket>();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    if (pending >= 128) return Promise.reject(new Error('Registry update queue is full'));
    pending++;
    const task = queue.then(work);
    queue = task.catch(() => {}).finally(() => { pending--; });
    return task;
  };
  const save = async (): Promise<void> => {
    const rows = store.snapshot(Date.now());
    health.updatedAt = Date.now(); health.agentCount = rows.length;
    await persist(directory, rows, health);
  };
  const reconcile = (): Promise<void> => {
    if (scan) return scan;
    if (stopping) return Promise.resolve();
    scan = (async () => {
      let result: DiscoveryResult;
      try { result = await collect(); }
      catch (error) { result = { observedAt: Date.now(), agents: [], errors: [errorText(error)], successfulTmuxServers: [] }; }
      await serial(async () => {
        store.reconcile(result);
        health.lastDiscoveryAt = Date.now();
        if (result.processes) health.lastSuccessfulProcessDiscoveryAt = result.observedAt;
        health.errors = result.errors.map(errorText);
        await save();
      });
    })().finally(() => { scan = undefined; });
    return scan;
  };
  const server = createServer(socket => {
    if (stopping || sockets.size >= 128) { socket.destroy(); return; }
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setTimeout(10000, () => socket.destroy());
    let input = Buffer.alloc(0);
    let handled = false;
    const respond = (response: Response): void => { if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`); };
    socket.on('data', (chunk: Buffer) => {
      if (handled) return;
      input = Buffer.concat([input, chunk]);
      if (input.length > MAX_MESSAGE_BYTES) { handled = true; respond({ ok: false, error: 'Message exceeds size limit' }); return; }
      const newline = input.indexOf(10);
      if (newline < 0) return;
      handled = true;
      void serial(async () => {
        const message = validateMessage(JSON.parse(input.subarray(0, newline).toString('utf8')));
        if (stopping) throw new Error('Registry is stopping');
        if (message.type === 'status') return { ok: true, health: structuredClone(health) };
        if (message.type === 'stop') {
          socket.once('finish', () => { void stop().catch(error => console.error(errorText(error))); });
          return { ok: true };
        }
        const live = await verify(message.process.pid);
        const receivedAt = Date.now();
        if (message.reportedAt > receivedAt + 5000) throw new Error('Publisher timestamp is in the future');
        if (message.reportedAt < message.process.startedAt) throw new Error('Publisher timestamp predates process lifetime');
        store.publish(message, live, receivedAt);
        await save();
        return { ok: true };
      }).then(respond, error => respond({ ok: false, error: errorText(error) }));
    });
  });
  const stop = (): Promise<void> => {
    if (stopped) return stopped;
    stopping = true;
    if (timer) clearInterval(timer);
    stopped = (async () => {
      await scan?.catch(() => {});
      await queue;
      try {
        health.state = 'stopped'; await save();
      } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>(resolve => { if (server.listening) server.close(() => resolve()); else resolve(); });
        await release(); resolveClosed();
      }
    })();
    return stopped;
  };
  try {
    await clearStaleSocket(socketPath);
    await reconcile();
    health.state = 'running'; await save();
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error): void => reject(error);
      server.once('error', failed);
      server.listen(socketPath, () => { server.removeListener('error', failed); resolve(); });
    });
    await chmod(socketPath, 0o600);
    server.on('error', error => { console.error(errorText(error)); void stop(); });
    timer = setInterval(() => { void reconcile().catch(error => console.error(`Registry reconciliation failed: ${errorText(error)}`)); }, options.intervalMs ?? 5000);
    return { closed, stop, reconcile };
  } catch (error) {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await release();
    throw error;
  }
}
