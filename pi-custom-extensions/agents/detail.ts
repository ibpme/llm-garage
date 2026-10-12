import { stat } from "node:fs/promises";
import { join } from "node:path";
import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { isTerminal, readBounded } from "../shared/agent-jobs/store.ts";
import type { JobSnapshot } from "../shared/agent-jobs/jobs.ts";
import { contextSegment } from "../agent-task/context-usage.ts";
import { agentDescription, agentState, clean, cleanText, jobElapsed, jobModel, providerName, stateText, stateTone } from "./rows.ts";
import { isSelectable, type Agent } from "./tmux.ts";

export const SECTIONS = [
  { id: "activity", label: "Activity" },
  { id: "result", label: "Result" },
  { id: "task", label: "Task" },
] as const;
export type Section = typeof SECTIONS[number]["id"];
export const RESULT_LIMIT = 256 * 1024;
const TASK_LIMIT = 64 * 1024;

export interface JobFiles {
  task?: string;
  result?: { text: string; truncated: boolean; missing?: boolean };
}

export async function loadFiles(job: JobSnapshot, previous: JobFiles = {}): Promise<JobFiles> {
  const files: JobFiles = { task: previous.task ?? await readBounded(join(job.dir, "task.md"), TASK_LIMIT).catch(() => undefined) };
  const { resultPath, state } = { resultPath: job.status.resultPath, state: job.status.state };
  if (isTerminal(state)) {
    try {
      const text = resultPath ? await readBounded(resultPath, RESULT_LIMIT) : undefined;
      files.result = text === undefined
        ? { text: "", truncated: false, missing: true }
        : { text, truncated: (await stat(resultPath!)).size > RESULT_LIMIT };
    } catch { files.result = { text: "", truncated: false, missing: true }; }
  }
  return files;
}

function markdown(text: string, width: number): string[] {
  try { return new Markdown(cleanText(text), 0, 0, getMarkdownTheme()).render(width); }
  catch { return wrap(cleanText(text), width); }
}

const wrap = (text: string, width: number): string[] =>
  text.split("\n").flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));

export function jobHeader(job: JobSnapshot, theme: Pick<Theme, "fg" | "bold">, now: number, attached = false): string[] {
  const { status, request } = job;
  const d = status.details;
  const latest = d.latestCallUsage;
  const context = contextSegment(d);
  const count = (value: number) => value.toLocaleString("en-US");
  const wait = !isTerminal(status.state) && job.waitPolicy === "foreground" ? ` · foreground${attached ? "" : " (detached)"}` : "";
  // Clean raw values only: theme styling adds escape sequences that clean() would strip.
  return [
    `${theme.bold(clean(request.name))}  ${theme.fg("dim", job.id)}`,
    `${theme.fg(stateTone(status.state), clean(stateText(job)))}${wait} · ${jobElapsed(job, now)} · ${clean(jobModel(job))}`,
    theme.fg("muted", `${d.turns} turns · ${d.toolCalls} tool calls` +
      (latest ? ` · last call: ↓ ${count(latest.input)} input · ↑ ${count(latest.output)} output · cached ${count(latest.cacheRead + latest.cacheWrite)}` : "")) +
      (context ? theme.fg("muted", " · ") + theme.fg(context.tone, context.text) : ""),
  ];
}

export function tabsLine(section: Section, theme: Pick<Theme, "fg">): string {
  return SECTIONS.map((item) => item.id === section ? theme.fg("accent", `[${item.label}]`) : theme.fg("dim", item.label)).join(" ");
}

export function sectionLines(section: Section, job: JobSnapshot, files: JobFiles, width: number, theme: Pick<Theme, "fg" | "bold">): string[] {
  const { status, request } = job;
  if (section === "activity") {
    const activity = status.details.activity;
    return activity.length ? activity.flatMap((entry) => wrap(`${theme.fg("dim", "•")} ${clean(entry)}`, width))
      : [theme.fg("muted", isTerminal(status.state) ? "No activity recorded." : "Waiting for activity…")];
  }
  if (section === "result") {
    if (!isTerminal(status.state)) {
      const preview = status.details.preview;
      return [theme.fg("warning", "Partial preview (job still running)"), "",
        ...(preview ? markdown(preview, width) : [theme.fg("muted", "No response text yet.")])];
    }
    const result = files.result;
    if (!result) return [theme.fg("muted", "Loading result…")];
    if (result.missing || !result.text.trim()) {
      return [theme.fg("muted", `No final response recorded${status.terminalReason ? `: ${clean(status.terminalReason)}` : "."}`)];
    }
    return [...markdown(result.text, width),
      ...(result.truncated ? ["", theme.fg("warning", `Truncated to the first ${RESULT_LIMIT / 1024} KiB. Full answer: ${clean(status.resultPath ?? "")}`)] : [])];
  }
  const meta: [string, string | undefined][] = [
    ["cwd", request.cwd], ["owner session", request.owner.sessionId], ["job dir", job.dir], ["result", status.resultPath],
    ["supervisor PID", status.supervisor ? String(status.supervisor.pid) : undefined],
    ["child PID", status.child ? String(status.child.pid) : undefined],
    ["terminal reason", status.terminalReason],
  ];
  return [
    ...(files.task ? wrap(cleanText(files.task), width) : [theme.fg("muted", "Task text unavailable.")]),
    "", theme.fg("accent", "Metadata"),
    ...meta.filter(([, value]) => value).flatMap(([key, value]) => wrap(`${theme.fg("dim", `${key}:`)} ${clean(value!)}`, width)),
    ...(status.stderrTail ? ["", theme.fg("accent", "stderr (tail)"), ...wrap(theme.fg("dim", cleanText(status.stderrTail.slice(-2000))), width)] : []),
  ];
}

export function processLines(agent: Agent, width: number, theme: Pick<Theme, "fg" | "bold">, exited: boolean): string[] {
  const { process, pane, metadata } = agent;
  const rows: [string, string | undefined][] = [
    ["provider", providerName(agent)], ["state", agentState(agent)], ["PID", String(process.pid)], ["parent PID", String(process.ppid)],
    ["started", process.startedAt], ["name", metadata?.name], ["model", metadata?.modelDisplayName ?? metadata?.model],
    ["cwd", metadata?.cwd ?? pane?.cwd], ["session", metadata?.sessionId], ["waiting for", metadata?.waitingFor],
    ["pane", pane ? `${pane.sessionName}:${pane.windowIndex}.${pane.paneIndex} ${pane.id}` : undefined],
    ["command", process.args || process.command],
  ];
  const note = isSelectable(agent) ? "Interactive process in a tmux pane." : agent.interactive ? "Interactive process without a pane on this tmux server."
    : "Unmanaged headless process: only process metadata is available (no log or control access).";
  return [
    ...(exited ? [theme.fg("warning", "This process is no longer listed."), ""] : []),
    theme.fg("muted", note), "",
    ...rows.filter(([, value]) => value).flatMap(([key, value]) => wrap(`${theme.fg("dim", `${key}:`)} ${clean(value!)}`, width)),
  ];
}

export const processHeader = (agent: Agent, theme: Pick<Theme, "fg" | "bold">): string[] => [
  theme.bold(clean(`${providerName(agent)} process  PID ${agent.process.pid}`)),
  theme.fg("muted", truncateToWidth(agentDescription(agent) || agentState(agent), 200)),
];
