/**
 * Tool Set Extension
 *
 * One owner for pi's active tool set, combining what used to be two extensions
 * fighting over `setActiveTools`:
 *
 *   /tools          pick which tools are available     (picker.ts)
 *   /safe /yolo     YOLO/SAFE mode + shift+tab         (mode.ts)
 *   change_mode     model-initiated escalation request (change-mode-tool.ts)
 *
 * SAFE mode *removes* write/edit/bash from the active set and adds the
 * read-only search tools. Mode is in-memory only and starts as YOLO on every
 * session; the tool selection persists per session branch.
 *
 * See state.ts for why selection and mode are modelled separately.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerToolGuard } from "../shared/tool-guard.ts";
import { registerChangeModeTool } from "./change-mode-tool.ts";
import { registerMode } from "./mode.ts";
import { persistSelection, restoreSelection } from "./persistence.ts";
import { registerPicker } from "./picker.ts";
import { registerSafeContext } from "./safe-context.ts";
import { BLOCKED_TOOLS, CHANGE_MODE_TOOL, createToolSet, type ToolSet } from "./state.ts";

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
	registerPicker(pi, toolSet, () => persistSelection(pi, toolSet));

	// Removing tools keeps them out of the model's available tool set. This
	// guard remains the enforcement layer if another extension re-adds one.
	registerToolGuard(pi, [
		{
			tools: [...BLOCKED_TOOLS],
			check: (event) =>
				toolSet.getMode() === "safe"
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

	const startSession = async (
		_event: unknown,
		ctx: Parameters<typeof applyStatus>[0],
	) => {
		toolSet.beginSession();
		restoreSelection(pi, toolSet, ctx);
		applyStatus(ctx);
	};

	pi.on("session_start", startSession);
	pi.on("session_tree", startSession);
}
