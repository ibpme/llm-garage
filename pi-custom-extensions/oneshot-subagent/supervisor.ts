// Detached per-job supervisor: `node supervisor.ts <root> <job-id>`.
// Runs outside Pi, so this file and everything it imports must not load Pi
// packages at runtime (enforced by check:architecture).
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { processInfo } from "../shared/process-identity.ts";
import {
  hasCancelRequest, jobDir, readRequest, readTail, writeStatus,
  type JobDetails, type JobState, type JobStatus,
} from "../shared/agent-jobs/store.ts";
import type { Effort } from "./backend.ts";
import { contextWindowLookup } from "./context-usage.ts";
import type { RunDetails } from "./events.ts";
import { runSubagent } from "./runner.ts";

const snapshot = (details: RunDetails): JobDetails => ({
  activity: details.activity.slice(-80), preview: details.preview.slice(-2000), turns: details.turns,
  toolCalls: details.toolCalls, durationMs: details.durationMs, model: details.model,
  totalTokens: details.totalTokens, latestCallUsage: details.latestCallUsage, contextWindow: details.contextWindow,
  costUsd: details.costUsd, usagePartial: details.usagePartial, exitCode: details.exitCode,
});

async function supervise(root: string, id: string): Promise<void> {
  const dir = jobDir(root, id);
  const request = await readRequest(root, id);
  if (!request) throw new Error(`Invalid or missing job request: ${dir}`);
  const self = await processInfo(process.pid);
  let status: JobStatus = {
    version: 1, id, seq: 0, state: "starting", updatedAt: Date.now(),
    supervisor: self && { pid: self.pid, startedAt: self.startedAt },
    details: { activity: [], preview: "", turns: 0, toolCalls: 0, durationMs: 0 },
  };
  // Serialize writes so snapshots land in order and never after the terminal one.
  let writes = Promise.resolve();
  const update = (patch: Partial<JobStatus>) => {
    status = { ...status, ...patch, updatedAt: Date.now() };
    const next = status;
    writes = writes.then(async () => { status.seq = (await writeStatus(root, next)).seq; });
    return writes;
  };
  await update({});

  const controller = new AbortController();
  let interrupted: string | undefined;
  const interrupt = (signal: NodeJS.Signals) => { interrupted ??= `Supervisor received ${signal}`; controller.abort(); };
  process.on("SIGTERM", interrupt);
  process.on("SIGINT", interrupt);
  // Detached without a terminal; never let a stray hangup end supervision.
  process.on("SIGHUP", () => {});
  const watch = (async () => {
    while (!controller.signal.aborted) {
      if (await hasCancelRequest(root, id).catch(() => false)) {
        await update({ state: "cancelling" });
        controller.abort();
        return;
      }
      await sleep(250, undefined, { signal: controller.signal }).catch(() => {});
    }
  })();

  let lastWrite = 0;
  let lastActivity = "";
  const childDir = join(dir, "child");
  await mkdir(childDir, { recursive: true, mode: 0o700 });
  const outcome = await runSubagent({
    launcher: request.launcher, agent: request.agent, name: request.name,
    task: await readFile(join(dir, "task.md"), "utf8"), cwd: request.cwd,
    model: request.model, provider: request.provider, thinking: request.thinking,
    effort: request.effort as Effort | undefined, timeoutSeconds: request.timeoutSeconds,
    startedAt: request.createdAt, signal: controller.signal, runDir: childDir,
    contextWindowFor: request.agent === "pi" ? contextWindowLookup(request.contextWindows) : undefined,
    onLaunched: async (child, pid) => {
      const info = await processInfo(pid);
      await update({
        state: status.state === "cancelling" ? "cancelling" : "running", acceptedAt: Date.now(),
        child: info && { pid, startedAt: info.startedAt }, childDir: child,
      });
    },
    onProgress: (details) => {
      const now = Date.now();
      const marker = `${details.activity.length}:${details.activity.at(-1) ?? ""}:${details.preview.length}:${details.turns}`;
      if (marker !== lastActivity) { lastActivity = marker; status.lastActivityAt = now; }
      if (now - lastWrite < 500) return;
      lastWrite = now;
      void update({ details: snapshot(details) });
    },
  });
  controller.abort();
  await watch;
  const state: JobState = interrupted ? "interrupted"
    : outcome.outcome === "success" ? "succeeded"
    : outcome.outcome === "cancelled" ? "cancelled"
    : outcome.outcome === "timed-out" ? "timed-out" : "failed";
  const reason = state === "succeeded" ? undefined : interrupted ?? outcome.details.result?.split("\n")[0];
  const stderrTail = state === "succeeded" || !outcome.details.jobDir ? undefined
    : (await readTail(join(outcome.details.jobDir, "stderr.log")))?.trim() || undefined;
  await update({
    state, finishedAt: Date.now(), details: snapshot(outcome.details), usage: outcome.usage,
    terminalReason: reason, resultPath: outcome.resultPath, stderrTail,
    childDir: status.childDir ?? outcome.details.jobDir,
  });
}

const [root, id] = process.argv.slice(2);
supervise(root, id).catch(async (error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  try {
    await writeStatus(root, {
      version: 1, id, seq: 0, state: "failed", updatedAt: Date.now(), finishedAt: Date.now(),
      details: { activity: [], preview: "", turns: 0, toolCalls: 0, durationMs: 0 },
      terminalReason: `Supervisor failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  } catch { /* The record is unwritable; reconciliation reports the job as interrupted. */ }
  process.exitCode = 1;
});
