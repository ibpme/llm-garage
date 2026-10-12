import { execFile, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { identityState, listProcesses, run, type ProcessInfo, type Runner } from "../process-identity.ts";
import {
  claimMarker, defaultRoot, ensurePrivateDir, isTerminal, jobDir, jobsDir, JOB_ID, listJobIds, newJobId,
  readMarkers, readRequest, readStatus, readTail, requestCancel, writeAtomic, writeStatus,
  type ContextWindowTable, type JobOwner, type JobRequest, type JobStatus, type Marker, type TerminalState, type WaitPolicy,
} from "./store.ts";

export const MAX_ACTIVE_PER_OWNER = 4;
export const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
export const RETAINED_PER_OWNER = 200;

export interface StartRequest {
  name: string;
  task: string;
  agent: "pi" | "claude";
  model?: string;
  provider?: string;
  thinking?: string;
  effort?: string;
  cwd: string;
  timeoutSeconds: number;
  owner: JobOwner;
  launcher: string;
  mode?: WaitPolicy;
  contextWindows?: ContextWindowTable;
}

/**
 * live: the supervisor is verified running. unknown: the supervisor is gone but
 * the child process group leader still runs, so nothing records its result.
 * ended: terminal state recorded.
 */
export type Liveness = "live" | "unknown" | "ended";

export interface JobSnapshot {
  id: string;
  dir: string;
  request: JobRequest;
  status: JobStatus;
  markers: ReadonlySet<Marker>;
  liveness: Liveness;
  /** Durable waiting policy. Whether a foreground wait is still attached is known only to the launching runtime. */
  waitPolicy: WaitPolicy;
}

export const waitPolicy = (request: JobRequest, markers: ReadonlySet<Marker>): WaitPolicy =>
  request.mode === "foreground" && !markers.has("backgrounded") ? "foreground" : "background";

export interface JobQuery {
  owner?: string;
  /** Only jobs that are not terminal. */
  active?: boolean;
  limit?: number;
}

export type CancelOutcome = "cancelled" | "requested" | "already-terminal" | "not-found" | "not-owner";

export interface AgentJobsOptions {
  root?: string;
  /** Supervisor entry point; required only for start(). */
  supervisor?: string;
  /** Node executable for the supervisor (default: this Node, or `node` on PATH under Bun). */
  node?: string;
  runner?: Runner;
  now?: () => number;
  ackTimeoutMs?: number;
  /** A job without any status this long after creation never got a supervisor. */
  orphanAfterMs?: number;
}

const execText = (file: string, args: string[]) => new Promise<string>((resolve, reject) =>
  execFile(file, args, { timeout: 10_000, encoding: "utf8" }, (error, stdout, stderr) =>
    error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout)));

const nodeChecks = new Map<string, Promise<void>>();

/** The supervisor runs TypeScript directly, which needs Node's default type stripping. */
export function checkNode(node: string): Promise<void> {
  let check = nodeChecks.get(node);
  if (!check) {
    check = execText(node, ["-p", "`${process.version} ${process.features.typescript ?? false}`"]).then((output) => {
      const [version, mode] = output.trim().split(" ");
      if (mode !== "strip" && mode !== "transform")
        throw new Error(`Background subagents need Node.js with TypeScript type stripping enabled by default (22.18+ or 23.6+); ${node} is ${version ?? "unknown"}`);
    });
    check.catch(() => nodeChecks.delete(node));
    nodeChecks.set(node, check);
  }
  return check;
}

export class AgentJobs {
  readonly root: string;
  private readonly options: AgentJobsOptions;
  private readonly runner: Runner;
  private readonly now: () => number;
  private readonly requests = new Map<string, JobRequest>();
  private readonly terminal = new Map<string, JobStatus>();

  constructor(options: AgentJobsOptions = {}) {
    this.options = options;
    this.root = options.root ?? defaultRoot();
    this.runner = options.runner ?? run;
    this.now = options.now ?? Date.now;
  }

  async start(input: StartRequest, signal?: AbortSignal): Promise<JobSnapshot> {
    const supervisor = this.options.supervisor;
    if (!supervisor) throw new Error("No job supervisor configured");
    const node = this.options.node ?? (process.versions.bun ? "node" : process.execPath);
    await checkNode(node);
    signal?.throwIfAborted();
    await ensurePrivateDir(this.root);
    await ensurePrivateDir(jobsDir(this.root));
    const id = newJobId();
    const dir = jobDir(this.root, id);
    await mkdir(dir, { mode: 0o700 });
    const createdAt = this.now();
    const request: JobRequest = {
      version: 1, id, name: input.name, agent: input.agent, model: input.model, provider: input.provider,
      thinking: input.thinking, effort: input.effort, cwd: input.cwd, createdAt,
      timeoutSeconds: input.timeoutSeconds, deadline: createdAt + input.timeoutSeconds * 1000,
      owner: input.owner, launcher: input.launcher, mode: input.mode, contextWindows: input.contextWindows,
    };
    await writeFile(join(dir, "task.md"), input.task, { mode: 0o600 });
    await writeAtomic(join(dir, "job.json"), JSON.stringify(request));

    const log = openSync(join(dir, "supervisor.log"), "a", 0o600);
    let exited = false;
    try {
      // A new session without a terminal: the supervisor outlives Pi, its terminal and its process group.
      const child = spawn(node, [supervisor, this.root, id], { cwd: dir, detached: true, stdio: ["ignore", log, log] });
      await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      child.once("exit", () => { exited = true; });
      child.unref();
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw new Error(`Could not start job supervisor: ${error instanceof Error ? error.message : String(error)}`);
    } finally { closeSync(log); }

    // Acknowledgement means the child published its PID. A cancelled launch is
    // still followed to a terminal state so no untracked child is left behind.
    const ackDeadline = Date.now() + (this.options.ackTimeoutMs ?? 25_000);
    let cancelled = false;
    while (true) {
      if (!cancelled && (signal?.aborted || Date.now() > ackDeadline)) {
        cancelled = true;
        await requestCancel(this.root, id);
      }
      // Sampled before reading: a supervisor writes its final status before exiting.
      const supervisorGone = exited;
      const snapshot = await this.inspect(id);
      const state = snapshot?.status.state;
      if (snapshot && state && isTerminal(state)) {
        if (cancelled && signal?.aborted) throw new Error("Background subagent launch was cancelled");
        throw new Error(`Background subagent failed to start (${state}): ${snapshot.status.terminalReason ?? "no reason recorded"}` +
          (snapshot.status.stderrTail ? `\n\n${snapshot.status.stderrTail}` : "") + `\n\n[Job files: ${dir}]`);
      }
      if (!cancelled && (state === "running" || state === "cancelling")) return snapshot!;
      if (supervisorGone && (!state || state === "starting")) {
        // The supervisor died before launching anything it could record.
        await writeStatus(this.root, this.terminalStatus(snapshot?.status ?? {
          version: 1, id, seq: 0, state: "starting", updatedAt: createdAt,
          details: { activity: [], preview: "", turns: 0, toolCalls: 0, durationMs: 0 },
        }, "failed", "Supervisor exited during launch"));
        const log = (await readTail(join(dir, "supervisor.log")).catch(() => undefined))?.trim();
        throw new Error(`Background subagent supervisor exited during launch${log ? `:\n${log}` : ""}\n\n[Job files: ${dir}]`);
      }
      if (cancelled && Date.now() > ackDeadline + 20_000) {
        throw new Error(`Background subagent launch did not settle; job files: ${dir}`);
      }
      await sleep(100);
    }
  }

  async inspect(id: string, processes?: Map<number, ProcessInfo>): Promise<JobSnapshot | undefined> {
    if (!JOB_ID.test(id)) return undefined;
    const request = this.requests.get(id) ?? await readRequest(this.root, id);
    if (!request) return undefined;
    this.requests.set(id, request);
    const status = this.terminal.get(id) ?? await readStatus(this.root, id);
    const reconciled = await this.reconcile(request, status, processes);
    if (isTerminal(reconciled.status.state)) this.terminal.set(id, reconciled.status);
    const markers = await readMarkers(this.root, id);
    return { id, dir: jobDir(this.root, id), request, ...reconciled, markers, waitPolicy: waitPolicy(request, markers) };
  }

  /** Newest first. Lazily prunes old delivered/acknowledged terminal jobs. */
  async list(query: JobQuery = {}): Promise<JobSnapshot[]> {
    const ids = await listJobIds(this.root);
    let processes: Map<number, ProcessInfo> | undefined;
    const snapshots: JobSnapshot[] = [];
    for (const id of ids) {
      const request = this.requests.get(id) ?? await readRequest(this.root, id);
      if (!request) continue;
      this.requests.set(id, request);
      if (query.owner !== undefined && request.owner.sessionId !== query.owner) continue;
      if (query.active && this.terminal.has(id)) continue;
      if (!this.terminal.has(id)) processes ??= await listProcesses(this.runner).catch(() => undefined);
      const snapshot = await this.inspect(id, processes);
      if (snapshot && !(query.active && isTerminal(snapshot.status.state))) snapshots.push(snapshot);
    }
    snapshots.sort((a, b) => b.request.createdAt - a.request.createdAt);
    const kept = await this.prune(snapshots);
    return query.limit ? kept.slice(0, query.limit) : kept;
  }

  async cancel(id: string, owner: string): Promise<{ outcome: CancelOutcome; job?: JobSnapshot }> {
    const job = await this.inspect(id);
    if (!job) return { outcome: "not-found" };
    if (job.request.owner.sessionId !== owner) return { outcome: "not-owner", job };
    if (isTerminal(job.status.state)) return { outcome: "already-terminal", job };
    await requestCancel(this.root, id);
    if (job.liveness === "unknown") {
      await this.stopChild(job.status);
      const status = await writeStatus(this.root, this.terminalStatus(job.status, "cancelled", "Cancelled after its supervisor exited"));
      this.terminal.set(id, status);
      return { outcome: "cancelled", job: { ...job, status, liveness: "ended" } };
    }
    for (let i = 0; i < 50; i++) {
      const current = await this.inspect(id);
      if (current && isTerminal(current.status.state)) return { outcome: "cancelled", job: current };
      await sleep(100);
    }
    return { outcome: "requested", job: await this.inspect(id) };
  }

  /** Waits until every job is terminal, the timeout passes, or the signal aborts (which never cancels jobs). */
  async wait(ids: string[], timeoutMs: number, signal?: AbortSignal): Promise<JobSnapshot[]> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const jobs = (await Promise.all(ids.map((id) => this.inspect(id)))).filter((job): job is JobSnapshot => !!job);
      if (jobs.every((job) => isTerminal(job.status.state)) || Date.now() >= deadline || signal?.aborted) return jobs;
      await sleep(Math.min(250, Math.max(0, deadline - Date.now())), undefined, { signal }).catch(() => {});
    }
  }

  async mark(id: string, marker: Marker): Promise<boolean> {
    return claimMarker(this.root, id, marker);
  }

  /** Polls durable state; the listener runs whenever the matching jobs change. */
  subscribe(query: JobQuery, listener: (jobs: JobSnapshot[]) => void, intervalMs = 1_000): () => void {
    let disposed = false;
    let previous = "";
    const poll = async () => {
      while (!disposed) {
        try {
          const jobs = await this.list(query);
          const signature = jobs.map((job) => `${job.id}:${job.status.seq}:${job.status.state}:${job.liveness}:${[...job.markers].sort()}`).join("|");
          if (!disposed && signature !== previous) { previous = signature; listener(jobs); }
        } catch { /* Transient filesystem/process errors; the next poll retries. */ }
        await sleep(intervalMs, undefined, { ref: false });
      }
    };
    void poll();
    return () => { disposed = true; };
  }

  private terminalStatus(status: JobStatus, state: TerminalState, reason: string): JobStatus {
    return { ...status, state, terminalReason: reason, finishedAt: this.now(), updatedAt: this.now() };
  }

  private async reconcile(request: JobRequest, status: JobStatus | undefined, processes?: Map<number, ProcessInfo>):
    Promise<{ status: JobStatus; liveness: Liveness }> {
    if (status && isTerminal(status.state)) return { status, liveness: "ended" };
    const identity = async (pid: number, startedAt: string) => processes
      ? (processes.get(pid) ? processes.get(pid)!.startedAt === startedAt ? "alive" : "reused" : "gone")
      : identityState({ pid, startedAt }, this.runner);
    const base: JobStatus = status ?? {
      version: 1, id: request.id, seq: 0, state: "starting", updatedAt: request.createdAt,
      details: { activity: [], preview: "", turns: 0, toolCalls: 0, durationMs: 0 },
    };
    try {
      if (!status?.supervisor) {
        if (this.now() - request.createdAt < (this.options.orphanAfterMs ?? 60_000)) return { status: base, liveness: "live" };
      } else if (await identity(status.supervisor.pid, status.supervisor.startedAt) === "alive") {
        return { status: base, liveness: "live" };
      }
      if (status?.child && await identity(status.child.pid, status.child.startedAt) === "alive") return { status: base, liveness: "unknown" };
    } catch {
      // Process inspection failed: report what is recorded rather than inventing an outcome.
      return { status: base, liveness: "unknown" };
    }
    const stderrTail = status?.childDir ? (await readTail(join(status.childDir, "stderr.log")).catch(() => undefined))?.trim() : undefined;
    const reason = status?.supervisor ? "Supervisor exited before recording a result" : "Supervisor never started";
    const final = await writeStatus(this.root, { ...this.terminalStatus(base, "interrupted", reason), stderrTail: stderrTail || undefined });
    return { status: final, liveness: "ended" };
  }

  private async stopChild(status: JobStatus): Promise<void> {
    const child = status.child;
    // Never signal a PID that another process now owns.
    if (!child || await identityState(child, this.runner) === "reused") return;
    const kill = (signal: NodeJS.Signals) => {
      try { process.kill(-child.pid, signal); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    };
    kill("SIGTERM");
    await sleep(500);
    kill("SIGKILL");
  }

  private async prune(snapshots: JobSnapshot[]): Promise<JobSnapshot[]> {
    const removable = (job: JobSnapshot) => isTerminal(job.status.state) &&
      (job.markers.has("delivered") || job.markers.has("acknowledged"));
    const doomed = new Set<string>();
    const perOwner = new Map<string, number>();
    for (const job of snapshots) {
      if (!isTerminal(job.status.state)) continue;
      const count = (perOwner.get(job.request.owner.sessionId) ?? 0) + 1;
      perOwner.set(job.request.owner.sessionId, count);
      const finished = job.status.finishedAt ?? job.request.createdAt;
      if (removable(job) && (this.now() - finished > RETENTION_MS || count > RETAINED_PER_OWNER)) doomed.add(job.id);
    }
    for (const id of doomed) {
      await rm(jobDir(this.root, id), { recursive: true, force: true }).catch(() => {});
      this.requests.delete(id);
      this.terminal.delete(id);
    }
    return snapshots.filter((job) => !doomed.has(job.id));
  }
}
