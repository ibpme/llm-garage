/**
 * System Prompt Viewer Extension
 *
 * Adds a `/system-prompt` command to inspect the current system prompt
 * and any appended system prompt text separately in a scrollable viewer.
 *
 * Usage:
 *   /system-prompt        - Show system prompt and append prompt as separate sections
 *   /system-prompt append - Show only the appended system prompt text
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";

function estimateTokens(text: string): number {
	return Math.ceil(Array.from(text).length / 4);
}

async function showScrollableText(
	title: string,
	content: string,
	ctx: ExtensionCommandContext,
) {
	if (ctx.mode !== "tui") {
		console.log(`\n=== ${title} ===\n`);
		console.log(content);
		console.log("");
		return;
	}

	const estimatedTokens = estimateTokens(content);

	const wrapAll = (text: string, width: number): string[] => {
		const raw = text.split("\n");
		const out: string[] = [];
		for (const line of raw) {
			if (visibleWidth(line) <= width) {
				out.push(line);
				continue;
			}
			let remaining = line;
			while (visibleWidth(remaining) > width) {
				let cut = width;
				for (let i = width; i > 0; i--) {
					if (remaining[i] === " ") {
						cut = i;
						break;
					}
				}
				out.push(remaining.slice(0, cut));
				remaining = remaining.slice(cut).trimStart();
			}
			if (remaining.length > 0) out.push(remaining);
		}
		return out;
	};

	await ctx.ui.custom((tui, theme, _kb, done) => {
		let allLines: string[] = [];
		let offset = 0;
		let viewportLines = 1;
		let compact = false;
		let pendingG = false;

		const fit = (s: string, len: number) => {
			if (visibleWidth(s) <= len) return s;
			return Array.from(s).slice(0, Math.max(0, len - 1)).join("") + "…";
		};

		const pad = (s: string, len: number) => {
			const fitted = fit(s, len);
			return fitted + " ".repeat(Math.max(0, len - visibleWidth(fitted)));
		};

		const render = (width: number) => {
			const innerW = Math.max(1, width - 2);
			// Leave two extra rows for the host TUI's surrounding layout so the
			// frame's top border and title are never clipped.
			compact = tui.terminal.rows < 8;
			viewportLines = compact
				? Math.max(0, tui.terminal.rows - 1)
				: Math.max(1, tui.terminal.rows - 9);
			allLines = wrapAll(content, innerW);

			const maxOffset = Math.max(0, allLines.length - viewportLines);
			offset = Math.min(offset, maxOffset);

			const lines: string[] = [];
			const titleText = fit(title, Math.max(0, innerW - 1));
			const titleLine = ` ${theme.fg("accent", theme.bold(titleText))}`;
			if (compact) {
				if (tui.terminal.rows > 0) lines.push(pad(titleLine, innerW));
				return lines.concat(allLines.slice(offset, offset + viewportLines).map((line) => fit(line, innerW)));
			}
			lines.push(theme.fg("border", `╭${"─".repeat(innerW)}╮`));
			const titlePadding = " ".repeat(Math.max(0, innerW - 1 - visibleWidth(titleText)));
			lines.push(
				theme.fg("border", "│") + titleLine + titlePadding + theme.fg("border", "│"),
			);
			lines.push(theme.fg("border", `├${"─".repeat(innerW)}┤`));

			const visible = allLines.slice(offset, offset + viewportLines);
			for (const line of visible) {
				lines.push(theme.fg("border", "│") + pad(line, innerW) + theme.fg("border", "│"));
			}
			for (let i = visible.length; i < viewportLines; i++) {
				lines.push(theme.fg("border", "│") + " ".repeat(innerW) + theme.fg("border", "│"));
			}

			lines.push(theme.fg("border", `├${"─".repeat(innerW)}┤`));

			const footerParts: string[] = [];
			if (allLines.length > viewportLines) {
				footerParts.push(
					`${offset + 1}-${Math.min(offset + viewportLines, allLines.length)}/${allLines.length}`,
				);
			}
			footerParts.push(`~${estimatedTokens} tokens`);
			footerParts.push("↑↓/jk scroll • PageUp/PageDown • gg/G home/end • Esc/q close");
			const footer = " " + theme.fg("dim", footerParts.join("  "));
			lines.push(theme.fg("border", "│") + pad(footer, innerW) + theme.fg("border", "│"));

			lines.push(theme.fg("border", `╰${"─".repeat(innerW)}╯`));
			return lines;
		};

		return {
			render,
			invalidate: () => {},
			handleInput: (data: string) => {
				const maxOffset = Math.max(0, allLines.length - viewportLines);

				if (matchesKey(data, "escape") || data === "q" || data === "Q") {
					done(undefined);
					// Ensure the restored editor is painted after custom() releases it.
					tui.requestRender(true);
					return;
				}

				// Vim-style gg (go to top)
				if (data === "g") {
					if (pendingG) {
						offset = 0;
						pendingG = false;
					} else {
						pendingG = true;
						return;
					}
				} else if (data === "G") {
					offset = maxOffset;
					pendingG = false;
				} else if (data === "k" || matchesKey(data, "up")) {
					offset = Math.max(0, offset - 1);
					pendingG = false;
				} else if (data === "j" || matchesKey(data, "down")) {
					offset = Math.min(maxOffset, offset + 1);
					pendingG = false;
				} else if (matchesKey(data, "pageUp") || data === "\x15") {
					// Ctrl+u = half page up
					offset = Math.max(0, offset - Math.floor(viewportLines / 2));
					pendingG = false;
				} else if (matchesKey(data, "pageDown") || data === "\x04") {
					// Ctrl+d = half page down
					offset = Math.min(maxOffset, offset + Math.floor(viewportLines / 2));
					pendingG = false;
				} else if (matchesKey(data, "home")) {
					offset = 0;
					pendingG = false;
				} else if (matchesKey(data, "end")) {
					offset = maxOffset;
					pendingG = false;
				} else {
					pendingG = false;
				}
			},
		};
	});
}

export default function systemPromptExtension(pi: ExtensionAPI) {
	pi.registerCommand("system-prompt", {
		description: "View the current system prompt or append prompt",
		getArgumentCompletions: (prefix) => {
			const options = ["append"];
			const filtered = options.filter((o) => o.startsWith(prefix));
			return filtered.length > 0
				? filtered.map((o) => ({ value: o, label: o }))
				: null;
		},
		handler: async (args, ctx) => {
			const mode = args.trim();

			if (mode === "append") {
				const options = ctx.getSystemPromptOptions();
				const appendPrompt = options.appendSystemPrompt ?? "";
				if (!appendPrompt) {
					ctx.ui.notify("No append system prompt is currently set.", "info");
					return;
				}
				await showScrollableText("Append System Prompt", appendPrompt, ctx);
				return;
			}

			// Default: show system prompt and append prompt as separate sections
			const fullPrompt = ctx.getSystemPrompt();
			const options = ctx.getSystemPromptOptions();
			const appendPrompt = options.appendSystemPrompt;

			let basePrompt = fullPrompt;
			if (appendPrompt && fullPrompt.endsWith(appendPrompt)) {
				basePrompt = fullPrompt.slice(0, -appendPrompt.length).trimEnd();
			}

			let display = `--- System Prompt ---\n\n${basePrompt}`;
			if (appendPrompt) {
				display += `\n\n--- Append Prompt ---\n\n${appendPrompt}`;
			}

			await showScrollableText("System Prompt", display, ctx);
		},
	});
}
