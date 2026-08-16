/**
 * Session persistence for the tool selection.
 *
 * Stores the *selection* rather than the effective tool set, so a selection
 * saved while SAFE was active does not silently drop write/edit/bash when the
 * branch is restored in YOLO.
 *
 * The `tools-config` customType is kept from the previous standalone /tools
 * extension so existing session files still restore.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { ToolSet } from "./state.ts";

const CUSTOM_TYPE = "tools-config";

interface ToolsState {
	enabledTools: string[];
}

/** Append the current selection to the session so branch navigation can restore it. */
export function persistSelection(pi: ExtensionAPI, toolSet: ToolSet): void {
	pi.appendEntry<ToolsState>(CUSTOM_TYPE, {
		enabledTools: toolSet.getSelection(),
	});
}

/**
 * Apply the last selection recorded on the current branch, falling back to
 * whatever pi already has active. Either path ends with the tool set applied.
 */
export function restoreSelection(
	pi: ExtensionAPI,
	toolSet: ToolSet,
	ctx: ExtensionContext,
): void {
	let saved: string[] | undefined;

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom" && entry.customType === CUSTOM_TYPE) {
			const data = entry.data as ToolsState | undefined;
			if (data?.enabledTools) saved = data.enabledTools;
		}
	}

	if (!saved) {
		toolSet.adoptHostSelection();
		return;
	}

	const known = new Set(pi.getAllTools().map((tool) => tool.name));
	toolSet.setSelection(saved.filter((name) => known.has(name)));
}
