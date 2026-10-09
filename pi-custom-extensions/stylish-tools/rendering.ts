import { keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";

export type IndicatorColor = "borderAccent" | "success" | "warning" | "error";

export type Status = "running" | "success" | "error" | "aborted" | "timeout";

export interface RenderState {
  startedAt?: number;
  endedAt?: number;
  interval?: NodeJS.Timeout;
  status: Status;
}

// Preview caps mirror pi's own stock per-tool defaults (see bash.ts's
// BASH_PREVIEW_LINES, grep/ls/find/write's `options.expanded ? ... : N`).
export const BASH_TAIL_LINES = 5;

const READ_PREVIEW_LINES = 3;

export const GREP_PREVIEW_LINES = 15;

export const LS_PREVIEW_LINES = 20;

export const FIND_PREVIEW_LINES = 20;

export const WRITE_PREVIEW_LINES = 10;

const EXPANDED_CAP = 40;

// ---------------------------------------------------------------------------
// Shared status/indicator/timer machinery
// ---------------------------------------------------------------------------

export function getIndicatorColor(status: Status): IndicatorColor {
  switch (status) {
    case "success":
      return "success";
    case "error":
      return "error";
    case "aborted":
    case "timeout":
      return "warning";
    case "running":
    default:
      return "borderAccent";
  }
}

export function getStatusIcon(status: Status): string {
  switch (status) {
    case "running":
      return "⟳";
    case "success":
      return "✓";
    case "error":
      return "✗";
    case "aborted":
      return "⏹";
    case "timeout":
      return "⏱";
  }
}

export function getStatusColor(status: Status): "success" | "error" | "warning" | "muted" {
  switch (status) {
    case "success":
      return "muted";
    case "error":
      return "error";
    case "aborted":
    case "timeout":
      return "warning";
    case "running":
      return "warning";
  }
}

export function formatDuration(state: RenderState, now = Date.now()): string {
  if (state.startedAt === undefined) return "";
  const end = state.endedAt ?? now;
  return `${((end - state.startedAt) / 1000).toFixed(2)}s`;
}

export function ensureState(context: { state: unknown }): RenderState {
  const state = context.state as RenderState;
  state.status ??= "running";
  return state;
}

export function updateRenderState(
  context: { state: unknown; executionStarted: boolean; invalidate: () => void },
  isPartial: boolean,
  isError: boolean,
  timers: Set<NodeJS.Timeout>,
): RenderState {
  const state = ensureState(context);

  if (context.executionStarted && state.startedAt === undefined) {
    state.startedAt = Date.now();
  }

  if (isPartial) {
    state.status = "running";
    if (!state.interval) {
      state.interval = setInterval(() => context.invalidate(), 1000);
      timers.add(state.interval);
    }
  } else {
    state.endedAt ??= Date.now();
    state.status = isError ? "error" : "success";
    if (state.interval) {
      clearInterval(state.interval);
      timers.delete(state.interval);
      state.interval = undefined;
    }
  }

  return state;
}

// bash-specific: refine error into aborted/timeout from the built-in's own
// footer text, same detection stylish-bash.ts used.
export function refineBashStatus(state: RenderState, output: string, isError: boolean): void {
  if (!isError) return;
  if (/Command aborted\b/.test(output)) state.status = "aborted";
  else if (/Command timed out\b/.test(output)) state.status = "timeout";
}

// ---------------------------------------------------------------------------
// Rendering primitives
// ---------------------------------------------------------------------------

/** Plain lines, no border, no wrap — used for collapsed states. */
export class PlainLines implements Component {
  constructor(private lines: string[]) { }
  render(width: number): string[] {
    return this.lines.map((line) => truncateToWidth(line, width, "", true));
  }
  invalidate(): void { }
}

/**
 * Borderless indicator block — used for the expanded state of every tool.
 * No box-drawing; a colored ● marks the header, a colored │ gutter marks
 * each body/footer line so the block still reads as one unit while
 * scrolling past it stays cheap (no corner/fill math, no frame padding).
 */
export class IndicatorBlock implements Component {
  constructor(
    private label: string,
    private theme: Theme,
    private status: Status,
    private body: string[],
    private footer: string,
  ) { }

  render(width: number): string[] {
    const color = getIndicatorColor(this.status);
    const dot = this.theme.fg(color, "●");
    const guide = this.theme.fg(color, "│");
    const header = `${dot} ${this.theme.fg("toolTitle", this.theme.bold(this.label))}`;

    const lines = [
      header,
      ...this.body.map((line) => `${guide} ${line}`),
      `${guide} ${this.footer}`,
    ];
    return lines.map((line) => truncateToWidth(line, width, "", true));
  }

  invalidate(): void { }
}

export function formatStatusLine(
  theme: Theme,
  status: Status,
  state: RenderState,
  extras: string[],
  expanded: boolean,
  now = Date.now(),
): string {
  const icon = getStatusIcon(status);
  const statusText = status === "success" ? "done" : status === "error" ? "failed" : status;
  const duration = formatDuration(state, now);

  const parts = [`${icon} ${statusText}`];
  if (duration) parts.push(duration);
  parts.push(...extras);
  if (!expanded && status !== "running") parts.push(keyHint("app.tools.expand", "expand"));

  return (
    theme.fg(getStatusColor(status), parts[0]) + theme.fg("muted", ` · ${parts.slice(1).join(" · ")}`)
  );
}

export function capLines(lines: string[], theme: Theme, cap = EXPANDED_CAP): string[] {
  if (lines.length <= cap) return lines;
  return [...lines.slice(0, cap), theme.fg("muted", `… ${lines.length - cap} more lines`)];
}

/** First-N-line preview for the collapsed state, dimmed. */
export function buildPreview(theme: Theme, lines: string[], limit = READ_PREVIEW_LINES): string[] {
  if (lines.length === 0) return [];
  return lines.slice(0, limit).map((l) => theme.fg("dim", l));
}

export function colorDiffLine(theme: Theme, line: string): string {
  if (line.startsWith("+") && !line.startsWith("+++")) return theme.fg("toolDiffAdded", line);
  if (line.startsWith("-") && !line.startsWith("---")) return theme.fg("toolDiffRemoved", line);
  return theme.fg("toolDiffContext", line);
}

export function getTextOutput(result: { content: Array<{ type: string; text?: string }> }): string {
  const texts = result.content.filter((c) => c.type === "text").map((c) => c.text ?? "");
  return texts.join("\n");
}

export function countNonEmptyLines(text: string): number {
  return text.split("\n").filter((l) => l.trim().length > 0).length;
}

/** Notice appended after a label/path when operations are overridden, e.g. " (remote) user@host". */
export function renderTag(theme: Theme, tag: string | undefined): string {
  return tag ? ` ${theme.fg("warning", "(remote)")}${theme.fg("dim", ` ${tag}`)}` : "";
}

/** Label suffix used in the expanded IndicatorBlock header when overridden. */
export function tagLabel(baseLabel: string, tag: string | undefined): string {
  return tag ? `${baseLabel} (remote)` : baseLabel;
}

// ---------------------------------------------------------------------------
// Skill-read detection — pi has no dedicated "load skill" tool; per
// dist/core/skills.js's formatSkillsForPrompt, the model is instructed to
// `read` a skill's SKILL.md (or, for ~/.pi/agent/skills & .pi/skills, a root
// .md file directly under a skills/ dir) itself. We just recognize that
// shape of a read call and style it distinctly.
// ---------------------------------------------------------------------------

const SKILL_MD_RE = /(?:^|\/)SKILL\.md$/i;

const SKILL_ROOT_MD_RE = /(?:^|\/)skills\/[^/]+\.md$/i;

export function isSkillPath(path: string): boolean {
  return SKILL_MD_RE.test(path) || SKILL_ROOT_MD_RE.test(path);
}

export function skillNameFromPath(path: string): string {
  const parts = path.split("/");
  const base = parts[parts.length - 1] ?? path;
  if (/^SKILL\.md$/i.test(base)) return parts[parts.length - 2] ?? base;
  return base.replace(/\.md$/i, "");
}
