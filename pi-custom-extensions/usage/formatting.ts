import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { UsageReport, UsageWindow } from "./providers.ts";

export type UsageTheme = Pick<Theme, "fg" | "bold">;

export interface RenderOptions {
  now?: number;
  theme?: UsageTheme;
  /** Omit to skip wrapping; the pager passes its viewport width. */
  width?: number;
}

const BAR_WIDTH = 18;
const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];

export const plainTheme: UsageTheme = {
  fg: (_color: ThemeColor, text: string) => text,
  bold: (text: string) => text,
};

export function countdown(milliseconds: number): string {
  if (milliseconds <= 0) return "reset time passed";
  const minutes = Math.ceil(milliseconds / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const remainder = minutes % 60;
  return [days ? `${days}d` : "", hours ? `${hours}h` : "", remainder ? `${remainder}m` : ""]
    .filter(Boolean).slice(0, 2).join(" ");
}

function formatPercent(value: number): string {
  return String(Math.round(value * 10) / 10);
}

function severity(usedPercent: number): ThemeColor {
  if (usedPercent >= 85) return "error";
  if (usedPercent >= 60) return "warning";
  return "success";
}

/** Eighth-block resolution bar; the filled part takes its color from usage severity. */
export function usageBar(usedPercent: number, theme: UsageTheme): string {
  const clamped = Math.min(100, Math.max(0, usedPercent));
  const cells = (clamped / 100) * BAR_WIDTH;
  let full = Math.floor(cells);
  let partial = Math.round((cells - full) * 8);
  if (partial === 8) {
    full += 1;
    partial = 0;
  }
  const filled = "█".repeat(full) + EIGHTHS[partial];
  const empty = "░".repeat(BAR_WIDTH - full - (partial ? 1 : 0));
  return theme.fg(severity(clamped), filled) + theme.fg("borderMuted", empty);
}

const visibleLength = (text: string): number => text.replace(/\u001b\[[0-9;]*m/g, "").length;

function windowLine(window: UsageWindow, labelWidth: number, now: number, theme: UsageTheme, width?: number): string {
  const label = theme.fg("text", window.label.padEnd(labelWidth));
  const parts: string[] = [];
  if (window.usedPercent !== undefined) {
    const used = window.usedPercent;
    const color = severity(used);
    parts.push(
      usageBar(used, theme),
      theme.bold(theme.fg(color, `${formatPercent(used)}% used`)),
      theme.fg("muted", `· ${formatPercent(100 - used)}% left`),
    );
  } else {
    parts.push(theme.fg("dim", window.note ?? "Usage unavailable."));
  }
  if (window.status === "rate-limited") parts.push(theme.fg("error", "● rate limited"));

  const line = `  ${[label, ...parts].join(" ")}`;
  if (window.resetsAt === undefined) return line;
  const remaining = countdown(window.resetsAt - now);
  const when = new Date(window.resetsAt).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
  const full = `  ↻ ${remaining} · ${when}`;
  // The absolute time is the first thing to go when the viewport is narrow.
  const reset = width === undefined || visibleLength(line) + full.length <= width
    ? `  ↻ ${remaining} · ${when}` : `  ↻ ${remaining}`;
  return line + theme.fg("dim", reset);
}

function wrap(text: string, width: number | undefined): string[] {
  if (!width || text.length <= width) return [text];
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/)) {
    if (current && current.length + 1 + word.length > width) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

export function renderUsage(reports: readonly UsageReport[], options: RenderOptions = {}): string[] {
  const theme = options.theme ?? plainTheme;
  const now = options.now ?? Date.now();
  const width = options.width;
  if (reports.length === 0) {
    return wrap("No supported providers are configured. Use /login opencode-go or /login openai.", width)
      .map((line) => theme.fg("muted", line));
  }

  const lines: string[] = [];
  reports.forEach((report, index) => {
    if (index > 0) lines.push("");
    const plan = report.plan ? "  " + theme.fg("syntaxKeyword", `◆ ${report.plan}`) : "";
    lines.push(theme.bold(theme.fg("accent", report.title)) + plan);
    const labelWidth = Math.max(0, ...report.windows.map((window) => window.label.length)) + 2;
    for (const window of report.windows) lines.push(windowLine(window, labelWidth, now, theme, width));
    for (const note of report.notes) {
      const wrapped = wrap(note, width === undefined ? undefined : width - 4);
      wrapped.forEach((part, partIndex) => {
        const marker = partIndex === 0 ? theme.fg("muted", "ℹ") : " ";
        lines.push(`  ${marker} ${theme.fg("muted", part)}`);
      });
    }
  });
  return lines;
}

export function formatUsage(reports: readonly UsageReport[], now = Date.now()): string {
  return renderUsage(reports, { now, theme: plainTheme }).join("\n");
}
