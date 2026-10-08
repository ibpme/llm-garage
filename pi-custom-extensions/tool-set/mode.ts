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
import type { Mode, ToolSet } from "./state.ts";
import { toolStatuses } from "../shared/tool-status.ts";

/**
 * Published as two entries so a custom footer can place the badge on its own
 * line while the tool list stays in the generic extension-status line.
 * status-line.ts hoists MODE_STATUS_ID; everything else falls through.
 */
const MODE_STATUS_ID = "mode";
const TOOLS_STATUS_ID = "tools";
const MCP_STATUS_ID = "mcp-tools";

const MODE_COMMANDS: { name: string; description: string; mode: Mode }[] = [
	{
		name: "safe",
		description: "Enable safe mode (removes write/edit/bash and non-read-only MCP tools, adds grep/find/ls)",
		mode: "safe",
	},
	{
		name: "yolo",
		description: "Disable safe mode (restore prior tool access)",
		mode: "yolo",
	},
	{
		name: "auto",
		description: "Disable safe mode (alias for /yolo)",
		mode: "yolo",
	},
];

function modeLabel(toolSet: ToolSet, ctx: ExtensionContext): string {
	const { theme } = ctx.ui;
	const badge =
		toolSet.getMode() === "safe"
			? theme.bold(theme.fg("success", "● SAFE"))
			: theme.bold(theme.fg("error", "⏵⏵ YOLO"));

	return badge;
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
		const statuses = toolStatuses(pi, ctx.ui.theme);
		ctx.ui.setStatus(TOOLS_STATUS_ID, statuses.tools);
		ctx.ui.setStatus(MCP_STATUS_ID, statuses.mcp);
	}

	toolSet.onChange(() => {
		if (lastCtx) applyStatus(lastCtx);
	});

	for (const { name, description, mode } of MODE_COMMANDS) {
		pi.registerCommand(name, {
			description,
			handler: async (_args, ctx) => {
				toolSet.setMode(mode);
				applyStatus(ctx);
			},
		});
	}

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
