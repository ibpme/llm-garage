import { ENTRY_VERSION } from "./contracts.ts";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  SessionEntry
} from "@earendil-works/pi-coding-agent";
import type { CycleUsage, PersistedCycle, ToolStat, ToolTimingStat } from "./contracts.ts";

export const ENTRY_TYPE = "agent-stats-cycle";

export function emptyUsage(): CycleUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costTotal: 0 };
}

export function addUsage(target: CycleUsage, usage: AssistantMessage["usage"]): void {
  target.input += usage.input;
  target.output += usage.output;
  target.cacheRead += usage.cacheRead;
  target.cacheWrite += usage.cacheWrite;
  target.totalTokens += usage.totalTokens;
  target.costTotal += usage.cost.total;
}

export function sumUsage(cycles: readonly PersistedCycle[]): CycleUsage {
  const total = emptyUsage();
  for (const cycle of cycles) {
    if (!cycle.usage) continue;
    total.input += cycle.usage.input;
    total.output += cycle.usage.output;
    total.cacheRead += cycle.usage.cacheRead;
    total.cacheWrite += cycle.usage.cacheWrite;
    total.totalTokens += cycle.usage.totalTokens;
    total.costTotal += cycle.usage.costTotal;
  }
  return total;
}

export function now(): number {
  return performance.now();
}

function bumpToolStat(map: Map<string, ToolStat>, name: string, errorOnly: boolean) {
  const stat = map.get(name) ?? { count: 0, errors: 0 };
  if (errorOnly) stat.errors++;
  else stat.count++;
  map.set(name, stat);
}

export function computeToolStats(branch: readonly SessionEntry[]): Map<string, ToolStat> {
  const overall = new Map<string, ToolStat>();
  const toolNameByCallId = new Map<string, string>();

  for (const entry of branch) {
    if (entry.type !== "message") continue;
    const message = entry.message;

    if (message.role === "assistant") {
      for (const part of (message as AssistantMessage).content) {
        if (part.type !== "toolCall") continue;
        toolNameByCallId.set(part.id, part.name);
        bumpToolStat(overall, part.name, false);
      }
    } else if (message.role === "toolResult" && message.isError) {
      const name = toolNameByCallId.get(message.toolCallId) ?? message.toolName;
      bumpToolStat(overall, name, true);
    }
  }

  return overall;
}

function isPersistedCycle(value: unknown): value is PersistedCycle {
  if (!value || typeof value !== "object") return false;
  const cycle = value as Partial<PersistedCycle>;
  return (
    cycle.version === ENTRY_VERSION &&
    typeof cycle.turnIndex === "number" &&
    typeof cycle.startedAt === "number" &&
    typeof cycle.providerAttempts === "number" &&
    typeof cycle.outputTokens === "number" &&
    typeof cycle.elapsedMs === "number" &&
    typeof cycle.toolWallMs === "number" &&
    typeof cycle.toolSumMs === "number" &&
    typeof cycle.overheadMs === "number" &&
    Array.isArray(cycle.tools)
  );
}

export function persistedCycles(branch: readonly SessionEntry[]): PersistedCycle[] {
  const cycles: PersistedCycle[] = [];
  for (const entry of branch) {
    if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
    if (isPersistedCycle(entry.data)) cycles.push(entry.data);
  }
  return cycles;
}

export function mergedIntervalDuration(
  intervals: ReadonlyArray<{ startOffsetMs: number; endOffsetMs: number }>,
): number {
  if (intervals.length === 0) return 0;
  const sorted = intervals
    .map(({ startOffsetMs, endOffsetMs }) => ({
      start: Math.min(startOffsetMs, endOffsetMs),
      end: Math.max(startOffsetMs, endOffsetMs),
    }))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  let total = 0;
  let start = sorted[0].start;
  let end = sorted[0].end;
  for (const interval of sorted.slice(1)) {
    if (interval.start <= end) {
      end = Math.max(end, interval.end);
    } else {
      total += end - start;
      start = interval.start;
      end = interval.end;
    }
  }
  return total + end - start;
}

export function totalToolCalls(stats: Map<string, ToolStat>): number {
  let total = 0;
  for (const stat of stats.values()) total += stat.count;
  return total;
}

export function cycleTps(cycle: PersistedCycle): number | undefined {
  if (!cycle.generationMs || cycle.generationMs <= 0 || cycle.outputTokens <= 0) return undefined;
  return cycle.outputTokens / (cycle.generationMs / 1000);
}

export function aggregateToolTimings(
  cycles: readonly PersistedCycle[],
  counts: Map<string, ToolStat>,
): Map<string, ToolTimingStat> {
  const aggregate = new Map<string, ToolTimingStat>();
  for (const [name, stat] of counts) {
    aggregate.set(name, { ...stat, timedCount: 0, totalMs: 0, maxMs: 0 });
  }
  for (const cycle of cycles) {
    for (const tool of cycle.tools) {
      const stat = aggregate.get(tool.name) ?? {
        count: 0,
        errors: 0,
        timedCount: 0,
        totalMs: 0,
        maxMs: 0,
      };
      stat.timedCount++;
      stat.totalMs += tool.durationMs;
      stat.maxMs = Math.max(stat.maxMs, tool.durationMs);
      aggregate.set(tool.name, stat);
    }
  }
  return aggregate;
}
