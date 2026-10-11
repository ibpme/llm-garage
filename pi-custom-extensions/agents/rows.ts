import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { isTerminal, type JobState } from "../shared/agent-jobs/store.ts";
import type { JobSnapshot } from "../shared/agent-jobs/jobs.ts";
import { isDescendant, type ProcessInfo } from "../shared/process-identity.ts";
import { isSelectable, type Agent } from "./tmux.ts";

export const clean = (text: string): string => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
/** Keeps newlines and tabs for multi-line file content. */
export const cleanText = (text: string): string => text.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, " ");

export const FILTERS = [
  { id: "session", label: "This session" },
  { id: "live", label: "All live" },
  { id: "recent", label: "Recent jobs" },
] as const;
export type Filter = typeof FILTERS[number]["id"];
export const RECENT_LIMIT = 100;

export type Row =
  | { kind: "job"; key: string; job: JobSnapshot; owned: boolean }
  | { kind: "agent"; key: string; agent: Agent };

export const agentKey = (agent: Agent): string => `${agent.provider}:${agent.pane?.sessionId ?? ""}:${agent.pane?.id ?? ""}:${agent.process.pid}`;
export const agentState = (agent: Agent): string => agent.metadata?.state ?? "running (status unknown)";
export const agentDescription = (agent: Agent): string => clean([
  agent.metadata?.model, agent.metadata?.name, agent.metadata?.cwd ?? agent.pane?.cwd, agent.metadata?.waitingFor,
].filter(Boolean).join(" · "));
export const providerName = (agent: Agent): string => agent.provider === "claude" ? "Claude" : "Pi";

export function buildRows(
  filter: Filter, jobs: JobSnapshot[], active: JobSnapshot[], agents: Agent[],
  processes: Map<number, ProcessInfo> | undefined, sessionId: string,
): Row[] {
  const owns = (job: JobSnapshot) => !!sessionId && job.request.owner.sessionId === sessionId;
  const shown = jobs.filter((job) => filter === "recent" || (filter === "live" ? !isTerminal(job.status.state) : owns(job)));
  const rows: Row[] = shown.map((job) => ({ kind: "job", key: job.id, job, owned: owns(job) }));
  if (filter === "recent") return rows;
  // Only a verified, still-running job leader hides its descendants; a stale record never hides a live process.
  const leaders = active.flatMap((job) => {
    const child = job.status.child;
    return child && !isTerminal(job.status.state) && processes?.get(child.pid)?.startedAt === child.startedAt ? [child.pid] : [];
  });
  const visible = agents.filter((agent) => !processes || !leaders.some((leader) => isDescendant(agent.process.pid, leader, processes)));
  for (const agent of [...visible.filter(isSelectable), ...visible.filter((item) => !isSelectable(item))]) {
    rows.push({ kind: "agent", key: agentKey(agent), agent });
  }
  return rows;
}

export function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

export const jobElapsed = (job: JobSnapshot, now: number): string => {
  const { status, request } = job;
  if (isTerminal(status.state)) return duration(status.details.durationMs || (status.finishedAt ?? now) - (status.acceptedAt ?? request.createdAt));
  return duration(now - (status.acceptedAt ?? request.createdAt));
};

export const stateTone = (state: JobState): "accent" | "success" | "error" | "warning" =>
  state === "succeeded" ? "success" : state === "failed" || state === "timed-out" ? "error"
    : state === "cancelled" || state === "interrupted" || state === "cancelling" ? "warning" : "accent";

export const stateText = (job: JobSnapshot): string =>
  job.liveness === "unknown" && !isTerminal(job.status.state) ? `${job.status.state} (supervisor lost)` : job.status.state;

export const jobModel = (job: JobSnapshot): string =>
  `${job.request.agent}${job.status.details.model ?? job.request.model ? `/${job.status.details.model ?? job.request.model}` : ""}`;

export function rowLine(row: Row, theme: Pick<Theme, "fg">, originPane: string | undefined, now: number): { label: string; detail: string } {
  if (row.kind === "agent") {
    const { agent } = row;
    const pane = agent.pane;
    const location = pane ? `  ${pane.sessionName}:${pane.windowIndex}.${pane.paneIndex} ${pane.id}` : "";
    const reason = isSelectable(agent) ? "" : agent.interactive ? " · no pane" : " · headless";
    return {
      label: clean(`${providerName(agent)}  ${agentState(agent)}${location}  PID ${agent.process.pid}${pane && pane.id === originPane ? " (current)" : ""}${reason}`),
      detail: agentDescription(agent),
    };
  }
  const { job } = row;
  const quiet = !isTerminal(job.status.state) && job.status.lastActivityAt && now - job.status.lastActivityAt >= 10_000
    ? ` · quiet ${duration(now - job.status.lastActivityAt)}` : "";
  return {
    label: clean(`Job  ${job.request.name}  ${theme.fg(stateTone(job.status.state), stateText(job))}  ${jobElapsed(job, now)}${quiet}`),
    detail: clean(`${job.id} · ${jobModel(job)}${row.owned ? "" : " · other session"}`),
  };
}

export interface ListView { lines: string[]; offset: number; info: string }

/** One line per row with a window that keeps the selection visible. */
export function renderList(
  rows: Row[], selected: number, offset: number, visible: number, width: number,
  theme: Pick<Theme, "fg">, originPane: string | undefined, now: number,
): ListView {
  const start = Math.max(0, Math.min(offset, selected, Math.max(0, rows.length - visible)));
  const from = selected >= start + visible ? selected - visible + 1 : start;
  const lines = rows.slice(from, from + visible).map((row, i) => {
    const { label, detail } = rowLine(row, theme, originPane, now);
    const current = from + i === selected;
    const text = `${current ? "→" : " "} ${label}${detail ? `  ${theme.fg("muted", detail)}` : ""}`;
    return truncateToWidth(current ? theme.fg("accent", text) : text, width);
  });
  return { lines, offset: from, info: rows.length > visible ? `${from + 1}–${Math.min(rows.length, from + visible)}/${rows.length}` : "" };
}
