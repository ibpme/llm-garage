/**
 * Agent Stats Extension
 *
 * Tracks model latency/throughput, active processing time, and tool usage for
 * every Pi model cycle. Finalized timing records are persisted as branch-aware
 * custom session entries. Adds `/agent-stats` and a live footer status.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { openPager, textSource } from "./shared/pager.ts";

const STATUS_ID = "agent-stats";
const LEGACY_STATUS_ID = "tool-calls";
const ENTRY_TYPE = "agent-stats-cycle";
const ENTRY_VERSION = 1;
const STATUS_REFRESH_MS = 250;

type GeneratedDeltaType = "text_delta" | "thinking_delta" | "toolcall_delta";

interface ToolStat {
	count: number;
	errors: number;
}

interface ToolTiming {
	name: string;
	startOffsetMs: number;
	endOffsetMs: number;
	durationMs: number;
	isError: boolean;
}

interface PersistedCycle {
	version: typeof ENTRY_VERSION;
	turnIndex: number;
	startedAt: number;
	provider?: string;
	model?: string;
	stopReason?: string;
	providerAttempts: number;
	outputTokens: number;
	ttftMs?: number;
	generationMs?: number;
	elapsedMs: number;
	toolWallMs: number;
	toolSumMs: number;
	overheadMs: number;
	tools: ToolTiming[];
}

interface ActiveTool {
	name: string;
	startedAt: number;
	startOffsetMs: number;
}

interface ActiveCycle {
	turnIndex: number;
	startedAt: number;
	startedWallTime: number;
	providerRequestAt?: number;
	firstGeneratedAt?: number;
	generationEndedAt?: number;
	providerAttempts: number;
	tools: ToolTiming[];
	activeTools: Map<string, ActiveTool>;
}

interface ToolTimingStat extends ToolStat {
	timedCount: number;
	totalMs: number;
	maxMs: number;
}

function now(): number {
	return performance.now();
}

function bumpToolStat(map: Map<string, ToolStat>, name: string, errorOnly: boolean) {
	const stat = map.get(name) ?? { count: 0, errors: 0 };
	if (errorOnly) stat.errors++;
	else stat.count++;
	map.set(name, stat);
}

function computeToolStats(branch: readonly SessionEntry[]): Map<string, ToolStat> {
	const overall = new Map<string, ToolStat>();
	const toolNameByCallId = new Map<string, string>();

	for (const entry of branch) {
		if (entry.type !== "message") continue;
		const message = entry.message;

		if (message.role === "assistant") {
			for (const part of (message as AssistantMessage).content) {
				if (part.type !== "toolCall") continue;
				toolNameByCallId.set(part.id, part.name);
				bumpToolStat(overall, part.name, false);
			}
		} else if (message.role === "toolResult" && message.isError) {
			const name = toolNameByCallId.get(message.toolCallId) ?? message.toolName;
			bumpToolStat(overall, name, true);
		}
	}

	return overall;
}

function isPersistedCycle(value: unknown): value is PersistedCycle {
	if (!value || typeof value !== "object") return false;
	const cycle = value as Partial<PersistedCycle>;
	return (
		cycle.version === ENTRY_VERSION &&
		typeof cycle.turnIndex === "number" &&
		typeof cycle.startedAt === "number" &&
		typeof cycle.providerAttempts === "number" &&
		typeof cycle.outputTokens === "number" &&
		typeof cycle.elapsedMs === "number" &&
		typeof cycle.toolWallMs === "number" &&
		typeof cycle.toolSumMs === "number" &&
		typeof cycle.overheadMs === "number" &&
		Array.isArray(cycle.tools)
	);
}

function persistedCycles(branch: readonly SessionEntry[]): PersistedCycle[] {
	const cycles: PersistedCycle[] = [];
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
		if (isPersistedCycle(entry.data)) cycles.push(entry.data);
	}
	return cycles;
}

function mergedIntervalDuration(
	intervals: ReadonlyArray<{ startOffsetMs: number; endOffsetMs: number }>,
): number {
	if (intervals.length === 0) return 0;
	const sorted = intervals
		.map(({ startOffsetMs, endOffsetMs }) => ({
			start: Math.min(startOffsetMs, endOffsetMs),
			end: Math.max(startOffsetMs, endOffsetMs),
		}))
		.sort((a, b) => a.start - b.start || a.end - b.end);

	let total = 0;
	let start = sorted[0].start;
	let end = sorted[0].end;
	for (const interval of sorted.slice(1)) {
		if (interval.start <= end) {
			end = Math.max(end, interval.end);
		} else {
			total += end - start;
			start = interval.start;
			end = interval.end;
		}
	}
	return total + end - start;
}

function totalToolCalls(stats: Map<string, ToolStat>): number {
	let total = 0;
	for (const stat of stats.values()) total += stat.count;
	return total;
}

function cycleTps(cycle: PersistedCycle): number | undefined {
	if (!cycle.generationMs || cycle.generationMs <= 0 || cycle.outputTokens <= 0) return undefined;
	return cycle.outputTokens / (cycle.generationMs / 1000);
}

function formatDuration(ms: number | undefined): string {
	if (ms === undefined || !Number.isFinite(ms)) return "n/a";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
	const minutes = Math.floor(ms / 60_000);
	const seconds = (ms % 60_000) / 1000;
	return `${minutes}m ${seconds.toFixed(1)}s`;
}

function formatRate(rate: number | undefined): string {
	return rate === undefined || !Number.isFinite(rate) ? "n/a" : `${rate.toFixed(1)} TPS`;
}

function formatTokens(tokens: number): string {
	if (tokens < 1000) return `${tokens}`;
	if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
	return `${(tokens / 1_000_000).toFixed(1)}M`;
}

function percentage(part: number, whole: number): string {
	return whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "0.0%";
}

function aggregateToolTimings(
	cycles: readonly PersistedCycle[],
	counts: Map<string, ToolStat>,
): Map<string, ToolTimingStat> {
	const aggregate = new Map<string, ToolTimingStat>();
	for (const [name, stat] of counts) {
		aggregate.set(name, { ...stat, timedCount: 0, totalMs: 0, maxMs: 0 });
	}
	for (const cycle of cycles) {
		for (const tool of cycle.tools) {
			const stat = aggregate.get(tool.name) ?? {
				count: 0,
				errors: 0,
				timedCount: 0,
				totalMs: 0,
				maxMs: 0,
			};
			stat.timedCount++;
			stat.totalMs += tool.durationMs;
			stat.maxMs = Math.max(stat.maxMs, tool.durationMs);
			aggregate.set(tool.name, stat);
		}
	}
	return aggregate;
}

function formatToolTable(
	cycles: readonly PersistedCycle[],
	counts: Map<string, ToolStat>,
	theme: Theme,
): string[] {
	const tools = aggregateToolTimings(cycles, counts);
	if (tools.size === 0) return [theme.fg("dim", "  (none)")];

	const entries = Array.from(tools.entries()).sort((a, b) => b[1].count - a[1].count);
	const nameWidth = Math.max(4, ...entries.map(([name]) => name.length));
	const lines = [
		theme.fg(
			"dim",
			`  ${"tool".padEnd(nameWidth)}  calls  errors  timed  total       avg         max`,
		),
	];

	for (const [name, stat] of entries) {
		const average = stat.timedCount > 0 ? stat.totalMs / stat.timedCount : undefined;
		const errorText = `${stat.errors}`.padStart(6);
		lines.push(
			`  ${theme.fg("accent", name.padEnd(nameWidth))}` +
			`  ${theme.fg("text", `${stat.count}`.padStart(5))}` +
			`  ${theme.fg(stat.errors > 0 ? "error" : "muted", errorText)}` +
			`  ${theme.fg("muted", `${stat.timedCount}`.padStart(5))}` +
			`  ${theme.fg("text", formatDuration(stat.timedCount > 0 ? stat.totalMs : undefined).padStart(10))}` +
			`  ${theme.fg("text", formatDuration(average).padStart(10))}` +
			`  ${theme.fg("text", formatDuration(stat.timedCount > 0 ? stat.maxMs : undefined).padStart(10))}`,
		);
	}
	return lines;
}

function formatDetail(
	cycles: readonly PersistedCycle[],
	toolStats: Map<string, ToolStat>,
	theme: Theme,
): string {
	const lines: string[] = [];
	const activeMs = cycles.reduce((sum, cycle) => sum + cycle.elapsedMs, 0);
	const generationMs = cycles.reduce((sum, cycle) => sum + (cycle.generationMs ?? 0), 0);
	const toolWallMs = cycles.reduce((sum, cycle) => sum + cycle.toolWallMs, 0);
	const toolSumMs = cycles.reduce((sum, cycle) => sum + cycle.toolSumMs, 0);
	const overheadMs = cycles.reduce((sum, cycle) => sum + cycle.overheadMs, 0);
	const outputTokens = cycles.reduce((sum, cycle) => sum + cycle.outputTokens, 0);
	const timedOutputTokens = cycles.reduce(
		(sum, cycle) => sum + (cycle.generationMs && cycle.generationMs > 0 ? cycle.outputTokens : 0),
		0,
	);
	const weightedTps = generationMs > 0 ? timedOutputTokens / (generationMs / 1000) : undefined;
	const ttfts = cycles
		.map((cycle) => cycle.ttftMs)
		.filter((value): value is number => value !== undefined);
	const averageTtft = ttfts.length > 0 ? ttfts.reduce((sum, value) => sum + value, 0) / ttfts.length : undefined;

	lines.push(theme.bold(theme.fg("accent", "Conversation summary")));
	lines.push(`  Tracked model cycles: ${theme.fg("accent", `${cycles.length}`)}`);
	lines.push(`  Tool calls:           ${theme.fg("accent", `${totalToolCalls(toolStats)}`)}`);
	lines.push(`  Output tokens:        ${theme.fg("accent", formatTokens(outputTokens))}`);
	lines.push(`  Weighted throughput:  ${theme.fg("success", formatRate(weightedTps))}`);
	lines.push(
		`  TTFT avg/min/max:     ${theme.fg("text", formatDuration(averageTtft))} / ` +
			`${theme.fg("success", formatDuration(ttfts.length > 0 ? Math.min(...ttfts) : undefined))} / ` +
			`${theme.fg("warning", formatDuration(ttfts.length > 0 ? Math.max(...ttfts) : undefined))}`,
	);

	lines.push("");
	lines.push(theme.bold(theme.fg("accent", "Active processing time")));
	lines.push(`  Total:                ${theme.fg("accent", formatDuration(activeMs))}`);
	lines.push(
		`  Token generation:     ${theme.fg("success", formatDuration(generationMs))}` +
			`${theme.fg("dim", ` (${percentage(generationMs, activeMs)})`)}`,
	);
	lines.push(
		`  Tool use (wall):      ${theme.fg("warning", formatDuration(toolWallMs))}` +
			`${theme.fg("dim", ` (${percentage(toolWallMs, activeMs)})`)}`,
	);
	lines.push(
		`  Other/overhead:       ${theme.fg("muted", formatDuration(overheadMs))}` +
			`${theme.fg("dim", ` (${percentage(overheadMs, activeMs)})`)}`,
	);
	lines.push(`  Tool duration sum:    ${theme.fg("text", formatDuration(toolSumMs))}${theme.fg("dim", " (parallel calls overlap)")}`);

	if (cycles.length === 0) {
		lines.push("");
		lines.push(theme.fg("dim", "Timing data is recorded only for cycles completed after this extension was installed."));
	}

	lines.push("");
	lines.push(theme.bold(theme.fg("accent", "Tools (whole active branch)")));
	lines.push(...formatToolTable(cycles, toolStats, theme));

	lines.push("");
	lines.push(theme.bold(theme.fg("accent", "Model cycles")));
	if (cycles.length === 0) {
		lines.push(theme.fg("dim", "  (no tracked cycles)"));
	}

	cycles.forEach((cycle, index) => {
		const model = cycle.provider || cycle.model
			? `${cycle.provider ?? "unknown"}/${cycle.model ?? "unknown"}`
			: "unknown model";
		lines.push("");
		lines.push(
			theme.bold(theme.fg("accent", `Cycle ${index + 1}`)) +
				theme.fg("dim", ` · ${model}${cycle.stopReason ? ` · ${cycle.stopReason}` : ""}`),
		);
		lines.push(
			`  ${formatTokens(cycle.outputTokens)} output · ${formatRate(cycleTps(cycle))} · ` +
				`TTFT ${formatDuration(cycle.ttftMs)} · total ${formatDuration(cycle.elapsedMs)}`,
		);
		lines.push(
			`  generation ${formatDuration(cycle.generationMs)} · tools ${formatDuration(cycle.toolWallMs)} wall / ` +
				`${formatDuration(cycle.toolSumMs)} sum · overhead ${formatDuration(cycle.overheadMs)}`,
		);
		if (cycle.providerAttempts > 1) {
			lines.push(theme.fg("warning", `  provider attempts: ${cycle.providerAttempts}`));
		}
		if (cycle.tools.length > 0) {
			const tools = cycle.tools
				.map((tool) => `${tool.name} ${formatDuration(tool.durationMs)}${tool.isError ? " error" : ""}`)
				.join(" · ");
			lines.push(`  tools: ${tools}`);
		}
	});

	return lines.join("\n");
}

function statusText(
	ctx: ExtensionContext,
	cycle: ActiveCycle | undefined,
	cycles: readonly PersistedCycle[],
	toolStats: Map<string, ToolStat>,
): string {
	const theme = ctx.ui.theme;
	if (cycle) {
		const current = now();
		if (cycle.activeTools.size > 0) {
			const active = Array.from(cycle.activeTools.values());
			const elapsed = current - Math.min(...active.map((tool) => tool.startedAt));
			const label = active.length === 1 ? active[0].name : `${active.length} tools`;
			return theme.fg("warning", label) + theme.fg("dim", ` ${formatDuration(elapsed)}`);
		}
		if (cycle.firstGeneratedAt !== undefined && cycle.generationEndedAt === undefined) {
			return theme.fg("success", "generating") + theme.fg("dim", ` ${formatDuration(current - cycle.firstGeneratedAt)}`);
		}
		if (cycle.providerRequestAt !== undefined && cycle.firstGeneratedAt === undefined) {
			return theme.fg("accent", "waiting first token") +
				theme.fg("dim", ` ${formatDuration(current - cycle.providerRequestAt)}`);
		}
		return theme.fg("accent", "agent") + theme.fg("dim", ` ${formatDuration(current - cycle.startedAt)}`);
	}

	const last = cycles[cycles.length - 1];
	if (!last) return theme.fg("dim", `${totalToolCalls(toolStats)} tools · no timing yet`);
	return (
		theme.fg("success", formatRate(cycleTps(last))) +
		theme.fg("dim", " · TTFT ") +
		theme.fg("accent", formatDuration(last.ttftMs)) +
		theme.fg("dim", ` · ${totalToolCalls(toolStats)} tools`)
	);
}

export default function agentStatsExtension(pi: ExtensionAPI) {
	let activeCycle: ActiveCycle | undefined;
	let statusTimer: ReturnType<typeof setInterval> | undefined;

	function branchStats(ctx: ExtensionContext) {
		const branch = ctx.sessionManager.getBranch();
		return {
			cycles: persistedCycles(branch),
			tools: computeToolStats(branch),
		};
	}

	function refreshStatus(ctx: ExtensionContext) {
		if (activeCycle) {
			ctx.ui.setStatus(STATUS_ID, statusText(ctx, activeCycle, [], new Map()));
			return;
		}
		const stats = branchStats(ctx);
		ctx.ui.setStatus(STATUS_ID, statusText(ctx, undefined, stats.cycles, stats.tools));
	}

	function stopStatusTimer() {
		if (statusTimer) clearInterval(statusTimer);
		statusTimer = undefined;
	}

	function startStatusTimer(ctx: ExtensionContext) {
		stopStatusTimer();
		statusTimer = setInterval(() => refreshStatus(ctx), STATUS_REFRESH_MS);
		statusTimer.unref?.();
	}

	pi.on("session_start", async (_event, ctx) => {
		activeCycle = undefined;
		stopStatusTimer();
		ctx.ui.setStatus(LEGACY_STATUS_ID, undefined);
		refreshStatus(ctx);
	});

	pi.on("turn_start", async (event, ctx) => {
		activeCycle = {
			turnIndex: event.turnIndex,
			startedAt: now(),
			startedWallTime: Date.now(),
			providerAttempts: 0,
			tools: [],
			activeTools: new Map(),
		};
		refreshStatus(ctx);
		startStatusTimer(ctx);
	});

	pi.on("before_provider_request", async (_event, ctx) => {
		if (!activeCycle || activeCycle.firstGeneratedAt !== undefined) return;
		activeCycle.providerRequestAt = now();
		activeCycle.providerAttempts++;
		refreshStatus(ctx);
	});

	pi.on("message_update", async (event, ctx) => {
		if (!activeCycle) return;
		const streamEvent = event.assistantMessageEvent;
		const current = now();
		let phaseChanged = false;
		if (
			activeCycle.firstGeneratedAt === undefined &&
			(["text_delta", "thinking_delta", "toolcall_delta"] as GeneratedDeltaType[]).includes(
				streamEvent.type as GeneratedDeltaType,
			)
		) {
			activeCycle.firstGeneratedAt = current;
			phaseChanged = true;
		}
		if (streamEvent.type === "done" || streamEvent.type === "error") {
			activeCycle.generationEndedAt = current;
			phaseChanged = true;
		}
		if (phaseChanged) refreshStatus(ctx);
	});

	pi.on("message_end", async (event, ctx) => {
		if (!activeCycle || event.message.role !== "assistant") return;
		activeCycle.generationEndedAt ??= now();
		refreshStatus(ctx);
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		if (!activeCycle) return;
		const startedAt = now();
		activeCycle.activeTools.set(event.toolCallId, {
			name: event.toolName,
			startedAt,
			startOffsetMs: startedAt - activeCycle.startedAt,
		});
		refreshStatus(ctx);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		if (!activeCycle) return;
		const tool = activeCycle.activeTools.get(event.toolCallId);
		if (tool) {
			const endedAt = now();
			activeCycle.tools.push({
				name: tool.name,
				startOffsetMs: tool.startOffsetMs,
				endOffsetMs: endedAt - activeCycle.startedAt,
				durationMs: endedAt - tool.startedAt,
				isError: event.isError,
			});
			activeCycle.activeTools.delete(event.toolCallId);
		}
		refreshStatus(ctx);
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!activeCycle) return;
		const endedAt = now();

		for (const tool of activeCycle.activeTools.values()) {
			activeCycle.tools.push({
				name: tool.name,
				startOffsetMs: tool.startOffsetMs,
				endOffsetMs: endedAt - activeCycle.startedAt,
				durationMs: endedAt - tool.startedAt,
				isError: true,
			});
		}
		activeCycle.activeTools.clear();

		const assistant = event.message.role === "assistant" ? (event.message as AssistantMessage) : undefined;
		const elapsedMs = endedAt - activeCycle.startedAt;
		const generationMs =
			activeCycle.firstGeneratedAt !== undefined && activeCycle.generationEndedAt !== undefined
				? Math.max(0, activeCycle.generationEndedAt - activeCycle.firstGeneratedAt)
				: undefined;
		const ttftMs =
			activeCycle.providerRequestAt !== undefined && activeCycle.firstGeneratedAt !== undefined
				? Math.max(0, activeCycle.firstGeneratedAt - activeCycle.providerRequestAt)
				: undefined;
		const toolWallMs = mergedIntervalDuration(activeCycle.tools);
		const toolSumMs = activeCycle.tools.reduce((sum, tool) => sum + tool.durationMs, 0);
		const overheadMs = Math.max(0, elapsedMs - (generationMs ?? 0) - toolWallMs);

		const persisted: PersistedCycle = {
			version: ENTRY_VERSION,
			turnIndex: activeCycle.turnIndex,
			startedAt: activeCycle.startedWallTime,
			provider: assistant?.provider,
			model: assistant?.responseModel ?? assistant?.model,
			stopReason: assistant?.stopReason,
			providerAttempts: activeCycle.providerAttempts,
			outputTokens: assistant?.usage.output ?? 0,
			ttftMs,
			generationMs,
			elapsedMs,
			toolWallMs,
			toolSumMs,
			overheadMs,
			tools: activeCycle.tools,
		};

		pi.appendEntry(ENTRY_TYPE, persisted);
		activeCycle = undefined;
		stopStatusTimer();
		refreshStatus(ctx);
	});

	pi.on("session_shutdown", async () => {
		activeCycle = undefined;
		stopStatusTimer();
	});

	pi.registerCommand("agent-stats", {
		description: "Show model performance, timing, and tool usage for the active conversation branch",
		handler: async (_args, ctx) => {
			const stats = branchStats(ctx);
			const text = formatDetail(stats.cycles, stats.tools, ctx.ui.theme);
			await openPager(ctx, {
				title: "Agent Stats",
				source: textSource(text),
				plainText: text,
			});
		},
	});
}
