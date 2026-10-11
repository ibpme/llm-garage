import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export type Runner = (command: string, args: string[]) => Promise<string>;
export const run: Runner = async (command, args) => {
  const { stdout } = await execFileAsync(command, args, {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, LC_ALL: "C" },
  });
  return stdout;
};

export interface ProcessInfo {
  pid: number;
  ppid: number;
  startedAt: string;
  command: string;
  args: string;
}

export const PS_FIELDS = "pid=,ppid=,lstart=,comm=,args=";

export function parseProcesses(output: string): Map<number, ProcessInfo> {
  const processes = new Map<number, ProcessInfo>();
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(\S+)\s*(.*)$/);
    if (!match) continue;
    const [, pid, ppid, startedAt, command, args] = match;
    processes.set(Number(pid), {
      pid: Number(pid), ppid: Number(ppid), startedAt: startedAt.replace(/\s+/g, " "), command, args,
    });
  }
  return processes;
}

export async function listProcesses(runner: Runner = run): Promise<Map<number, ProcessInfo>> {
  return parseProcesses(await runner("ps", ["-axo", PS_FIELDS]));
}

/** Returns undefined when no process has this PID (`ps -p` exits 1 for an unknown PID). */
export async function processInfo(pid: number, runner: Runner = run): Promise<ProcessInfo | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 1) return undefined;
  try { return parseProcesses(await runner("ps", ["-o", PS_FIELDS, "-p", String(pid)])).get(pid); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === 1) return undefined;
    throw error;
  }
}

export interface ProcessIdentity { pid: number; startedAt: string }

/**
 * "alive" only when the PID exists with the recorded start time; "reused" when
 * another process now owns the PID. Callers must never signal a reused PID.
 */
export async function identityState(identity: ProcessIdentity, runner: Runner = run): Promise<"alive" | "gone" | "reused"> {
  const info = await processInfo(identity.pid, runner);
  if (!info) return "gone";
  return info.startedAt === identity.startedAt ? "alive" : "reused";
}

export function isDescendant(pid: number, root: number, processes: Map<number, ProcessInfo>): boolean {
  const seen = new Set<number>();
  while (pid > 0 && !seen.has(pid)) {
    if (pid === root) return true;
    seen.add(pid);
    pid = processes.get(pid)?.ppid ?? 0;
  }
  return false;
}
