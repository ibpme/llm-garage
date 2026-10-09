/**
 * The single owner of pi's active tool set.
 *
 * Two things want to change which tools are active: extension-driven selection
 * (for example, `/ssh`) and the YOLO/SAFE mode mask. Modelling them as one
 * mutable list forces every writer to reconstruct the other's intent. Here they
 * are separate:
 *
 *   effective = mask(selection, mode)
 *
 * `selection` is the user's intent and is never touched by mode changes, so
 * leaving SAFE restores exactly what was selected before -- no bookkeeping of
 * "tools removed by SAFE" is needed. `pi.setActiveTools` is called from one
 * place, `apply()`.
 *
 * Pi itself activates tools outside this module: built-in MCP activates
 * `direct` tools when a server connects, and `tool_search` declares matches.
 * Any tool that appears active without having been applied here since the last
 * apply is absorbed into `selection`, so the next mode change keeps it.
 */

import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";

import type { Mode, ToolSet } from "./contracts.ts";

/** Removed from the active set while SAFE. */
const DEFAULT_BLOCKED_TOOLS = ["write", "edit", "bash"] as const;
/** Read-only search tools added while SAFE. */
const SAFE_EXTRA_TOOLS = ["grep", "find", "ls"] as const;
export const CHANGE_MODE_TOOL = "change_mode";
/** Only ever active while SAFE; stripped from the effective set in YOLO. */
const SAFE_ONLY_TOOLS = new Set<string>([
  ...SAFE_EXTRA_TOOLS,
  CHANGE_MODE_TOOL,
]);

const MCP_TOOL_PREFIX = "mcp__";

function isBlockedInSafe(name: string, tools: readonly ToolInfo[], blockedTools: ReadonlySet<string>): boolean {
  if (blockedTools.has(name)) return true;
  if (!name.startsWith(MCP_TOOL_PREFIX)) return false;
  const tool = tools.find((candidate) => candidate.name === name);
  return tool?.annotations?.readOnlyHint !== true;
}

export function createToolSet(pi: ExtensionAPI): ToolSet {
  const blockedTools = new Set<string>(DEFAULT_BLOCKED_TOOLS);
  let mode: Mode = "yolo";
  let selection: string[] = [];
  /** Exactly what apply() last passed to pi.setActiveTools(). */
  let lastApplied = new Set<string>();
  const listeners = new Set<() => void>();

  function mask(): string[] {
    if (mode === "yolo") {
      return selection.filter((name) => !SAFE_ONLY_TOOLS.has(name));
    }

    const tools = pi.getAllTools();
    const available = new Set(tools.map((tool) => tool.name));
    const kept = selection.filter((name) => !isBlockedInSafe(name, tools, blockedTools));
    const extras = [...SAFE_ONLY_TOOLS].filter((name) => available.has(name));
    return [...new Set([...kept, ...extras])];
  }

  /**
   * Adopt tools that pi activated since our last apply (MCP direct tools,
   * tool_search matches). Names we applied and then saw removed are not
   * re-adopted, so a selection change such as ssh's deactivation sticks.
   */
  function absorbExternalActivations() {
    for (const name of pi.getActiveTools()) {
      if (lastApplied.has(name) || SAFE_ONLY_TOOLS.has(name)) continue;
      if (!selection.includes(name)) selection.push(name);
    }
  }

  function apply(absorb = true) {
    if (absorb) absorbExternalActivations();
    const next = mask();
    pi.setActiveTools(next);
    lastApplied = new Set(next);
    for (const listener of listeners) listener();
  }

  function switchMode(next: Mode) {
    mode = next;
    apply();
  }

  return {
    getMode: () => mode,

    setMode: switchMode,

    toggleMode() {
      switchMode(mode === "safe" ? "yolo" : "safe");
    },

    beginSession() {
      mode = "yolo";
      selection = [];
      lastApplied = new Set();
    },

    getSelection() {
      absorbExternalActivations();
      return [...selection];
    },

    setSelection(names) {
      // Explicit names win: do not absorb, or a tool the caller just left out
      // would be re-adopted from the active set.
      selection = [...new Set(names)];
      apply(false);
    },

    adoptHostSelection() {
      // Safe-only tools may already be active -- registered during startup or
      // restored by another extension -- and must not leak into the selection,
      // or YOLO would keep re-adding them.
      selection = pi
        .getActiveTools()
        .filter((name) => !SAFE_ONLY_TOOLS.has(name));
      apply();
    },

    addBlockedTools(names) {
      // Deliberately does NOT call apply(): callers (e.g. SSH integration) do this
      // from their own session_start, which may run before this extension's
      // own session_start has restored the selection. Applying an empty
      // `selection` there makes adoptHostSelection()'s "seed from what pi
      // has active" fallback adopt that empty result, silently zeroing the
      // tool set for the session. mask() reads blockedTools live, so the
      // next real apply() picks these up anyway.
      for (const name of names) blockedTools.add(name);
    },

    isBlockedInSafe(name) {
      return isBlockedInSafe(name, pi.getAllTools(), blockedTools);
    },

    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
