/**
 * Tool Set Extension
 *
 * One owner for pi's active tool set, combining what used to be two extensions
 * fighting over `setActiveTools`:
 *
 *   /tools          view which tools are active, read-only (viewer.ts)
 *   /safe /yolo     YOLO/SAFE mode + shift+tab             (mode.ts)
 *   change_mode     model-initiated escalation request     (change-mode-tool.ts)
 *
 * SAFE mode *removes* write/edit/bash and any MCP tool not marked read-only
 * from the active set, and adds the read-only search tools. Mode is in-memory only and the selection is
 * re-adopted from whatever pi has active fresh every session — there is no
 * user-editable selection UI to persist a choice from, see viewer.ts and
 * state.ts for why.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { registerToolGuard } from "../shared/tool-guard.ts";
import { registerChangeModeTool } from "./change-mode-tool.ts";
import { registerMode } from "./mode.ts";
import { registerSafeContext } from "./safe-context.ts";
import { CHANGE_MODE_TOOL, createToolSet } from "./state.ts";
import { publishToolSet } from "./service.ts";
import { registerViewer } from "./viewer.ts";

export default function toolSetExtension(pi: ExtensionAPI) {
  const toolSet = createToolSet(pi);
  const unpublish = publishToolSet(toolSet);
  pi.on("session_shutdown", async () => unpublish());

  const applyStatus = registerMode(pi, toolSet);
  registerChangeModeTool(pi, toolSet);
  registerSafeContext(pi, toolSet);
  registerViewer(pi, toolSet);

  // Removing tools keeps them out of the model's available tool set. This
  // guard is the enforcement layer: it also covers codemode scripts, which call
  // tools regardless of the active set, and any tool another extension re-adds.
  // `tools: []` (every tool) rather than a blocked-tool snapshot:
  // other extensions can extend the blocked tools after this factory has already
  // run (e.g. from their own session_start, via toolSet.addBlockedTools()),
  // so the check has to read the Set live rather than a copy taken now.
  registerToolGuard(pi, [
    {
      tools: [],
      check: (event) =>
        toolSet.getMode() === "safe" && toolSet.isBlockedInSafe(event.toolName)
          ? {
            action: "block",
            reason: `Blocked by safe mode: ${event.toolName} is disabled. Use /yolo or /auto to restore access.`,
          }
          : undefined,
    },
    {
      tools: [CHANGE_MODE_TOOL],
      check: () =>
        toolSet.getMode() === "yolo"
          ? {
            action: "block",
            reason: `${CHANGE_MODE_TOOL} is only available in safe mode — yolo is already the highest permission level.`,
          }
          : undefined,
    },
  ]);

  const startSession = async (_event: unknown, ctx: ExtensionContext) => {
    toolSet.beginSession();
    toolSet.adoptHostSelection();
    applyStatus(ctx);
  };

  pi.on("session_start", startSession);
  pi.on("session_tree", startSession);
}
