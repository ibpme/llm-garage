/**
 * Mode commands, shortcut, and status indicator.
 *
 * Owns how the user drives YOLO/SAFE and how the current mode is displayed.
 * All state lives in the ToolSet; this module only reads it.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { ToolSet } from "./state.ts";

/**
 * Published as two entries so a custom footer can place the badge on its own
 * line while the tool list stays in the generic extension-status line.
 * status-line.ts hoists MODE_STATUS_ID; everything else falls through.
 */
const MODE_STATUS_ID = "mode";
const TOOLS_STATUS_ID = "tools";
const MAX_TOOLS_SHOWN = 6;

function formatTools(pi: ExtensionAPI, ctx: ExtensionContext): string {
  const { theme } = ctx.ui;
  const active = pi.getActiveTools();
  if (active.length === 0) return theme.fg("dim", "none");

  // Pi builtins first (in their original order), then everything else
  // (extension/SDK-registered tools), so the always-present core tools
  // aren't pushed out of view by the "+N" overflow when the list is long.
  const builtinNames = new Set(
    pi
      .getAllTools()
      .filter((tool) => tool.sourceInfo.source === "builtin")
      .map((tool) => tool.name),
  );
  const tools = [
    ...active.filter((name) => builtinNames.has(name)),
    ...active.filter((name) => !builtinNames.has(name)),
  ];

  let text = theme.fg("muted", tools.slice(0, MAX_TOOLS_SHOWN).join(", "));
  if (tools.length > MAX_TOOLS_SHOWN) {
    text += theme.fg("dim", `, +${tools.length - MAX_TOOLS_SHOWN}`);
  }
  return text;
}

function modeLabel(toolSet: ToolSet, ctx: ExtensionContext): string {
  const { theme } = ctx.ui;
  const badge =
    toolSet.getMode() === "safe"
      ? theme.bold(theme.fg("success", "● SAFE"))
      : theme.bold(theme.fg("error", "⏵⏵ YOLO"));

  return badge + theme.fg("dim", " (shift+tab)");
}

function toolsLabel(pi: ExtensionAPI, ctx: ExtensionContext): string {
  return ctx.ui.theme.fg("dim", "tools:") + formatTools(pi, ctx);
}

export function registerMode(pi: ExtensionAPI, toolSet: ToolSet) {
  /**
   * `ctx` is only available inside handlers, so the status can only be
   * repainted from one. Keep the most recent one and refresh whenever the tool
   * set changes -- including changes driven by /tools or the change_mode tool.
   */
  let lastCtx: ExtensionContext | undefined;

  function applyStatus(ctx: ExtensionContext) {
    lastCtx = ctx;
    ctx.ui.setStatus(MODE_STATUS_ID, modeLabel(toolSet, ctx));
    ctx.ui.setStatus(TOOLS_STATUS_ID, toolsLabel(pi, ctx));
  }

  toolSet.onChange(() => {
    if (lastCtx) applyStatus(lastCtx);
  });

  pi.registerCommand("safe", {
    description: "Enable safe mode (removes write/edit/bash, adds grep/find/ls)",
    handler: async (_args, ctx) => {
      toolSet.setMode("safe");
      applyStatus(ctx);
    },
  });

  pi.registerCommand("yolo", {
    description: "Disable safe mode (restore prior tool access)",
    handler: async (_args, ctx) => {
      toolSet.setMode("yolo");
      applyStatus(ctx);
    },
  });

  pi.registerCommand("auto", {
    description: "Disable safe mode (alias for /yolo)",
    handler: async (_args, ctx) => {
      toolSet.setMode("yolo");
      applyStatus(ctx);
    },
  });

  // The built-in thinking cycle is remapped to shift+right in
  // ~/.pi/agent/keybindings.json, leaving shift+tab available here.
  pi.registerShortcut("shift+tab", {
    description: "Toggle YOLO/SAFE mode",
    handler: async (ctx) => {
      toolSet.toggleMode();
      applyStatus(ctx);
    },
  });

  return applyStatus;
}
