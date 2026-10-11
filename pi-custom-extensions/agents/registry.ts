import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { parseProcesses, run, type ProcessInfo, type Runner } from "./tmux.ts";

export const HEARTBEAT_MS = 5_000;
const STALE_MS = 20_000;

export interface AgentStatus {
  pid: number;
  startedAt: string;
  updatedAt: number;
  state: "idle" | "working";
  interactive?: boolean;
  sessionId: string;
  sessionFile?: string;
  name?: string;
  cwd: string;
  model?: string;
}

export function writeStatus(directory: string, status: AgentStatus): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, `${status.pid}.json`);
  const temporary = `${file}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(status), { mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function removeStatus(directory: string, pid: number): void {
  rmSync(join(directory, `${pid}.json`), { force: true });
}

export interface ClaudeModel {
  version: 1;
  sessionId: string;
  updatedAt: number;
  model: string;
  displayName?: string;
}

export function readClaudeModel(
  directory: string, sessionId: string | undefined, info: ProcessInfo, now = Date.now(),
): ClaudeModel | undefined {
  if (!sessionId || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(sessionId)) return undefined;
  try {
    const record: ClaudeModel = JSON.parse(readFileSync(join(directory, "claude", `${sessionId}.json`), "utf8"));
    const startedAt = Date.parse(info.startedAt);
    // Status-line snapshots can go quiet while idle. Reject previous process lifetimes, not age alone.
    if (record.version !== 1 || record.sessionId !== sessionId || !Number.isSafeInteger(record.updatedAt) ||
      !Number.isFinite(startedAt) || record.updatedAt < startedAt || record.updatedAt > now + HEARTBEAT_MS ||
      typeof record.model !== "string" || !record.model.trim() || record.model.length > 512 ||
      (record.displayName !== undefined && (typeof record.displayName !== "string" || record.displayName.length > 256))) return undefined;
    return record;
  } catch { return undefined; }
}

export interface ClaudeEndpoint {
  version: 1;
  sessionId: string;
  capturedAt: number;
  socketPath: string;
}

export function readClaudeEndpoint(
  directory: string, sessionId: string | undefined, info: ProcessInfo, now = Date.now(),
): ClaudeEndpoint | undefined {
  if (!sessionId || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(sessionId)) return undefined;
  try {
    const record: ClaudeEndpoint = JSON.parse(readFileSync(join(directory, "claude", "endpoints", `${sessionId}.json`), "utf8"));
    const startedAt = Date.parse(info.startedAt);
    if (record.version !== 1 || record.sessionId !== sessionId || !Number.isSafeInteger(record.capturedAt) ||
      !Number.isFinite(startedAt) || record.capturedAt < startedAt || record.capturedAt > now + HEARTBEAT_MS ||
      typeof record.socketPath !== "string" || !record.socketPath.startsWith("/") ||
      record.socketPath.length > 4096 || /[\x00-\x1f\x7f]/.test(record.socketPath)) return undefined;
    return record;
  } catch { return undefined; }
}

// For future messaging callers: recheck Claude's session/PID and process lifetime immediately before dialing.
// A successful connection establishes reachability, not permission to send any particular message.
export async function connectClaudeEndpoint(
  directory: string, sessionId: string, expected: ProcessInfo, runner: Runner = run, timeoutMs = 500,
): Promise<Socket | undefined> {
  try {
    const sessions: unknown = JSON.parse(await runner("claude", ["agents", "--json"]));
    if (!Array.isArray(sessions) || !sessions.some((item) => item?.sessionId === sessionId && item.pid === expected.pid)) return undefined;
    const processes = parseProcesses(await runner("ps", ["-axo", "pid=,ppid=,lstart=,comm=,args="]));
    const live = processes.get(expected.pid);
    if (!live || live.startedAt !== expected.startedAt) return undefined;
    const endpoint = readClaudeEndpoint(directory, sessionId, live);
    if (!endpoint) return undefined;
    const file = lstatSync(endpoint.socketPath);
    if (!file.isSocket() || (process.getuid && file.uid !== process.getuid())) return undefined;
    return await new Promise<Socket | undefined>((resolve) => {
      const socket = createConnection(endpoint.socketPath);
      const fail = () => { socket.destroy(); resolve(undefined); };
      socket.setTimeout(Math.max(1, Math.min(timeoutMs, 5_000)), fail);
      socket.once("error", fail);
      socket.once("connect", () => { socket.setTimeout(0); socket.removeListener("error", fail); resolve(socket); });
    });
  } catch { return undefined; }
}

export function readStatus(directory: string, info: ProcessInfo, now = Date.now()): AgentStatus | undefined {
  try {
    const status: AgentStatus = JSON.parse(readFileSync(join(directory, `${info.pid}.json`), "utf8"));
    if (status.pid !== info.pid || status.startedAt !== info.startedAt ||
      typeof status.updatedAt !== "number" || status.updatedAt > now + HEARTBEAT_MS ||
      now - status.updatedAt > STALE_MS ||
      (status.state !== "idle" && status.state !== "working") ||
      (status.interactive !== undefined && typeof status.interactive !== "boolean") ||
      typeof status.sessionId !== "string" || typeof status.cwd !== "string") return undefined;
    return status;
  } catch {
    return undefined;
  }
}
