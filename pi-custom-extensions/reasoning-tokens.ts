import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_ID = "reasoning-tokens";
const LIVE_EVENT = "reasoning-tokens:live";

function formatTokens(count: number): string {
  if (count < 1000) return `${count}`;
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

export default function reasoningTokensExtension(pi: ExtensionAPI) {
  let liveTokens: number | undefined;
  let lastReported: number | undefined;

  function refreshStatus(ctx: ExtensionContext) {
    let total = 0;
    let reported = false;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message" || entry.message.role !== "assistant") continue;
      const reasoning = (entry.message as AssistantMessage).usage.reasoning;
      if (reasoning === undefined) continue;
      total += reasoning;
      reported = true;
    }
    if (liveTokens !== undefined) {
      total += liveTokens;
      reported = true;
    }
    ctx.ui.setStatus(STATUS_ID, reported ? ctx.ui.theme.fg("accent", `\u{F135E} ${formatTokens(total)}`) : undefined);
  }

  pi.on("session_start", async (_event, ctx) => {
    liveTokens = undefined;
    lastReported = undefined;
    refreshStatus(ctx);
  });

  pi.on("turn_start", async () => {
    liveTokens = undefined;
    lastReported = undefined;
  });

  pi.on("message_update", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const reasoning = (event.message as AssistantMessage).usage.reasoning;
    if (reasoning === undefined || reasoning === lastReported) return;
    lastReported = reasoning;
    liveTokens = reasoning;
    pi.events.emit(LIVE_EVENT, { tokens: reasoning });
    refreshStatus(ctx);
  });

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const reasoning = (event.message as AssistantMessage).usage.reasoning;
    if (reasoning !== undefined) pi.events.emit(LIVE_EVENT, { tokens: reasoning });
    liveTokens = undefined;
    lastReported = undefined;
    refreshStatus(ctx);
  });

  pi.on("turn_end", async (_event, ctx) => refreshStatus(ctx));
  pi.on("session_shutdown", async (_event, ctx) => {
    liveTokens = undefined;
    lastReported = undefined;
    ctx.ui.setStatus(STATUS_ID, undefined);
  });
}
