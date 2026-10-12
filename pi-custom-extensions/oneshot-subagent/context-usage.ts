import type { ContextWindowTable } from "../shared/agent-jobs/store.ts";
import type { ContextWindowResolver } from "./context-window.ts";
import type { RunDetails } from "./events.ts";

export type Tone = "dim" | "warning" | "error";
export interface ContextSegment { text: string; tone: Tone }

export function formatTokens(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 999_950) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

// Snapshot of the latest completed model call: its input plus cache reads and writes.
// Output and cumulative run usage are excluded.
export function contextSegment(details: Pick<RunDetails, "latestCallUsage" | "contextWindow">): ContextSegment | undefined {
  const usage = details.latestCallUsage;
  if (!usage) return undefined;
  const used = usage.input + usage.cacheRead + usage.cacheWrite;
  const capacity = details.contextWindow;
  if (capacity === undefined || !Number.isFinite(capacity) || capacity <= 0)
    return { text: `context ${formatTokens(used)} / unknown`, tone: "dim" };
  // Integer comparisons keep the 70% and 90% boundaries exact; the percentage is floored so it agrees with the tone.
  const tone: Tone = used * 10 >= capacity * 9 ? "error" : used * 10 >= capacity * 7 ? "warning" : "dim";
  return { text: `context ${formatTokens(used)} / ${formatTokens(capacity)} · ${Math.floor(used * 100 / capacity)}%`, tone };
}

// Pure counterpart of contextWindowResolver for the detached supervisor, which cannot load Pi's model registry.
export function contextWindowLookup(table: ContextWindowTable | undefined): ContextWindowResolver | undefined {
  if (!table?.length) return undefined;
  const windows = new Map(table.map(([provider, model, window]) => [JSON.stringify([provider, model]), window]));
  return (provider, model) => {
    const window = windows.get(JSON.stringify([provider, model]));
    return typeof window === "number" && Number.isFinite(window) && window > 0 ? window : undefined;
  };
}
