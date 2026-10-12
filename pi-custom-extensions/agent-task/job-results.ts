import { open } from "node:fs/promises";
import type { Usage } from "@earendil-works/pi-ai";
import type { JobSnapshot } from "../shared/agent-jobs/jobs.ts";
import { isTerminal } from "../shared/agent-jobs/store.ts";
import { oneLine, type RunDetails } from "./events.ts";

export const MODEL_RESULT_LIMIT = 40 * 1024;

export const isOutstanding = (job: JobSnapshot): boolean => !isTerminal(job.status.state) ||
  (!job.markers.has("delivered") && !job.markers.has("acknowledged"));

export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60 ? ` ${seconds % 60}s` : ""}`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function stateLabel(job: JobSnapshot, now = Date.now()): string {
  const { state, finishedAt } = job.status;
  if (isTerminal(state)) return `${state} after ${duration((finishedAt ?? now) - job.request.createdAt)}`;
  return `${state}${job.liveness === "unknown" ? " (supervisor lost; status unknown)" : ""} for ${duration(now - job.request.createdAt)}`;
}

export const jobLabel = (job: JobSnapshot): string => `${job.id} (${oneLine(job.request.name, 64)})`;

export function summaryLine(job: JobSnapshot, now = Date.now()): string {
  const retrieved = isTerminal(job.status.state)
    ? job.markers.has("delivered") ? " · result retrieved" : " · result not retrieved" : "";
  return `${jobLabel(job)}: ${stateLabel(job, now)} · ${job.request.agent}${retrieved}`;
}

async function readPrefix(path: string, limit: number): Promise<{ text: string; truncated: boolean } | undefined> {
  let file;
  try { file = await open(path, "r"); }
  catch { return undefined; }
  try {
    const { size } = await file.stat();
    const buffer = Buffer.alloc(Math.min(size, limit));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    // Drop a trailing partial UTF-8 sequence instead of emitting a replacement character.
    return { text: new TextDecoder().decode(buffer.subarray(0, bytesRead), { stream: true }), truncated: size > limit };
  } finally { await file.close(); }
}

/** Model-facing text for a job; isError for every non-succeeded terminal job. */
export async function resultText(job: JobSnapshot, now = Date.now()): Promise<{ text: string; isError: boolean }> {
  const { status, request } = job;
  const footer = `[Agent task job ${job.id}: ${job.dir}]`;
  if (!isTerminal(status.state)) {
    const quiet = status.lastActivityAt ? ` Last activity ${duration(now - status.lastActivityAt)} ago.` : "";
    return { isError: false, text: `${jobLabel(job)} is ${stateLabel(job, now)}; no result yet.${quiet} ` +
      `A completion notice arrives when it finishes; continue with independent work or end your turn until then.\n\n${footer}` };
  }
  if (status.state === "succeeded") {
    const answer = status.resultPath ? await readPrefix(status.resultPath, MODEL_RESULT_LIMIT) : undefined;
    if (!answer) return { isError: true, text: `${jobLabel(job)} succeeded, but its result file is missing.\n\n${footer}` };
    return { isError: false, text: answer.text +
      (answer.truncated ? `\n\n[Truncated. Full response: ${status.resultPath}]` : "") + `\n\n${footer}` };
  }
  const parts = [
    `Agent task ${jobLabel(job)} ${status.state}: ${status.terminalReason ?? "no reason recorded"}.`,
    `The child may have left partial file changes in ${request.cwd}; inspect them before relying on that tree or retrying. It was not retried automatically.`,
  ];
  if (status.details.preview.trim()) parts.push(`Partial answer (incomplete):\n${status.details.preview}`);
  if (status.stderrTail) parts.push(`stderr tail:\n${status.stderrTail.slice(-2000)}`);
  parts.push(footer);
  return { isError: true, text: parts.join("\n\n") };
}

/**
 * Model-facing receipt for a job the parent no longer waits for. It states the
 * observed state, which may already be terminal, and never carries the answer.
 */
export function receiptText(job: JobSnapshot, backgrounded: boolean, now = Date.now()): string {
  const { request, status } = job;
  const observed = isTerminal(status.state) ? `has already finished (${status.state})` : `is ${stateLabel(job, now)}`;
  const intro = backgrounded
    ? `The user sent foreground agent task ${jobLabel(job)} to the background; it ${observed}.`
    : `Background agent task ${jobLabel(job)} was accepted and ${observed}.`;
  const deadline = backgrounded ? `its original ${request.timeoutSeconds}s timeout still applies` : `timeout ${request.timeoutSeconds}s`;
  return `${intro} (${request.agent}${request.model ? ` · ${request.model}` : ""}; ${deadline}.) ` +
    "This is a receipt, not its answer. Continue with independent work; a short notice arrives when it finishes. " +
    `Retrieve its answer with the jobs tool {"action":"result","job_id":"${job.id}"} before relying on it, ` +
    `and do not edit files it may be changing until then.\n\n[Agent task job ${job.id}: ${job.dir}]`;
}

/** Renderer details for a supervised job, matching a direct run's progress and final display. */
export function runDetails(job: JobSnapshot, task: string, result?: string, now = Date.now()): RunDetails {
  const { request, status } = job;
  const details = status.details;
  const terminal = isTerminal(status.state);
  return {
    agent: request.agent, name: request.name, task, cwd: request.cwd, model: details.model ?? request.model,
    status: !terminal ? "running" : status.state === "succeeded" ? "success" : status.state === "cancelled" ? "aborted" : "error",
    activity: [...details.activity], preview: details.preview, turns: details.turns, toolCalls: details.toolCalls,
    durationMs: terminal ? details.durationMs : now - request.createdAt, jobDir: status.childDir, result,
    exitCode: details.exitCode, totalTokens: details.totalTokens, latestCallUsage: details.latestCallUsage,
    contextWindow: details.contextWindow, usagePartial: details.usagePartial, costUsd: details.costUsd,
  };
}

export function addUsage(total: Usage, usage: Usage | undefined): Usage {
  if (!usage) return total;
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) total[key] += usage[key] ?? 0;
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) total.cost[key] += usage.cost?.[key] ?? 0;
  for (const key of ["reasoning", "cacheWrite1h"] as const)
    if (usage[key] !== undefined) total[key] = (total[key] ?? 0) + usage[key];
  return total;
}

/** The outstanding-jobs reminder appended to model context; never saved to the session. */
export function outstandingText(jobs: JobSnapshot[], now = Date.now()): string | undefined {
  const outstanding = jobs.filter(isOutstanding);
  if (!outstanding.length) return undefined;
  return "Background agent task jobs you launched in this session (reminder; not part of the conversation):\n" +
    outstanding.slice(0, 12).map((job) => `- ${summaryLine(job, now)}`).join("\n") +
    (outstanding.length > 12 ? `\n- …and ${outstanding.length - 12} more (jobs tool, action "list")` : "") +
    "\nRetrieve a result with the jobs tool before relying on it or claiming dependent work is complete. " +
    "Do not edit files a running job may be changing until you have its result.";
}

export function noticeText(jobs: JobSnapshot[], now = Date.now()): string {
  const lines = jobs.map((job) => `- ${jobLabel(job)}: ${stateLabel(job, now)}` +
    (job.status.state !== "succeeded" && job.status.terminalReason ? ` — ${oneLine(job.status.terminalReason, 200)}` : ""));
  return `Background agent task job${jobs.length === 1 ? "" : "s"} finished:\n${lines.join("\n")}\n` +
    `Use the jobs tool with action "result" to retrieve ${jobs.length === 1 ? "it" : "them"}.`;
}
