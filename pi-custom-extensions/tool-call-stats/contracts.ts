export const ENTRY_VERSION = 1;

export type GeneratedDeltaType = "text_delta" | "thinking_delta" | "toolcall_delta";

export interface ToolStat {
  count: number;
  errors: number;
}

interface ToolTiming {
  name: string;
  startOffsetMs: number;
  endOffsetMs: number;
  durationMs: number;
  isError: boolean;
}

export interface PersistedCycle {
  version: typeof ENTRY_VERSION;
  turnIndex: number;
  startedAt: number;
  provider?: string;
  model?: string;
  stopReason?: string;
  providerAttempts: number;
  outputTokens: number;
  ttftMs?: number;
  generationMs?: number;
  elapsedMs: number;
  toolWallMs: number;
  toolSumMs: number;
  overheadMs: number;
  tools: ToolTiming[];
}

interface ActiveTool {
  name: string;
  startedAt: number;
  startOffsetMs: number;
}

export type CyclePhase = "waiting" | "thinking" | "responding" | "preparing-tools" | "tools";

export interface ActiveCycle {
  turnIndex: number;
  startedAt: number;
  startedWallTime: number;
  phase: CyclePhase;
  providerRequestAt?: number;
  firstGeneratedAt?: number;
  generationEndedAt?: number;
  providerAttempts: number;
  tools: ToolTiming[];
  activeTools: Map<string, ActiveTool>;
  reasoningTokens?: number;
}

export interface ToolTimingStat extends ToolStat {
  timedCount: number;
  totalMs: number;
  maxMs: number;
}
