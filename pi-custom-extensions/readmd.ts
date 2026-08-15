/**
 * Last Assistant Markdown Viewer Extension
 *
 * Adds a `/readmd` command that renders the most recent assistant response
 * as Markdown in a scrollable viewer.
 *
 * Usage:
 *   /readmd - Show the last assistant response
 */
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
	Markdown,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	return content
		.filter(
			(part): part is { type: "text"; text: string } =>
				!!part &&
				typeof part === "object" &&
				(part as { type?: unknown }).type === "text" &&
				typeof (part as { text?: unknown }).text === "string",
		)
		.map((part) => part.text)
		.join("\n");
}

function findLastAssistantText(ctx: ExtensionCommandContext): string | undefined {
	const branch = ctx.sessionManager.getBranch();

	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;

		const text = extractText(entry.message.content).trim();
		if (text) return text;
	}

	return undefined;
}

async function showMarkdown(
	content: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (ctx.mode !== "tui") {
		console.log("\n=== Last Assistant Response ===\n");
		console.log(content);
		console.log("");
		return;
	}

	await ctx.ui.custom((tui, theme, _kb, done) => {
		// Markdown is Pi's built-in renderer. The surrounding component provides
		// the viewport because extension custom components are mounted inside the
		// editor container, which does not propagate ScrollView layout constraints.
		const markdown = new Markdown(content, 0, 0, getMarkdownTheme());
		let allLines: string[] = [];
		let offset = 0;
		let viewportLines = 1;
		let compact = false;
		let pendingG = false;
		let renderedWidth = 0;

		const fit = (text: string, width: number): string =>
			truncateToWidth(text, Math.max(0, width), "", false);

		const pad = (text: string, width: number): string => {
			const fitted = fit(text, width);
			return fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted)));
		};

		const render = (width: number): string[] => {
			const innerWidth = Math.max(1, width - 2);
			const contentWidth = Math.max(1, innerWidth - 2);

			compact = tui.terminal.rows < 8;
			viewportLines = compact
				? Math.max(0, tui.terminal.rows - 1)
				: Math.max(1, tui.terminal.rows - 9);

			if (renderedWidth !== contentWidth) {
				allLines = markdown.render(contentWidth);
				renderedWidth = contentWidth;
			}

			const maxOffset = Math.max(0, allLines.length - viewportLines);
			offset = Math.min(offset, maxOffset);

			const title = fit("Last Assistant Response", Math.max(0, innerWidth - 1));
			const titleLine = ` ${theme.fg("accent", theme.bold(title))}`;
			const visible = allLines.slice(offset, offset + viewportLines);
			const lines: string[] = [];

			if (compact) {
				if (tui.terminal.rows > 0) lines.push(pad(titleLine, innerWidth));
				return lines.concat(visible.map((line) => fit(line, innerWidth)));
			}

			lines.push(theme.fg("border", `╭${"─".repeat(innerWidth)}╮`));
			const titlePadding = " ".repeat(
				Math.max(0, innerWidth - 1 - visibleWidth(title)),
			);
			lines.push(
				theme.fg("border", "│") +
					titleLine +
					titlePadding +
					theme.fg("border", "│"),
			);
			lines.push(theme.fg("border", `├${"─".repeat(innerWidth)}┤`));

			for (const line of visible) {
				lines.push(
					theme.fg("border", "│") +
						pad(line, innerWidth) +
						theme.fg("border", "│"),
				);
			}
			for (let index = visible.length; index < viewportLines; index++) {
				lines.push(
					theme.fg("border", "│") +
						" ".repeat(innerWidth) +
						theme.fg("border", "│"),
				);
			}

			lines.push(theme.fg("border", `├${"─".repeat(innerWidth)}┤`));

			const footerParts: string[] = [];
			if (allLines.length > viewportLines) {
				footerParts.push(
					`${offset + 1}-${Math.min(offset + viewportLines, allLines.length)}/${allLines.length}`,
				);
			}
			footerParts.push("↑↓/jkhl scroll • PageUp/PageDown • gg/G home/end • Esc/q close");
			const footer = " " + theme.fg("dim", footerParts.join("  "));
			lines.push(
				theme.fg("border", "│") +
					pad(footer, innerWidth) +
					theme.fg("border", "│"),
			);
			lines.push(theme.fg("border", `╰${"─".repeat(innerWidth)}╯`));

			return lines;
		};

		return {
			render,
			invalidate: () => {
				markdown.invalidate();
				renderedWidth = 0;
			},
			handleInput: (data: string) => {
				const maxOffset = Math.max(0, allLines.length - viewportLines);

				if (matchesKey(data, "escape") || data === "q" || data === "Q") {
					done(undefined);
					tui.requestRender(true);
					return;
				}

				if (data === "g") {
					if (pendingG) {
						offset = 0;
						pendingG = false;
					} else {
						pendingG = true;
						return;
					}
				} else if (data === "G" || matchesKey(data, "end")) {
					offset = maxOffset;
					pendingG = false;
				} else if (data === "j" || data === "l" || matchesKey(data, "down")) {
					offset = Math.min(maxOffset, offset + 1);
					pendingG = false;
				} else if (data === "k" || data === "h" || matchesKey(data, "up")) {
					offset = Math.max(0, offset - 1);
					pendingG = false;
				} else if (matchesKey(data, "pageUp") || data === "\x15") {
					offset = Math.max(0, offset - Math.max(1, Math.floor(viewportLines / 2)));
					pendingG = false;
				} else if (matchesKey(data, "pageDown") || data === "\x04") {
					offset = Math.min(maxOffset, offset + Math.max(1, Math.floor(viewportLines / 2)));
					pendingG = false;
				} else if (matchesKey(data, "home")) {
					offset = 0;
					pendingG = false;
				} else {
					pendingG = false;
				}

				tui.requestRender();
			},
		};
	});
}

export default function readmdExtension(pi: ExtensionAPI) {
	pi.registerCommand("readmd", {
		description: "View the last assistant response as rendered Markdown",
		handler: async (_args, ctx) => {
			const text = findLastAssistantText(ctx);
			if (!text) {
				ctx.ui.notify("No assistant response found", "warning");
				return;
			}

			await showMarkdown(text, ctx);
		},
	});
}
