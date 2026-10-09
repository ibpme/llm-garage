import { ENTRY_VERSION } from "./contracts.ts";
import { REASONING_TOKENS_LIVE_EVENT, isReasoningTokensLivePayload } from "../contracts/events.ts";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext
} from "@earendil-works/pi-coding-agent";
import { openPager, textSource } from "../shared/pager.ts";
import {
  computeToolStats,
  ENTRY_TYPE,
  mergedIntervalDuration,
  now,
  persistedCycles,
} from "./accounting.ts";
import type { ActiveCycle, GeneratedDeltaType, PersistedCycle } from "./contracts.ts";
import { formatDetail, formatLiveCounter, formatLiveTokens, phaseLabel, statusText } from "./formatting.ts";

const STATUS_ID = "agent-stats";

const LEGACY_STATUS_ID = "tool-calls";

const STATUS_REFRESH_MS = 250;

export default function agentStatsExtension(pi: ExtensionAPI) {
  let activeCycle: ActiveCycle | undefined;
  let liveTimer: ReturnType<typeof setInterval> | undefined;

  function branchStats(ctx: ExtensionContext) {
    const branch = ctx.sessionManager.getBranch();
    return {
      cycles: persistedCycles(branch),
      tools: computeToolStats(branch),
    };
  }

  function refreshStatus(ctx: ExtensionContext) {
    if (activeCycle) {
      ctx.ui.setStatus(STATUS_ID, undefined);
      return;
    }
    const stats = branchStats(ctx);
    ctx.ui.setStatus(STATUS_ID, statusText(ctx, stats.cycles, stats.tools));
  }

  function refreshWorkingMessage(ctx: ExtensionContext) {
    if (!activeCycle || activeCycle.phase === "tools") return;
    const reasoning = activeCycle.phase === "thinking" && activeCycle.reasoningTokens !== undefined
      ? ` · ↓${formatLiveTokens(activeCycle.reasoningTokens)}`
      : "";
    ctx.ui.setWorkingMessage(
      `${phaseLabel(activeCycle.phase)} ${formatLiveCounter(now() - activeCycle.startedAt)}${reasoning}`,
    );
  }

  function stopLiveTimer() {
    if (liveTimer) clearInterval(liveTimer);
    liveTimer = undefined;
  }

  function startLiveTimer(ctx: ExtensionContext) {
    stopLiveTimer();
    refreshWorkingMessage(ctx);
    liveTimer = setInterval(() => refreshWorkingMessage(ctx), STATUS_REFRESH_MS);
    liveTimer.unref?.();
  }

  const unsubscribeReasoning = pi.events.on(REASONING_TOKENS_LIVE_EVENT, (data) => {
    if (!activeCycle || !isReasoningTokensLivePayload(data)) return;
    activeCycle.reasoningTokens = data.tokens;
  });

  pi.on("session_start", async (_event, ctx) => {
    activeCycle = undefined;
    stopLiveTimer();
    ctx.ui.setWorkingMessage();
    ctx.ui.setStatus(LEGACY_STATUS_ID, undefined);
    refreshStatus(ctx);
  });

  pi.on("turn_start", async (event, ctx) => {
    activeCycle = {
      turnIndex: event.turnIndex,
      startedAt: now(),
      startedWallTime: Date.now(),
      phase: "waiting",
      providerAttempts: 0,
      tools: [],
      activeTools: new Map(),
    };
    refreshStatus(ctx);
    startLiveTimer(ctx);
  });

  pi.on("before_provider_request", async (_event, ctx) => {
    if (!activeCycle || activeCycle.firstGeneratedAt !== undefined) return;
    activeCycle.providerRequestAt = now();
    activeCycle.providerAttempts++;
    activeCycle.phase = "waiting";
    refreshWorkingMessage(ctx);
  });

  pi.on("message_update", async (event, ctx) => {
    if (!activeCycle) return;
    const streamEvent = event.assistantMessageEvent;
    const current = now();
    let phaseChanged = false;
    if (
      activeCycle.firstGeneratedAt === undefined &&
      (["text_delta", "thinking_delta", "toolcall_delta"] as GeneratedDeltaType[]).includes(
        streamEvent.type as GeneratedDeltaType,
      )
    ) {
      activeCycle.firstGeneratedAt = current;
    }

    if (streamEvent.type === "thinking_start" || streamEvent.type === "thinking_delta") {
      phaseChanged = activeCycle.phase !== "thinking";
      activeCycle.phase = "thinking";
    } else if (streamEvent.type === "text_start" || streamEvent.type === "text_delta") {
      phaseChanged = activeCycle.phase !== "responding";
      activeCycle.phase = "responding";
    } else if (
      streamEvent.type === "toolcall_start" ||
      streamEvent.type === "toolcall_delta" ||
      streamEvent.type === "toolcall_end"
    ) {
      phaseChanged = activeCycle.phase !== "preparing-tools";
      activeCycle.phase = "preparing-tools";
    }

    if (streamEvent.type === "done" || streamEvent.type === "error") {
      activeCycle.generationEndedAt = current;
    }
    if (phaseChanged) refreshWorkingMessage(ctx);
  });

  pi.on("message_end", async (event, _ctx) => {
    if (!activeCycle || event.message.role !== "assistant") return;
    activeCycle.generationEndedAt ??= now();
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    if (!activeCycle) return;
    const startedAt = now();
    activeCycle.activeTools.set(event.toolCallId, {
      name: event.toolName,
      startedAt,
      startOffsetMs: startedAt - activeCycle.startedAt,
    });
    if (activeCycle.phase !== "tools") {
      activeCycle.phase = "tools";
      stopLiveTimer();
      ctx.ui.setWorkingMessage();
    }
  });

  pi.on("tool_execution_end", async (event, _ctx) => {
    if (!activeCycle) return;
    const tool = activeCycle.activeTools.get(event.toolCallId);
    if (tool) {
      const endedAt = now();
      activeCycle.tools.push({
        name: tool.name,
        startOffsetMs: tool.startOffsetMs,
        endOffsetMs: endedAt - activeCycle.startedAt,
        durationMs: endedAt - tool.startedAt,
        isError: event.isError,
      });
      activeCycle.activeTools.delete(event.toolCallId);
    }
  });

  pi.on("turn_end", async (event, ctx) => {
    if (!activeCycle) return;
    const endedAt = now();

    for (const tool of activeCycle.activeTools.values()) {
      activeCycle.tools.push({
        name: tool.name,
        startOffsetMs: tool.startOffsetMs,
        endOffsetMs: endedAt - activeCycle.startedAt,
        durationMs: endedAt - tool.startedAt,
        isError: true,
      });
    }
    activeCycle.activeTools.clear();

    const assistant = event.message.role === "assistant" ? (event.message as AssistantMessage) : undefined;
    const elapsedMs = endedAt - activeCycle.startedAt;
    const generationMs =
      activeCycle.firstGeneratedAt !== undefined && activeCycle.generationEndedAt !== undefined
        ? Math.max(0, activeCycle.generationEndedAt - activeCycle.firstGeneratedAt)
        : undefined;
    const ttftMs =
      activeCycle.providerRequestAt !== undefined && activeCycle.firstGeneratedAt !== undefined
        ? Math.max(0, activeCycle.firstGeneratedAt - activeCycle.providerRequestAt)
        : undefined;
    const toolWallMs = mergedIntervalDuration(activeCycle.tools);
    const toolSumMs = activeCycle.tools.reduce((sum, tool) => sum + tool.durationMs, 0);
    const overheadMs = Math.max(0, elapsedMs - (generationMs ?? 0) - toolWallMs);

    const persisted: PersistedCycle = {
      version: ENTRY_VERSION,
      turnIndex: activeCycle.turnIndex,
      startedAt: activeCycle.startedWallTime,
      provider: assistant?.provider,
      model: assistant?.responseModel ?? assistant?.model,
      stopReason: assistant?.stopReason,
      providerAttempts: activeCycle.providerAttempts,
      outputTokens: assistant?.usage.output ?? 0,
      ttftMs,
      generationMs,
      elapsedMs,
      toolWallMs,
      toolSumMs,
      overheadMs,
      tools: activeCycle.tools,
    };

    pi.appendEntry(ENTRY_TYPE, persisted);
    activeCycle = undefined;
    stopLiveTimer();
    ctx.ui.setWorkingMessage();
    refreshStatus(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    unsubscribeReasoning();
    activeCycle = undefined;
    stopLiveTimer();
    ctx.ui.setWorkingMessage();
  });

  pi.registerCommand("agent-stats", {
    description: "Show model performance, timing, and tool usage for the active conversation branch",
    handler: async (_args, ctx) => {
      const stats = branchStats(ctx);
      const text = formatDetail(stats.cycles, stats.tools, ctx.ui.theme);
      await openPager(ctx, {
        title: "Agent Stats",
        source: textSource(text),
        plainText: text,
      });
    },
  });
}
