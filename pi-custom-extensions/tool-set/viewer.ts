/** Read-only `/tools` registry viewer. Exposure is distinct from active declarations. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ToolSet } from "./state.ts";
import { groupTools, toolDisplayName, toolStatus } from "./viewer-model.ts";

export function registerViewer(pi: ExtensionAPI, toolSet: ToolSet) {
	pi.registerCommand("tools", {
		description: "View tools grouped by kind and MCP server, with activation/exposure status (read-only)",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/tools requires TUI mode", "error");
				return;
			}

			const allTools = pi.getAllTools();
			const active = new Set(pi.getActiveTools());
			const sections = groupTools(allTools, active);

			await ctx.ui.custom((tui, theme, _kb, done) => {
				const nameWidth = Math.min(45, Math.max(4, ...allTools.map((tool) => toolDisplayName(tool).length)));
				let offset = 0;
				let pageSize = 1;
				const totalRows = sections.reduce((sum, section) => sum + 1 + section.tools.length, 0);
				return {
					render(width: number) {
						const rows = sections.flatMap((section) => [
							theme.fg("dim", theme.bold(`── ${section.title} ──`)),
							...section.tools.map((tool) => {
								const status = toolStatus(tool, active, toolSet);
								const columns = Math.max(4, Math.min(nameWidth, width - status.label.length - 6));
								const name = truncateToWidth(toolDisplayName(tool), columns, "…", true);
								return `  ${name}  ${theme.fg(status.color, status.label)}`;
							}),
						]);
						pageSize = Math.max(1, tui.terminal.rows - 8);
						offset = Math.min(offset, Math.max(0, rows.length - pageSize));
						const innerWidth = Math.max(1, width - 2);
						const frame = (line: string) => {
							const fitted = truncateToWidth(line, innerWidth, "", true);
							return (
								theme.fg("border", "│") +
								fitted +
								" ".repeat(Math.max(0, innerWidth - visibleWidth(fitted))) +
								theme.fg("border", "│")
							);
						};
						const content = [
							theme.fg("accent", theme.bold("Tools")) +
								theme.fg("dim", `  (${toolSet.getMode().toUpperCase()} mode — /safe /yolo to change)`),
							"",
							...rows.slice(offset, offset + pageSize),
							"",
							theme.fg("dim", "  Deferred: discover via tool_search or codemode · Loaded: active declaration"),
							theme.fg("dim", "  Unregistered/disabled servers: /mcp · j/k to scroll · Esc to close"),
						];
						return [
							theme.fg("border", `╭${"─".repeat(innerWidth)}╮`),
							...content.map(frame),
							theme.fg("border", `╰${"─".repeat(innerWidth)}╯`),
						];
					},
					invalidate: () => {},
					handleInput(data: string) {
						if (matchesKey(data, "escape") || data === "q" || data === "h") done(undefined);
						else {
							if (data === "k" || matchesKey(data, "up")) offset--;
							else if (data === "j" || matchesKey(data, "down")) offset++;
							offset = Math.max(0, Math.min(offset, Math.max(0, totalRows - pageSize)));
							tui.requestRender();
						}
					},
				};
			});
		},
	});
}
