import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProcessInfo, Runner } from '../types.js';

const execute = promisify(execFile);
export const run: Runner = async (command, args) => (await execute(command, args, {
  encoding: 'utf8', timeout: 5000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C', ...(command === 'ps' ? { TZ: 'UTC' } : {}) },
})).stdout;
export const PS_FIELDS = 'pid=,ppid=,lstart=,comm=,args=';

export function parseProcesses(output: string): Map<number, ProcessInfo> {
  const processes = new Map<number, ProcessInfo>();
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(\S+)\s*(.*)$/.exec(line);
    if (!match) throw new Error('Invalid process snapshot');
    const [, pid, ppid, startText, command, args] = match;
    // ps lstart has no offset; collection uses TZ=UTC, independent of the caller's timezone.
    const startedAt = Date.parse(`${startText!.replace(/\s+/g, ' ')} UTC`);
    if (!Number.isSafeInteger(startedAt) || startedAt < 0) throw new Error('Invalid process start time');
    processes.set(Number(pid), { pid: Number(pid), ppid: Number(ppid), startedAt, command: command!, args: args! });
  }
  if (!processes.size) throw new Error('Empty process snapshot');
  return processes;
}
export async function listProcesses(runner: Runner = run): Promise<Map<number, ProcessInfo>> {
  return parseProcesses(await runner('ps', ['-axo', PS_FIELDS]));
}
export function ancestryDistance(pid: number, root: number, processes: Map<number, ProcessInfo>): number | undefined {
  const seen = new Set<number>();
  let distance = 0;
  while (pid > 0 && !seen.has(pid)) {
    if (pid === root) return distance;
    seen.add(pid); pid = processes.get(pid)?.ppid ?? 0; distance++;
  }
  return undefined;
}
