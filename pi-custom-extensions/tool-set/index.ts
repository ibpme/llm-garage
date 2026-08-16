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
 * SAFE mode *removes* write/edit/bash from the active set and adds the
 * read-only search tools. Mode is in-memory only and the selection is
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
import { BLOCKED_TOOLS, CHANGE_MODE_TOOL, createToolSet, type ToolSet } from "./state.ts";
import { registerViewer } from "./viewer.ts";

/**
 * The running ToolSet instance, for other extensions (e.g. ssh.ts) that need
 * to add/remove tools from the user's selection without fighting this
 * extension over `pi.setActiveTools`.
 *
 * Stored on globalThis rather than a plain module-level variable: pi loads
 * extensions via jiti with `moduleCache: false`, so a separately-loaded
 * extension's own `import ... from "./tool-set/index.ts"` gets its own
 * fresh copy of this module (a different `sharedToolSet` binding) rather
 * than the instance pi actually invoked as the "tool-set" extension. A
 * `Symbol.for` key on the process-wide globalThis is the one thing every
 * copy of this module actually shares.
 */
const TOOL_SET_GLOBAL_KEY = Symbol.for("llm-garage.pi-custom-extensions.tool-set");

export function getToolSet(): ToolSet {
	const toolSet = (globalThis as Record<symbol, unknown>)[TOOL_SET_GLOBAL_KEY] as ToolSet | undefined;
	if (!toolSet) throw new Error("tool-set extension has not loaded yet");
	return toolSet;
}

export default function toolSetExtension(pi: ExtensionAPI) {
	const toolSet = createToolSet(pi);
	(globalThis as Record<symbol, unknown>)[TOOL_SET_GLOBAL_KEY] = toolSet;

	const applyStatus = registerMode(pi, toolSet);
	registerChangeModeTool(pi, toolSet);
	registerSafeContext(pi, toolSet);
	registerViewer(pi, toolSet);

	// Removing tools keeps them out of the model's available tool set. This
	// guard remains the enforcement layer if another extension re-adds one.
	// `tools: []` (every tool) rather than a `[...BLOCKED_TOOLS]` snapshot:
	// other extensions can extend BLOCKED_TOOLS after this factory has already
	// run (e.g. from their own session_start, via toolSet.addBlockedTools()),
	// so the check has to read the Set live rather than a copy taken now.
	registerToolGuard(pi, [
		{
			tools: [],
			check: (event) =>
				toolSet.getMode() === "safe" && BLOCKED_TOOLS.has(event.toolName)
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
