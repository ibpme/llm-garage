/**
 * Mode Extension
 *
 * Toggle between Pi's normal unrestricted tool set and a read-only tool set.
 * Safe mode removes write, edit, and bash from the active tool set, adds the
 * read-only search tools, and lets the model request user approval to return
 * to YOLO mode.
 *
 * Mode is in-memory only and starts as YOLO on a fresh session.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

type Mode = "yolo" | "safe";

const BLOCKED_TOOLS = new Set(["write", "edit", "bash"]);
const SAFE_EXTRA_TOOLS = new Set(["grep", "find", "ls"]);
const CHANGE_MODE_TOOL = "change_mode";
const STATUS_ID = "mode";
const SAFE_MODE_CUSTOM_TYPE = "safe-mode-context";

function safeModeReminder(): string {
  return `
<system-reminder>
  [SAFE MODE ACTIVE]
  The write, edit, and bash tools are not currently in your active toolset — they have been removed, not just blocked.
  Do not attempt to call them; retrying will not surface new information. grep, find, and ls are available in their place for read-only search and inspection.
  If a change is needed, call the change_mode tool with mode: "yolo" to request full tool access. The user can also run /yolo, /auto, or press shift+tab directly at any time.
</system-reminder>
`;
}

interface ChangeModeResult {
  approved: boolean;
}

export default function (pi: ExtensionAPI) {
  let mode: Mode = "yolo";
  let preSafeTools: string[] | null = null;

  function formatTools(ctx: ExtensionContext, max = 6): string {
    const { theme } = ctx.ui;
    const tools = pi.getActiveTools();
    if (tools.length === 0) return theme.fg("dim", "none");

    const shown = tools.slice(0, max);
    let text = theme.fg("muted", shown.join(", "));
    if (tools.length > max) {
      text += theme.fg("dim", `, +${tools.length - max}`);
    }
    return text;
  }

  function statusLabel(ctx: ExtensionContext): string {
    const { theme } = ctx.ui;
    const modeLabel =
      mode === "safe"
        ? theme.bold(theme.fg("success", "⏸ SAFE"))
        : theme.bold(theme.fg("error", "⏵⏵ YOLO"));

    return [
      modeLabel + theme.fg("text", "\t(shift+tab to toggle)"),
      theme.fg("dim", "tools:") + formatTools(ctx),
    ].join(theme.fg("dim", " · "));
  }

  function applyStatus(ctx: ExtensionContext) {
    ctx.ui.setStatus(STATUS_ID, statusLabel(ctx));
  }

  function setMode(next: Mode, ctx: ExtensionContext) {
    if (next === mode) return;

    if (next === "safe") {
      preSafeTools = pi.getActiveTools();
      const kept = preSafeTools.filter((name) => !BLOCKED_TOOLS.has(name));
      const available = new Set(pi.getAllTools().map((tool) => tool.name));
      const extras = [...SAFE_EXTRA_TOOLS, CHANGE_MODE_TOOL].filter(
        (name) => available.has(name) && !kept.includes(name),
      );
      pi.setActiveTools([...new Set([...kept, ...extras])]);
    } else if (preSafeTools) {
      // Preserve non-mode tool changes made while SAFE was active (for
      // example through /tools), while restoring tools removed by SAFE.
      const modeOnlyTools = new Set([...SAFE_EXTRA_TOOLS, CHANGE_MODE_TOOL]);
      const current = pi
        .getActiveTools()
        .filter((name) => !modeOnlyTools.has(name));
      const restored = preSafeTools.filter(
        (name) => BLOCKED_TOOLS.has(name) && !current.includes(name),
      );
      pi.setActiveTools([...new Set([...current, ...restored])]);
      preSafeTools = null;
    }

    mode = next;
    applyStatus(ctx);
  }

  pi.registerTool({
    name: CHANGE_MODE_TOOL,
    label: "Change Mode",
    description:
      "Request user approval to switch from SAFE to YOLO mode when more tool access is needed.",
    promptSnippet:
      "Request user approval to switch from safe mode to yolo mode when more tool access is needed",
    promptGuidelines: [
      "Use change_mode when SAFE mode lacks write, edit, or bash access required for the task.",
    ],
    parameters: Type.Object({
      mode: StringEnum(["yolo"] as const, {
        description: "Target mode to switch to.",
      }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        return {
          content: [
            {
              type: "text",
              text: "Error: user approval is unavailable without a UI",
            },
          ],
          details: { approved: false } satisfies ChangeModeResult,
        };
      }
      if (mode !== "safe") {
        return {
          content: [
            {
              type: "text",
              text: "Error: change_mode is only available in safe mode",
            },
          ],
          details: { approved: false } satisfies ChangeModeResult,
        };
      }

      const approved = await ctx.ui.confirm(
        "Allow mode change?",
        "The agent requests switching from SAFE to YOLO mode, which restores write, edit, and bash access.",
      );

      if (approved) {
        setMode(params.mode, ctx);
      }

      const text = approved
        ? "User approved switching to YOLO mode. The updated tool set is available on the next model request."
        : "User denied switching to YOLO mode; remaining in SAFE mode.";

      return {
        content: [{ type: "text", text }],
        details: { approved } satisfies ChangeModeResult,
      };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("Change Mode"));
      text += theme.fg("muted", ` SAFE → ${args.mode.toUpperCase()}`);
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const details = result.details as ChangeModeResult | undefined;
      if (!details) {
        const first = result.content[0];
        return new Text(first?.type === "text" ? first.text : "", 0, 0);
      }

      return new Text(
        details.approved
          ? theme.fg("success", "✓ Approved")
          : theme.fg("warning", "✗ Denied — staying SAFE"),
        0,
        0,
      );
    },
  });

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

  // The built-in thinking cycle is remapped to shift+right in
  // ~/.pi/agent/keybindings.json, leaving shift+tab available here.
  pi.registerShortcut("shift+tab", {
    description: "Toggle YOLO/SAFE mode",
    handler: async (ctx) => setMode(mode === "safe" ? "yolo" : "safe", ctx),
  });

  pi.on("session_start", async (_event, ctx) => {
    mode = "yolo";
    preSafeTools = null;

    // change_mode is safe-mode-only. Remove it if registration made it active
    // before this session-start handler ran.
    const active = pi.getActiveTools();
    if (active.includes(CHANGE_MODE_TOOL)) {
      pi.setActiveTools(active.filter((name) => name !== CHANGE_MODE_TOOL));
    }
    applyStatus(ctx);
  });

  // Removing tools keeps them out of the model's available tool set. This
  // guard remains the enforcement layer if another extension re-adds one.
  pi.on("tool_call", async (event) => {
    if (mode === "safe" && BLOCKED_TOOLS.has(event.toolName)) {
      return {
        block: true,
        reason: `Blocked by safe mode: ${event.toolName} is disabled. Use /yolo or /auto to restore access.`,
      };
    }
    if (mode === "yolo" && event.toolName === CHANGE_MODE_TOOL) {
      return {
        block: true,
        reason: `${CHANGE_MODE_TOOL} is only available in safe mode — yolo is already the highest permission level.`,
      };
    }
    return undefined;
  });

  // The active tool list normally communicates this state. This additional
  // context is useful when the user toggles mode while an agent run is active.
  pi.on("context", async (event) => {
    const messages = event.messages.filter(
      (message) =>
        (message as AgentMessage & { customType?: string }).customType !==
        SAFE_MODE_CUSTOM_TYPE,
    );
    const staleMessageRemoved = messages.length !== event.messages.length;

    if (mode !== "safe") {
      return staleMessageRemoved ? { messages } : undefined;
    }

    return {
      messages: [
        ...messages,
        {
          role: "user",
          customType: SAFE_MODE_CUSTOM_TYPE,
          content: safeModeReminder(),
          display: false,
          timestamp: Date.now(),
        },
      ],
    };
  });

  pi.on("turn_start", async (_event, ctx) => {
    applyStatus(ctx);
  });
}
