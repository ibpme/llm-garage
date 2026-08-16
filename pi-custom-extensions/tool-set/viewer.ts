/**
 * The `/tools` viewer — read-only.
 *
 * Shows every registered tool and whether it's currently active. Not
 * editable: what's active is fully determined by /safe /yolo mode plus
 * whatever each extension does on its own (e.g. ssh.ts's /ssh command) —
 * see state.ts. An editable selection here previously meant two competing
 * sources of truth (the user's picks vs. the mode mask), which was the
 * root of several staleness bugs. Reading pi.getActiveTools() directly has
 * none of that: it's always exactly what's real right now.
 *
 * Grouped into four non-overlapping sections — Builtins, Remote, then
 * Active/Inactive for everything else — rather than one flat list, so
 * "is this a core tool or an extension one" doesn't get lost among
 * one-off tools like change_mode. Builtins/Remote each show active/
 * inactive per item instead of being split further, since which of those
 * happen to be active is exactly the thing worth seeing grouped by kind.
 * Active/inactive is also color-coded (success/dim) as a visual cue, not
 * just the text label.
 *
 * A plain static list, not pi-tui's SettingsList: SettingsList always
 * appends its own "Enter/Space to change · Esc to cancel" hint line
 * regardless of whether items have `values` to cycle through, with no way
 * to suppress or override that hint's content — misleading on a view with
 * nothing to change. Since there's no toggling, selection cursor, or
 * scrolling need here either, a plain list is both correct and simpler.
 */

import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ToolSet } from "./state.ts";

// Canonical names, not sourceInfo: stylish-tools.ts re-registers these as
// its own extension-owned tools, so pi's loader stamps sourceInfo.source as
// "local" for them same as everything else (see mode.ts's comment on the
// same problem) — name is the only reliable signal left for "is this one
// of the core tools" once an extension has re-styled them.
const BUILTIN_TOOL_NAMES = ["read", "write", "edit", "bash", "grep", "ls", "find"];

function isRemoteToolName(name: string): boolean {
	return name.endsWith("_remote");
}

export function registerViewer(pi: ExtensionAPI, toolSet: ToolSet) {
	pi.registerCommand("tools", {
		description: "View available tools, grouped by kind, and whether each is currently active (read-only)",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/tools requires TUI mode", "error");
				return;
			}

			const allTools = pi.getAllTools();
			const active = new Set(pi.getActiveTools());

			const builtins = allTools.filter((tool) => BUILTIN_TOOL_NAMES.includes(tool.name));
			const remote = allTools.filter((tool) => isRemoteToolName(tool.name));
			const other = allTools.filter((tool) => !BUILTIN_TOOL_NAMES.includes(tool.name) && !isRemoteToolName(tool.name));
			const otherActive = other.filter((tool) => active.has(tool.name));
			const otherInactive = other.filter((tool) => !active.has(tool.name));

			await ctx.ui.custom((_tui, theme, _kb, done) => {
				const nameWidth = Math.min(30, Math.max(4, ...allTools.map((tool) => tool.name.length)));

				// Same reasoning as before: baked directly into the string so it
				// survives regardless of surrounding styling — a color set
				// closest to the text wins (theme.fg only resets the foreground).
				function statusText(isActive: boolean): string {
					return isActive ? theme.fg("success", "active") : theme.fg("dim", "inactive");
				}

				function section(title: string, tools: ToolInfo[]): string[] {
					if (tools.length === 0) return [];
					return [
						theme.fg("dim", theme.bold(`── ${title} ──`)),
						...tools.map((tool) => `  ${tool.name.padEnd(nameWidth)}  ${statusText(active.has(tool.name))}`),
					];
				}

				const lines = [
					theme.fg("accent", theme.bold("Tools")) +
						theme.fg("dim", `  (${toolSet.getMode() === "safe" ? "SAFE" : "YOLO"} mode — /safe /yolo to change)`),
					"",
					...section("Builtins", builtins),
					...section("Remote", remote),
					...section("Active", otherActive),
					...section("Inactive", otherInactive),
					"",
					theme.fg("dim", "  Esc to close"),
				];

				return {
					render: (width: number) => lines.map((line) => truncateToWidth(line, width, "", true)),
					invalidate: () => {},
					handleInput(data: string) {
						if (data === "\x1b" || data === "q" || data === "h") done(undefined);
					},
				};
			});
		},
	});
}
