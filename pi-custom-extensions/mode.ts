/**
 * Mode Extension
 *
 * Simple safe/yolo mode toggle. Pi's default is unrestricted ("yolo"):
 * full tool access, no gating beyond whatever other extensions add. /safe
 * removes write, edit, and bash from the active toolset entirely (not just
 * a runtime block, so the model never sees them as callable), and adds
 * grep/find/ls in their place (pi's read-only equivalents, not part of the
 * default coding toolset) so the model can still search and inspect the
 * filesystem. /yolo or /auto (identical aliases) restore whatever toolset
 * was active before /safe was invoked.
 *
 * Mode is in-memory only and always starts as yolo on a fresh session.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

type Mode = "yolo" | "safe";

const BLOCKED_TOOLS = new Set(["write", "edit", "bash"]);
const SAFE_EXTRA_TOOLS = new Set(["grep", "find", "ls"]);
const STATUS_ID = "mode";
const SAFE_MODE_CUSTOM_TYPE = "safe-mode-context";

function safeModeReminder(): string {
  return `[SAFE MODE ACTIVE]
The write, edit, and bash tools are not currently in your active toolset — they have been removed, not just blocked. Do not attempt to call them; retrying will not surface new information.
grep, find, and ls are available in their place for read-only search and inspection.
If a change is needed, describe what you would do and ask the user to run /yolo, /auto, or press shift+tab to restore full tool access — you cannot exit safe mode yourself.`;
}

export default function (pi: ExtensionAPI) {
  let mode: Mode = "yolo";
  // Snapshot of active tools from just before entering safe mode, so
  // leaving safe mode restores whatever was actually active (e.g. if
  // /tools had already disabled some tools) rather than assuming "all".
  let preSafeTools: string[] | null = null;

  // SAFE reads as green/reassuring (restricted, low risk); YOLO reads as
  // red/attention (unrestricted, the actually risky state) — a persistent
  // reminder of which one you're in, not just a toggle confirmation.
  function statusLabel(ctx: ExtensionContext): string {
    const { theme } = ctx.ui;
    return mode === "safe"
      ? theme.bold(theme.fg("success", "⏸ SAFE")) +
          theme.fg("text", "\t(shift+tab to cycle)")
      : theme.bold(theme.fg("error", "⏵⏵ YOLO")) +
          theme.fg("text", "\t(shift+tab to cycle)");
  }

  function applyStatus(ctx: ExtensionContext) {
    ctx.ui.setStatus(STATUS_ID, statusLabel(ctx));
  }

  function setMode(next: Mode, ctx: ExtensionContext) {
    if (next === mode) return;

    if (next === "safe") {
      preSafeTools = pi.getActiveTools();
      const kept = preSafeTools.filter((name) => !BLOCKED_TOOLS.has(name));
      const available = new Set(pi.getAllTools().map((t) => t.name));
      const extras = [...SAFE_EXTRA_TOOLS].filter(
        (name) => available.has(name) && !kept.includes(name),
      );
      pi.setActiveTools([...kept, ...extras]);
    } else if (preSafeTools) {
      pi.setActiveTools(preSafeTools);
      preSafeTools = null;
    }

    mode = next;
    applyStatus(ctx);
    const NOTIFY = false;
    if (NOTIFY) {
      ctx.ui.notify(
        mode === "safe"
          ? "Safe mode on: write, edit, and bash are unavailable; grep, find, and ls are enabled"
          : "Yolo mode on: full tool access restored",
        mode === "safe" ? "info" : "warning",
      );
    }
  }

  pi.registerCommand("safe", {
    description:
      "Enable safe mode (removes write/edit/bash, adds grep/find/ls)",
    handler: async (_args, ctx) => setMode("safe", ctx),
  });

  pi.registerCommand("yolo", {
    description: "Disable safe mode (restore prior tool access)",
    handler: async (_args, ctx) => setMode("yolo", ctx),
  });

  pi.registerCommand("auto", {
    description: "Disable safe mode (alias for /yolo)",
    handler: async (_args, ctx) => setMode("yolo", ctx),
  });

  // Requires "app.thinking.cycle" freed in ~/.pi/agent/keybindings.json,
  // otherwise this is silently dropped as a reserved-key conflict.
  pi.registerShortcut("shift+tab", {
    description: "Toggle YOLO/SAFE mode",
    handler: async (ctx) => setMode(mode === "safe" ? "yolo" : "safe", ctx),
  });

  // Show the mode label from the start of every session, not just after
  // the first toggle.
  pi.on("session_start", async (_event, ctx) => {
    mode = "yolo";
    preSafeTools = null;
    applyStatus(ctx);
  });

  // Defense-in-depth: if the tool is somehow still reachable (e.g. another
  // extension re-adds it while safe mode is on), still refuse to run it.
  pi.on("tool_call", async (event) => {
    if (mode === "safe" && BLOCKED_TOOLS.has(event.toolName)) {
      return {
        block: true,
        reason: `Blocked by safe mode: ${event.toolName} is disabled. Use /yolo or /auto to restore access.`,
      };
    }
    return undefined;
  });

  // Proactive signal: unlike tool_call's block+reason (only fires after
  // the model has already tried and failed a blocked call), this runs on
  // every LLM call — including mid-turn, e.g. right after shift+tab flips
  // mode while the agent loop is still going — so the model has standing
  // knowledge that write/edit/bash are gone before it ever attempts them.
  // Never persisted to session history (context hook output isn't written
  // back), so the filter below is defensive, not load-bearing.
  pi.on("context", async (event) => {
    const withoutStale = event.messages.filter(
      (m) =>
        (m as AgentMessage & { customType?: string }).customType !==
        SAFE_MODE_CUSTOM_TYPE,
    );
    if (mode !== "safe") return { messages: withoutStale };
    return {
      messages: [
        ...withoutStale,
        {
          role: "custom",
          customType: SAFE_MODE_CUSTOM_TYPE,
          content: safeModeReminder(),
          display: false,
          timestamp: Date.now(),
        },
      ],
    };
  });
}
