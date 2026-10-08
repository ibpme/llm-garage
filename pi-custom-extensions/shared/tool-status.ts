import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";

import { rgbColor } from "@earendil-works/pi-tui";

const SEARCH_COLOR = rgbColor(106, 169, 255);
const CODEMODE_COLOR = rgbColor(245, 158, 66);
const MAX_SHOWN = 6;
const MCP_RESOURCE_TOOLS = new Set([
	"list_mcp_resources",
	"list_mcp_resource_templates",
	"read_mcp_resource",
]);

export function toolStatuses(pi: ExtensionAPI, theme: Theme): { tools: string; mcp: string; indicators: string } {
	const all = pi.getAllTools();
	const active = pi.getActiveTools();
	const builtins = new Set(all.filter((tool) => tool.sourceInfo.source === "builtin").map((tool) => tool.name));
	const local = active.filter((name) => !name.startsWith("mcp__") && !MCP_RESOURCE_TOOLS.has(name) && name !== "tool_search" && name !== "codemode");
	const ordered = [...local.filter((name) => builtins.has(name)), ...local.filter((name) => !builtins.has(name))];
	const format = (prefix: string, entries: string[]) =>
		theme.fg("dim", `${prefix}:`) + theme.fg("muted", entries.slice(0, MAX_SHOWN).join(", ") || "none") +
		(entries.length > MAX_SHOWN ? theme.fg("dim", `, +${entries.length - MAX_SHOWN}`) : "");

	// Active declarations alone miss codemode and deferred MCP tools. Counts
	// describe the non-hidden registry, not declarations or SAFE permissions.
	const servers = new Map<string, number>();
	for (const tool of all) {
		if (!tool.name.startsWith("mcp__") || tool.exposure === "hidden") continue;
		const server = tool.namespace?.name.replace(/^mcp__/, "") ?? /^mcp__(.+?)__/.exec(tool.name)?.[1];
		if (server) servers.set(server, (servers.get(server) ?? 0) + 1);
	}
	const entries = [...servers].sort(([a], [b]) => a.localeCompare(b)).map(([server, count]) => `${server} (${count})`);
	// The command exists even with no servers or exposed tools. Do not infer
	// extension availability from resource helpers or loaded server tools.
	const mcpActive = pi.getCommands().some((command) => command.name === "mcp" && command.source === "extension");
	const indicator = theme.fg(mcpActive ? "success" : "dim", "󰌘");
	const badge = indicator + " " + theme.fg("dim", "mcp: ");
	const details = entries.length
		? theme.fg("muted", entries.slice(0, MAX_SHOWN).join(" ")) +
			(entries.length > MAX_SHOWN ? theme.fg("dim", ` +${entries.length - MAX_SHOWN}`) : "")
		: theme.fg("dim", "none");
	const searchIndicator = active.includes("tool_search")
		? theme.style("󰍉", { fg: SEARCH_COLOR }) + " "
		: "";
	const indicators = active.includes("codemode")
		? theme.style("  codemode", { fg: CODEMODE_COLOR })
		: theme.fg("dim", "  codemode");
	return { tools: searchIndicator + format("tools", ordered), mcp: badge + details, indicators };
}
