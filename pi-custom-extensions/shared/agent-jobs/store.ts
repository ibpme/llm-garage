import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProcessIdentity } from "../process-identity.ts";

// Durable background-job records. Only files in this layout are jobs; any other
// directory under the agent-spawn root is ignored.
//
// <root>/jobs/<id>/
//   job.json        immutable request, written by the launching session
//   task.md         plain task text (no child notice)
//   status.json     execution state; written only by the supervisor, or by
//                   reconciliation once the supervisor is proven gone
//   cancel.request  cancellation request
//   marker.<name>   owner-scoped delivery/acknowledgement/waiting-policy markers
//   child/          agent-spawn JSON job (events.jsonl, stderr.log, pid, exit.status)

export const JOB_VERSION = 1;
export const JOB_STATES = ["starting", "running", "cancelling", "succeeded", "failed", "cancelled", "timed-out", "interrupted"] as const;
export type JobState = typeof JOB_STATES[number];
export type TerminalState = Extract<JobState, "succeeded" | "failed" | "cancelled" | "timed-out" | "interrupted">;
const TERMINAL: ReadonlySet<JobState> = new Set(["succeeded", "failed", "cancelled", "timed-out", "interrupted"]);
export const isTerminal = (state: JobState): state is TerminalState => TERMINAL.has(state);

/** notified: completion notice sent to the owner; delivered: result returned to the owner's model;
 * usage-delivered: usage reported once; acknowledged: owner's user dismissed it in /agents;
 * backgrounded: a foreground wait was released, so the parent no longer waits for it. */
export const MARKERS = ["notified", "delivered", "usage-delivered", "acknowledged", "backgrounded"] as const;
export type Marker = typeof MARKERS[number];

export interface JobOwner {
  sessionId: string;
  sessionFile?: string;
  toolCallId?: string;
  /** Session leaf when the job was launched; notices are only delivered while it is on the active branch. */
  branchAnchor?: string;
}

/** How the launching parent waits: foreground holds its tool call open; background returned a receipt. */
export type WaitPolicy = "foreground" | "background";

/** Verified model capacities, `[provider, model, contextWindow]`, resolved by the parent at launch. */
export type ContextWindowTable = [string, string, number][];

export interface JobRequest {
  version: 1;
  id: string;
  name: string;
  agent: "pi" | "claude";
  model?: string;
  provider?: string;
  thinking?: string;
  effort?: string;
  cwd: string;
  createdAt: number;
  timeoutSeconds: number;
  deadline: number;
  owner: JobOwner;
  launcher: string;
  /** Initial waiting policy; absent in jobs launched before foreground jobs were supervised. */
  mode?: WaitPolicy;
  contextWindows?: ContextWindowTable;
}

export interface LatestCallUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface JobDetails {
  activity: string[];
  preview: string;
  turns: number;
  toolCalls: number;
  durationMs: number;
  model?: string;
  /** Cumulative accounting; displays use latestCallUsage. */
  totalTokens?: number;
  latestCallUsage?: LatestCallUsage;
  /** Verified capacity of the latest call's model; absent when unknown. */
  contextWindow?: number;
  costUsd?: number;
  usagePartial?: boolean;
  exitCode?: number;
}

export interface JobUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  reasoning?: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export interface JobStatus {
  version: 1;
  id: string;
  seq: number;
  state: JobState;
  updatedAt: number;
  acceptedAt?: number;
  finishedAt?: number;
  lastActivityAt?: number;
  supervisor?: ProcessIdentity;
  /** Process-group leader of the launched child. */
  child?: ProcessIdentity;
  /** agent-spawn job directory with events.jsonl, stderr.log, pid and exit.status. */
  childDir?: string;
  details: JobDetails;
  usage?: JobUsage;
  terminalReason?: string;
  resultPath?: string;
  stderrTail?: string;
}

export function defaultRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "agent-spawn");
}

export const JOB_ID = /^job-[0-9a-f]{12}$/;
export const newJobId = (): string => `job-${randomBytes(6).toString("hex")}`;
export const jobsDir = (root: string): string => join(root, "jobs");
export function jobDir(root: string, id: string): string {
  if (!JOB_ID.test(id)) throw new Error(`Invalid job ID: ${id}`);
  return join(jobsDir(root), id);
}

const MAX_RECORD_BYTES = 1024 * 1024;

export async function readBounded(path: string, limit = MAX_RECORD_BYTES): Promise<string | undefined> {
  let file;
  try { file = await open(path, "r"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  try {
    const buffer = Buffer.alloc(Math.min((await file.stat()).size, limit));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally { await file.close(); }
}

export async function readTail(path: string, limit = 4000): Promise<string | undefined> {
  let file;
  try { file = await open(path, "r"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  try {
    const { size } = await file.stat();
    const buffer = Buffer.alloc(Math.min(size, limit));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, Math.max(0, size - limit));
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally { await file.close(); }
}

export async function writeAtomic(path: string, data: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, data, { mode: 0o600 });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const optional = (value: unknown, check: (value: unknown) => boolean) => value === undefined || check(value);
const isCount = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
const isTime = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const isIdentity = (value: unknown) => isObject(value) && Number.isSafeInteger(value.pid) && (value.pid as number) > 1 && isString(value.startedAt);

export function parseRequest(raw: string | undefined, id: string): JobRequest | undefined {
  try {
    const value: unknown = raw === undefined ? undefined : JSON.parse(raw);
    if (!isObject(value) || value.version !== JOB_VERSION || value.id !== id || !isString(value.name) ||
      (value.agent !== "pi" && value.agent !== "claude") || !isString(value.cwd) || !isString(value.launcher) ||
      !isTime(value.createdAt) || !isTime(value.deadline) || !isCount(value.timeoutSeconds) ||
      !isObject(value.owner) || !isString(value.owner.sessionId) ||
      !optional(value.mode, (mode) => mode === "foreground" || mode === "background") ||
      !optional(value.contextWindows, Array.isArray) ||
      !["model", "provider", "thinking", "effort"].every((key) => optional(value[key], isString))) return undefined;
    return value as unknown as JobRequest;
  } catch { return undefined; }
}

export function parseStatus(raw: string | undefined, id: string): JobStatus | undefined {
  try {
    const value: unknown = raw === undefined ? undefined : JSON.parse(raw);
    if (!isObject(value) || value.version !== JOB_VERSION || value.id !== id || !isCount(value.seq) ||
      !JOB_STATES.includes(value.state as JobState) || !isTime(value.updatedAt) || !isObject(value.details) ||
      !Array.isArray(value.details.activity) || !isString(value.details.preview) ||
      !optional(value.supervisor, isIdentity) || !optional(value.child, isIdentity) || !optional(value.childDir, isString) ||
      !optional(value.usage, (usage) => isObject(usage) && isObject(usage.cost))) return undefined;
    return value as unknown as JobStatus;
  } catch { return undefined; }
}

export async function readRequest(root: string, id: string): Promise<JobRequest | undefined> {
  return parseRequest(await readBounded(join(jobDir(root, id), "job.json")), id);
}

export async function readStatus(root: string, id: string): Promise<JobStatus | undefined> {
  return parseStatus(await readBounded(join(jobDir(root, id), "status.json")), id);
}

/**
 * Writes a new status unless the stored one is already terminal: terminal
 * results are immutable and later writers (duplicate finalization, late
 * reconciliation) lose. Returns the status that is now stored.
 */
export async function writeStatus(root: string, status: JobStatus): Promise<JobStatus> {
  const current = await readStatus(root, status.id);
  if (current && isTerminal(current.state)) return current;
  const next = { ...status, seq: Math.max(status.seq, (current?.seq ?? 0) + 1) };
  await writeAtomic(join(jobDir(root, status.id), "status.json"), JSON.stringify(next));
  return next;
}

export async function listJobIds(root: string): Promise<string[]> {
  try {
    const entries = await readdir(jobsDir(root), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() && JOB_ID.test(entry.name)).map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function ensurePrivateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Not a private directory: ${path}`);
  if (process.getuid && info.uid !== process.getuid()) throw new Error(`Job directory is owned by another user: ${path}`);
}

/** Atomically claims a marker; returns false when it already existed. */
export async function claimMarker(root: string, id: string, marker: Marker): Promise<boolean> {
  try {
    await writeFile(join(jobDir(root, id), `marker.${marker}`), `${Date.now()}\n`, { flag: "wx", mode: 0o600 });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

export async function readMarkers(root: string, id: string): Promise<Set<Marker>> {
  const present = new Set<Marker>();
  for (const name of await readdir(jobDir(root, id)).catch(() => [] as string[])) {
    const marker = name.startsWith("marker.") ? name.slice(7) as Marker : undefined;
    if (marker && MARKERS.includes(marker)) present.add(marker);
  }
  return present;
}

export async function hasCancelRequest(root: string, id: string): Promise<boolean> {
  return (await readBounded(join(jobDir(root, id), "cancel.request"), 64)) !== undefined;
}

export async function requestCancel(root: string, id: string): Promise<void> {
  await writeFile(join(jobDir(root, id), "cancel.request"), `${Date.now()}\n`, { mode: 0o600 });
}
