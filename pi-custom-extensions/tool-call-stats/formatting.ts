import type {
  ExtensionContext,
  Theme
} from "@earendil-works/pi-coding-agent";
import { aggregateToolTimings, cycleTps, sumUsage, totalToolCalls } from "./accounting.ts";
import type { CycleUsage, CyclePhase, PersistedCycle, ToolStat } from "./contracts.ts";

function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return "n/a";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = (ms % 60_000) / 1000;
  return `${minutes}m ${seconds.toFixed(1)}s`;
}

function formatRate(rate: number | undefined): string {
  return rate === undefined || !Number.isFinite(rate) ? "n/a" : `${rate.toFixed(1)} TPS`;
}

export function formatLiveCounter(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}

function formatWholeDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function phaseLabel(phase: Exclude<CyclePhase, "tools">): string {
  switch (phase) {
    case "waiting":
      return "Waiting...";
    case "thinking":
      return "Thinking...";
    case "responding":
      return "Responding...";
    case "preparing-tools":
      return "Preparing tools...";
  }
}

function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

export function formatLiveTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(2)}M`;
}

function formatCost(cost: number): string {
  if (cost === 0) return "$0";
  return cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`;
}

function formatUsageLine(usage: CycleUsage, theme: Theme): string {
  const sep = theme.fg("dim", " · ");
  return [
    `${theme.fg("dim", "in ")}${theme.fg("accent", formatTokens(usage.input))}`,
    `${theme.fg("dim", "cache read ")}${theme.fg("muted", formatTokens(usage.cacheRead))}`,
    `${theme.fg("dim", "cache write ")}${theme.fg("muted", formatTokens(usage.cacheWrite))}`,
    `${theme.fg("dim", "total ")}${theme.fg("text", formatTokens(usage.totalTokens))}`,
    `${theme.fg("dim", "cost ")}${theme.fg("warning", formatCost(usage.costTotal))}`,
  ].join(sep);
}

function percentage(part: number, whole: number): string {
  return whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "0.0%";
}

function formatToolTable(
  cycles: readonly PersistedCycle[],
  counts: Map<string, ToolStat>,
  theme: Theme,
): string[] {
  const tools = aggregateToolTimings(cycles, counts);
  if (tools.size === 0) return [theme.fg("dim", "  (none)")];

  const entries = Array.from(tools.entries()).sort((a, b) => b[1].count - a[1].count);
  const nameWidth = Math.max(4, ...entries.map(([name]) => name.length));
  const lines = [
    theme.fg(
      "dim",
      `  ${"tool".padEnd(nameWidth)}  calls  errors  timed  total       avg         max`,
    ),
  ];

  for (const [name, stat] of entries) {
    const average = stat.timedCount > 0 ? stat.totalMs / stat.timedCount : undefined;
    const errorText = `${stat.errors}`.padStart(6);
    lines.push(
      `  ${theme.fg("accent", name.padEnd(nameWidth))}` +
      `  ${theme.fg("text", `${stat.count}`.padStart(5))}` +
      `  ${theme.fg(stat.errors > 0 ? "error" : "muted", errorText)}` +
      `  ${theme.fg("muted", `${stat.timedCount}`.padStart(5))}` +
      `  ${theme.fg("text", formatDuration(stat.timedCount > 0 ? stat.totalMs : undefined).padStart(10))}` +
      `  ${theme.fg("text", formatDuration(average).padStart(10))}` +
      `  ${theme.fg("text", formatDuration(stat.timedCount > 0 ? stat.maxMs : undefined).padStart(10))}`,
    );
  }
  return lines;
}

export function formatDetail(
  cycles: readonly PersistedCycle[],
  toolStats: Map<string, ToolStat>,
  theme: Theme,
): string {
  const lines: string[] = [];
  const activeMs = cycles.reduce((sum, cycle) => sum + cycle.elapsedMs, 0);
  const generationMs = cycles.reduce((sum, cycle) => sum + (cycle.generationMs ?? 0), 0);
  const toolWallMs = cycles.reduce((sum, cycle) => sum + cycle.toolWallMs, 0);
  const toolSumMs = cycles.reduce((sum, cycle) => sum + cycle.toolSumMs, 0);
  const overheadMs = cycles.reduce((sum, cycle) => sum + cycle.overheadMs, 0);
  const outputTokens = cycles.reduce((sum, cycle) => sum + cycle.outputTokens, 0);
  const timedOutputTokens = cycles.reduce(
    (sum, cycle) => sum + (cycle.generationMs && cycle.generationMs > 0 ? cycle.outputTokens : 0),
    0,
  );
  const weightedTps = generationMs > 0 ? timedOutputTokens / (generationMs / 1000) : undefined;
  const ttfts = cycles
    .map((cycle) => cycle.ttftMs)
    .filter((value): value is number => value !== undefined);
  const averageTtft = ttfts.length > 0 ? ttfts.reduce((sum, value) => sum + value, 0) / ttfts.length : undefined;

  lines.push(theme.bold(theme.fg("accent", "Conversation summary")));
  lines.push(`  Tracked model cycles: ${theme.fg("accent", `${cycles.length}`)}`);
  lines.push(`  Tool calls:           ${theme.fg("accent", `${totalToolCalls(toolStats)}`)}`);
  const usage = sumUsage(cycles);
  lines.push(`  Input tokens:         ${theme.fg("accent", formatTokens(usage.input))}`);
  lines.push(`  Output tokens:        ${theme.fg("success", formatTokens(outputTokens))}`);
  lines.push(`  Cache read/write:     ${theme.fg("muted", formatTokens(usage.cacheRead))} / ${theme.fg("muted", formatTokens(usage.cacheWrite))}`);
  lines.push(`  Total tokens:         ${theme.fg("text", formatTokens(usage.totalTokens))}`);
  lines.push(`  Cost:                 ${theme.fg("warning", formatCost(usage.costTotal))}`);
  lines.push(`  Weighted throughput:  ${theme.fg("success", formatRate(weightedTps))}`);
  lines.push(
    `  TTFT avg/min/max:     ${theme.fg("text", formatDuration(averageTtft))} / ` +
    `${theme.fg("success", formatDuration(ttfts.length > 0 ? Math.min(...ttfts) : undefined))} / ` +
    `${theme.fg("warning", formatDuration(ttfts.length > 0 ? Math.max(...ttfts) : undefined))}`,
  );

  lines.push("");
  lines.push(theme.bold(theme.fg("accent", "Active processing time")));
  lines.push(`  Total:                ${theme.fg("accent", formatDuration(activeMs))}`);
  lines.push(
    `  Token generation:     ${theme.fg("success", formatDuration(generationMs))}` +
    `${theme.fg("dim", ` (${percentage(generationMs, activeMs)})`)}`,
  );
  lines.push(
    `  Tool use (wall):      ${theme.fg("warning", formatDuration(toolWallMs))}` +
    `${theme.fg("dim", ` (${percentage(toolWallMs, activeMs)})`)}`,
  );
  lines.push(
    `  Other/overhead:       ${theme.fg("muted", formatDuration(overheadMs))}` +
    `${theme.fg("dim", ` (${percentage(overheadMs, activeMs)})`)}`,
  );
  lines.push(`  Tool duration sum:    ${theme.fg("text", formatDuration(toolSumMs))}${theme.fg("dim", " (parallel calls overlap)")}`);

  if (cycles.length === 0) {
    lines.push("");
    lines.push(theme.fg("dim", "Timing data is recorded only for cycles completed after this extension was installed."));
  }

  lines.push("");
  lines.push(theme.bold(theme.fg("accent", "Tools (whole active branch)")));
  lines.push(...formatToolTable(cycles, toolStats, theme));

  lines.push("");
  lines.push(theme.bold(theme.fg("accent", "Model cycles")));
  if (cycles.length === 0) {
    lines.push(theme.fg("dim", "  (no tracked cycles)"));
  }

  cycles.forEach((cycle, index) => {
    const model = cycle.provider || cycle.model
      ? `${cycle.provider ?? "unknown"}/${cycle.model ?? "unknown"}`
      : "unknown model";
    lines.push("");
    lines.push(
      theme.bold(theme.fg("accent", `Cycle ${index + 1}`)) +
      theme.fg("dim", ` · ${model}${cycle.stopReason ? ` · ${cycle.stopReason}` : ""}`),
    );
    lines.push(
      `  ${theme.fg("success", `${formatTokens(cycle.outputTokens)} output`)}${theme.fg("dim", " · ")}` +
      `${theme.fg("success", formatRate(cycleTps(cycle)))}${theme.fg("dim", " · TTFT ")}` +
      `${theme.fg("accent", formatDuration(cycle.ttftMs))}${theme.fg("dim", " · total ")}` +
      `${theme.fg("text", formatDuration(cycle.elapsedMs))}`,
    );
    if (cycle.usage) {
      lines.push(`  ${formatUsageLine(cycle.usage, theme)}`);
    }
    lines.push(
      `  generation ${formatDuration(cycle.generationMs)} · tools ${formatDuration(cycle.toolWallMs)} wall / ` +
      `${formatDuration(cycle.toolSumMs)} sum · overhead ${formatDuration(cycle.overheadMs)}`,
    );
    if (cycle.providerAttempts > 1) {
      lines.push(theme.fg("warning", `  provider attempts: ${cycle.providerAttempts}`));
    }
    if (cycle.tools.length > 0) {
      const toolCounts = new Map<string, { count: number; errors: number }>();
      for (const tool of cycle.tools) {
        const stat = toolCounts.get(tool.name) ?? { count: 0, errors: 0 };
        stat.count++;
        if (tool.isError) stat.errors++;
        toolCounts.set(tool.name, stat);
      }
      const tools = Array.from(toolCounts, ([name, stat]) =>
        `${name} ×${stat.count}${stat.errors > 0 ? ` (${stat.errors} ${stat.errors === 1 ? "error" : "errors"})` : ""}`,
      ).join(" · ");
      lines.push(`  tools: ${tools}`);
    }
  });

  return lines.join("\n");
}

export function statusText(
  ctx: ExtensionContext,
  cycles: readonly PersistedCycle[],
  toolStats: Map<string, ToolStat>,
): string {
  const theme = ctx.ui.theme;
  const last = cycles[cycles.length - 1];
  if (!last) return theme.fg("dim", `${totalToolCalls(toolStats)} tools · 0s total`);
  const totalElapsedMs = cycles.reduce((sum, trackedCycle) => sum + trackedCycle.elapsedMs, 0);
  return (
    theme.fg("success", formatRate(cycleTps(last))) +
    theme.fg("dim", " · TTFT ") +
    theme.fg("accent", formatDuration(last.ttftMs)) +
    theme.fg("dim", ` · ${totalToolCalls(toolStats)} tools · `) +
    theme.fg("warning", `${formatWholeDuration(totalElapsedMs)} total`)
  );
}
