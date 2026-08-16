/**
 * The `change_mode` tool.
 *
 * Lets the model ask the user for permission to leave SAFE mode when it needs
 * write, edit, or bash access. Only ever registered as active while SAFE (see
 * state.ts SAFE_ONLY_TOOLS).
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { CHANGE_MODE_TOOL, type ToolSet } from "./state.ts";

const SAFE_MODE_GUIDELINES = [
	"SAFE mode is active: write, edit, and bash are unavailable. Do not attempt to call them.",
	'Use change_mode with mode "yolo" when write, edit, or bash access is required.',
];

interface ChangeModeResult {
	approved: boolean;
}

function errorResult(text: string) {
	return {
		content: [{ type: "text" as const, text }],
		details: { approved: false } satisfies ChangeModeResult,
	};
}

export function registerChangeModeTool(pi: ExtensionAPI, toolSet: ToolSet) {
	pi.registerTool({
		name: CHANGE_MODE_TOOL,
		label: "Change Mode",
		description:
			"Request user approval to switch from SAFE to YOLO mode when more tool access is needed.",
		promptSnippet:
			"Request user approval to switch from safe mode to yolo mode when more tool access is needed",
		promptGuidelines: SAFE_MODE_GUIDELINES,
		parameters: Type.Object({
			mode: StringEnum(["yolo"] as const, {
				description: "Target mode to switch to.",
			}),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return errorResult("Error: user approval is unavailable without a UI");
			}
			if (toolSet.getMode() !== "safe") {
				return errorResult("Error: change_mode is only available in safe mode");
			}

			const approved = await ctx.ui.confirm(
				"Allow mode change?",
				"The agent requests switching from SAFE to YOLO mode, which restores write, edit, and bash access.",
			);

			if (approved) {
				toolSet.setMode(params.mode);
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
}
