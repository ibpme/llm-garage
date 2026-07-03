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

const VIEWPORT_LINES = 28;

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

	await ctx.ui.custom((_tui, theme, _kb, done) => {
		let allLines: string[] = [];
		let offset = 0;
		let pendingG = false;

		const pad = (s: string, len: number) => {
			const vis = visibleWidth(s);
			return s + " ".repeat(Math.max(0, len - vis));
		};

		const render = (width: number) => {
			const innerW = Math.max(1, width - 2);
			allLines = wrapAll(content, innerW);

			const maxOffset = Math.max(0, allLines.length - VIEWPORT_LINES);
			offset = Math.min(offset, maxOffset);

			const lines: string[] = [];
			lines.push(theme.fg("border", `╭${"─".repeat(innerW)}╮`));

			const titleLine = ` ${theme.fg("accent", theme.bold(title))}`;
			lines.push(theme.fg("border", "│") + pad(titleLine, innerW) + theme.fg("border", "│"));
			lines.push(theme.fg("border", `├${"─".repeat(innerW)}┤`));

			const visible = allLines.slice(offset, offset + VIEWPORT_LINES);
			for (const line of visible) {
				lines.push(theme.fg("border", "│") + pad(line, innerW) + theme.fg("border", "│"));
			}
			for (let i = visible.length; i < VIEWPORT_LINES; i++) {
				lines.push(theme.fg("border", "│") + " ".repeat(innerW) + theme.fg("border", "│"));
			}

			lines.push(theme.fg("border", `├${"─".repeat(innerW)}┤`));

			const footerParts: string[] = [];
			if (allLines.length > VIEWPORT_LINES) {
				footerParts.push(
					`${offset + 1}-${Math.min(offset + VIEWPORT_LINES, allLines.length)}/${allLines.length}`,
				);
			}
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
				const maxOffset = Math.max(0, allLines.length - VIEWPORT_LINES);

				if (matchesKey(data, "escape") || data === "q" || data === "Q") {
					done(undefined);
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
				} else if (matchesKey(data, "pageup") || data === "\x15") {
					// Ctrl+u = half page up
					offset = Math.max(0, offset - Math.floor(VIEWPORT_LINES / 2));
					pendingG = false;
				} else if (matchesKey(data, "pagedown") || data === "\x04") {
					// Ctrl+d = half page down
					offset = Math.min(maxOffset, offset + Math.floor(VIEWPORT_LINES / 2));
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
