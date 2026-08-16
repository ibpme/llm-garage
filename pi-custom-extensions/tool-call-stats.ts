/**
 * Tool Call Stats Extension
 *
 * Tracks tool call counts and errors, derived from the session branch
 * (assistant `toolCall` parts + `toolResult` messages), grouped by turn
 * (one turn = one user message through the next). Adds `/tool-call-detail`
 * to view the breakdown and a status-line entry showing current-turn and
 * session totals.
 */
import type {
	AssistantMessage,
} from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { openPager, textSource } from "./shared/pager.ts";

const STATUS_ID = "tool-calls";

interface ToolStat {
	count: number;
	errors: number;
}

interface TurnStats {
	turnNumber: number;
	tools: Map<string, ToolStat>;
	total: number;
}

interface Stats {
	turns: TurnStats[];
	overall: Map<string, ToolStat>;
}

function bump(map: Map<string, ToolStat>, name: string, isErrorOnly: boolean) {
	const stat = map.get(name) ?? { count: 0, errors: 0 };
	if (isErrorOnly) {
		stat.errors++;
	} else {
		stat.count++;
	}
	map.set(name, stat);
}

function computeStats(branch: readonly SessionEntry[]): Stats {
	const overall = new Map<string, ToolStat>();
	const turns: TurnStats[] = [];
	const toolNameByCallId = new Map<string, string>();
	let current: TurnStats | undefined;

	function ensureTurn(): TurnStats {
		if (!current) {
			current = { turnNumber: turns.length + 1, tools: new Map(), total: 0 };
			turns.push(current);
		}
		return current;
	}

	for (const entry of branch) {
		if (entry.type !== "message") continue;
		const message = entry.message;

		if (message.role === "user") {
			current = { turnNumber: turns.length + 1, tools: new Map(), total: 0 };
			turns.push(current);
		} else if (message.role === "assistant") {
			const assistant = message as AssistantMessage;
			for (const part of assistant.content) {
				if (part.type !== "toolCall") continue;
				toolNameByCallId.set(part.id, part.name);
				const turn = ensureTurn();
				bump(turn.tools, part.name, false);
				turn.total++;
				bump(overall, part.name, false);
			}
		} else if (message.role === "toolResult" && message.isError) {
			const name = toolNameByCallId.get(message.toolCallId) ?? message.toolName;
			const turn = ensureTurn();
			bump(turn.tools, name, true);
			bump(overall, name, true);
		}
	}

	return { turns, overall };
}

function sessionTotal(overall: Map<string, ToolStat>): number {
	let total = 0;
	for (const stat of overall.values()) total += stat.count;
	return total;
}

function formatTable(tools: Map<string, ToolStat>, theme: Theme): string[] {
	if (tools.size === 0) return [theme.fg("dim", "  (none)")];

	const entries = Array.from(tools.entries()).sort((a, b) => b[1].count - a[1].count);
	const nameWidth = Math.max(4, ...entries.map(([name]) => name.length));

	const lines = entries.map(([name, stat]) => {
		const namePart = theme.fg("accent", name.padEnd(nameWidth));
		const countPart = theme.fg("text", `calls: ${stat.count}`.padEnd(12));
		const errorsPart =
			stat.errors > 0 ? theme.fg("error", `errors: ${stat.errors}`) : "";
		return `  ${namePart}  ${countPart}${errorsPart}`;
	});

	return lines;
}

function formatDetail(stats: Stats, theme: Theme): string {
	const lines: string[] = [];
	const total = sessionTotal(stats.overall);

	lines.push(
		theme.fg("text", "Total tool calls: ") +
			theme.fg("accent", `${total}`) +
			theme.fg("text", " across ") +
			theme.fg("accent", `${stats.overall.size}`) +
			theme.fg("text", " tool(s)"),
	);
	lines.push("");
	lines.push(theme.bold(theme.fg("accent", "By tool (whole conversation):")));
	lines.push(...formatTable(stats.overall, theme));

	for (const turn of stats.turns) {
		if (turn.total === 0) continue;
		lines.push("");
		lines.push(
			theme.bold(theme.fg("accent", `Turn ${turn.turnNumber}`)) +
				theme.fg("dim", ` (${turn.total} call${turn.total === 1 ? "" : "s"}):`),
		);
		lines.push(...formatTable(turn.tools, theme));
	}

	return lines.join("\n");
}

const MAX_STATUS_TOOLS_SHOWN = 4;

function formatBreakdown(tools: Map<string, ToolStat>, theme: Theme): string {
	if (tools.size === 0) return theme.fg("dim", "none");

	const entries = Array.from(tools.entries()).sort((a, b) => b[1].count - a[1].count);
	const shown = entries
		.slice(0, MAX_STATUS_TOOLS_SHOWN)
		.map(
			([name, stat]) =>
				theme.fg("accent", name) +
				theme.fg("dim", "×") +
				theme.fg(stat.errors > 0 ? "error" : "muted", `${stat.count}`),
		)
		.join(theme.fg("dim", ", "));
	const overflow = entries.length - MAX_STATUS_TOOLS_SHOWN;

	return overflow > 0 ? `${shown}${theme.fg("dim", `, +${overflow}`)}` : shown;
}

function formatStatus(ctx: ExtensionContext, stats: Stats): string {
	const { theme } = ctx.ui;
	const total = sessionTotal(stats.overall);
	const currentTurn = stats.turns[stats.turns.length - 1];
	const breakdown = formatBreakdown(currentTurn?.tools ?? new Map(), theme);

	return (
		theme.fg("dim", "tool-call(s): ") +
		breakdown +
		theme.fg("dim", " (") +
		theme.fg("warning", `${total}`) +
		theme.fg("dim", " total)")
	);
}

export default function toolCallStatsExtension(pi: ExtensionAPI) {
	function refresh(ctx: ExtensionContext) {
		const stats = computeStats(ctx.sessionManager.getBranch());
		ctx.ui.setStatus(STATUS_ID, formatStatus(ctx, stats));
	}

	pi.on("session_start", async (_event, ctx) => refresh(ctx));
	pi.on("turn_start", async (_event, ctx) => refresh(ctx));
	pi.on("tool_execution_end", async (_event, ctx) => refresh(ctx));

	pi.registerCommand("tool-call-detail", {
		description: "Show tool call counts and errors, overall and per turn",
		handler: async (_args, ctx) => {
			const stats = computeStats(ctx.sessionManager.getBranch());
			const text = formatDetail(stats, ctx.ui.theme);

			await openPager(ctx, {
				title: "Tool Call Detail",
				source: textSource(text),
				plainText: text,
			});
		},
	});
}
