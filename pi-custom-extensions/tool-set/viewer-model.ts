import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import type { ToolSet } from "./state.ts";

const BUILTIN_TOOL_NAMES = new Set(["read", "write", "edit", "bash", "grep", "ls", "find"]);

export interface ToolSection {
	title: string;
	tools: ToolInfo[];
}

export function mcpServer(tool: ToolInfo): string | undefined {
	if (!tool.name.startsWith("mcp__")) return undefined;
	return tool.namespace?.name.replace(/^mcp__/, "") ?? /^mcp__(.+?)__/.exec(tool.name)?.[1];
}

export function toolDisplayName(tool: ToolInfo): string {
	return mcpServer(tool) === undefined ? tool.name : tool.name.replace(/^mcp__.+?__/, "");
}

export function groupTools(tools: ToolInfo[], active: ReadonlySet<string>): ToolSection[] {
	const builtins: ToolInfo[] = [];
	const remote: ToolInfo[] = [];
	const otherActive: ToolInfo[] = [];
	const otherInactive: ToolInfo[] = [];
	const servers = new Map<string, ToolInfo[]>();
	for (const tool of tools) {
		const server = mcpServer(tool);
		if (server !== undefined) {
			const group = servers.get(server) ?? [];
			group.push(tool);
			servers.set(server, group);
		} else if (BUILTIN_TOOL_NAMES.has(tool.name)) builtins.push(tool);
		else if (tool.name.endsWith("_remote")) remote.push(tool);
		else (active.has(tool.name) ? otherActive : otherInactive).push(tool);
	}
	return [
		{ title: "Builtins", tools: builtins },
		{ title: "Remote", tools: remote },
		...Array.from(servers).sort(([a], [b]) => a.localeCompare(b)).map(([server, tools]) => ({
			title: `MCP · ${server}`,
			tools: tools.sort((a, b) => a.name.localeCompare(b.name)),
		})),
		{ title: "Active", tools: otherActive },
		{ title: "Inactive", tools: otherInactive },
	].filter((section) => section.tools.length > 0);
}

export function toolStatus(
	tool: ToolInfo,
	active: ReadonlySet<string>,
	toolSet: Pick<ToolSet, "getMode" | "isBlockedInSafe">,
): { label: string; color: "success" | "dim" | "warning" } {
	if (tool.exposure === "hidden") return { label: "disabled (hidden)", color: "dim" };
	if (toolSet.getMode() === "safe" && toolSet.isBlockedInSafe(tool.name)) {
		return { label: "disabled (SAFE)", color: "warning" };
	}
	if (active.has(tool.name)) {
		const loaded = tool.exposure === "deferred" || tool.exposure === "codemode";
		return { label: loaded ? `active (loaded · ${tool.exposure})` : "active", color: "success" };
	}
	if (tool.exposure === "codemode") return { label: "codemode", color: "success" };
	if (tool.exposure === "deferred") return { label: "deferred", color: "dim" };
	return { label: mcpServer(tool) === undefined ? "inactive" : "disabled (inactive)", color: "dim" };
}
