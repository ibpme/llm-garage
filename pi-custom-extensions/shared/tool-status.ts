import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";

const MAX_SHOWN = 6;

export function toolStatuses(pi: ExtensionAPI, theme: Theme): { tools: string; mcp: string | undefined } {
	const all = pi.getAllTools();
	const active = pi.getActiveTools();
	const builtins = new Set(all.filter((tool) => tool.sourceInfo.source === "builtin").map((tool) => tool.name));
	const local = active.filter((name) => !name.startsWith("mcp__"));
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
	return { tools: format("tools", ordered), mcp: entries.length ? format("mcp", entries) : undefined };
}
