export type Agent = "pi" | "claude";
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = typeof EFFORT_LEVELS[number];

interface Selection {
  agent?: Agent;
  model?: string;
  provider?: string;
  thinking?: string;
  effort?: Effort;
}
interface Parent { model?: { id: string; provider: string }; thinkingLevel?: string }

export function resolveBackend(selection: Selection, parent: Parent = {}) {
  const agent = selection.agent ?? "pi";
  if (selection.effort && selection.thinking && selection.effort !== selection.thinking)
    throw new Error("effort and thinking must agree when both are provided");
  const level = selection.effort ?? selection.thinking;
  if (agent === "pi") {
    if (selection.provider && !selection.model) throw new Error("provider requires an explicit model");
    return { agent, model: selection.model ?? parent.model?.id,
      provider: selection.model ? selection.provider : parent.model?.provider,
      thinking: level ?? (selection.model ? undefined : parent.thinkingLevel), effort: undefined };
  }
  // Pi accepts model:thinking. Normalize that convenience syntax for Claude,
  // whose CLI takes the model and effort separately. Explicit levels win.
  const suffix = selection.model?.match(/:(off|minimal|low|medium|high|xhigh|max)$/);
  const effort = level ?? suffix?.[1];
  if (effort && !EFFORT_LEVELS.includes(effort as Effort))
    throw new Error("Claude effort off/minimal have no exact equivalent; use low, medium, high, xhigh, or max");
  return { agent, model: suffix ? selection.model!.slice(0, -suffix[0].length) : selection.model,
    provider: undefined, thinking: undefined, effort: effort as Effort | undefined };
}
