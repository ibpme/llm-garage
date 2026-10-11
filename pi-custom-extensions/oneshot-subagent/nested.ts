import type { NestedRun, RunDetails } from "./events.ts";

const MAX_RUNS = 32;
const MAX_LEVELS = 16;
const MAX_TEXT = 256 * 1024;

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value && typeof value === "object" ? value as ObjectValue : {};
const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

/** Bound persisted display snapshots independently of the complete JSONL logs. */
function bounded(runs: NestedRun[]): { children: NestedRun[]; childrenOmitted: number } {
  let nodes = MAX_RUNS;
  let remainingText = MAX_TEXT;
  const copy = (source: unknown[], level: number, reserved = 0): { children: NestedRun[]; childrenOmitted: number } => {
    const children: NestedRun[] = [];
    const length = Math.min(source.length, MAX_RUNS);
    let childrenOmitted = source.length - length;
    for (let index = 0; index < length; index++) {
      if (nodes <= reserved || level > MAX_LEVELS) { childrenOmitted++; continue; }
      const value = object(source[index]);
      if (typeof value.toolCallId !== "string") continue;
      nodes--;
      let displayTruncated = value.displayTruncated === true;
      const text = (input: unknown, limit: number): string => {
        if (typeof input !== "string") return "";
        const length = Math.min(limit, remainingText);
        const result = input.slice(0, length);
        remainingText -= result.length;
        if (result.length < input.length) displayTruncated = true;
        return result;
      };
      const child: NestedRun = {
        usagePartial: value.usagePartial === true ? true : undefined,
        agent: value.agent === "pi" || value.agent === "claude" ? value.agent : undefined,
        toolCallId: value.toolCallId.slice(0, 256), name: text(value.name, 64), task: text(value.task, 16 * 1024),
        cwd: text(value.cwd, 4096), model: text(value.model, 256) || undefined,
        status: ["running", "success", "error", "aborted"].includes(String(value.status)) ? value.status as RunDetails["status"] : "running",
        activity: Array.isArray(value.activity) ? value.activity.slice(-80).map((line) => text(line, 180)) : [],
        preview: text(value.preview, 2000), turns: count(value.turns), toolCalls: count(value.toolCalls), durationMs: count(value.durationMs),
      };
      for (const key of ["exitCode", "totalTokens", "costUsd", "depth", "maxDepth"] as const)
        if (typeof value[key] === "number") child[key] = count(value[key]);
      if (typeof value.jobDir === "string") child.jobDir = text(value.jobDir, 4096);
      if (typeof value.result === "string") child.result = text(value.result, 40 * 1024);
      if (Array.isArray(value.children)) {
        const nested = copy(value.children, level + 1, reserved + length - index - 1);
        child.children = nested.children;
        child.childrenOmitted = nested.childrenOmitted + count(value.childrenOmitted);
      }
      child.displayTruncated = displayTruncated;
      children.push(child);
    }
    return { children, childrenOmitted };
  };
  return copy(runs, 1);
}

export function updateNested(parent: RunDetails, toolCallId: string, args?: unknown, result?: unknown, isError?: boolean): void {
  if (!toolCallId) return;
  const children = parent.children ?? [];
  const previous = children.find((child) => child.toolCallId === toolCallId);
  // Ignore updates to omitted calls, without counting every streamed update as
  // another omission. Start events are the sole source of the omitted count.
  if (!previous && children.length >= MAX_RUNS) {
    if (args !== undefined && result === undefined) parent.childrenOmitted = (parent.childrenOmitted ?? 0) + 1;
    return;
  }
  const input = object(args);
  const outcome = object(result);
  const snapshot = object(outcome.details);
  const child: NestedRun = {
    agent: input.agent === "claude" ? "claude" : "pi",
    toolCallId, name: typeof input.name === "string" ? input.name : "subagent",
    task: typeof input.task === "string" ? input.task : "", cwd: typeof input.cwd === "string" ? input.cwd : parent.cwd,
    model: typeof input.model === "string" ? input.model : parent.model,
    status: "running", activity: [], preview: "", turns: 0, toolCalls: 0, durationMs: 0,
    depth: parent.depth === undefined ? undefined : parent.depth + 1, maxDepth: parent.maxDepth,
    ...previous,
    ...snapshot,
  } as NestedRun;
  // Correlation is owned by the event, not by untrusted tool-result details.
  child.toolCallId = toolCallId;
  if (isError !== undefined) {
    if (isError) child.status = child.status === "aborted" ? "aborted" : "error";
    else if (child.status === "running") child.status = "success";
    if (typeof snapshot.result !== "string") {
      child.result = Array.isArray(outcome.content) ? outcome.content
        .map((raw) => object(raw)).filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => (block.text as string).slice(0, 40 * 1024)).join("\n").slice(0, 40 * 1024) : "";
    }
  }
  const next = previous ? children.map((entry) => entry.toolCallId === toolCallId ? child : entry) : [...children, child];
  const normalized = bounded(next);
  parent.children = normalized.children;
  parent.childrenOmitted = (parent.childrenOmitted ?? 0) + normalized.childrenOmitted;
}

export function settleNested(parent: RunDetails): void {
  parent.children = parent.children?.map((child) => {
    const next = { ...child };
    if (child.status === "running") {
      next.status = parent.status === "aborted" ? "aborted" : "error";
      next.result = parent.status === "aborted" ? "Parent delegation was cancelled." : "Parent delegation ended before a final nested result was received.";
    }
    settleNested(next);
    return next;
  });
}
