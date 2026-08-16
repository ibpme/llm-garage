/**
 * Bordered, scrollable full-content viewer.
 *
 * Extension custom components are mounted inside the editor container, which
 * does not propagate ScrollView layout constraints, so the viewport has to be
 * built by hand. This module owns that: the frame, the viewport arithmetic,
 * the key map, and the non-TUI console fallback. Callers supply a title and a
 * `PagerSource` that turns a width into lines.
 *
 * Stateless -- pi instantiates this module once per importing extension.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
	Markdown,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

const KEYMAP_HINT =
	"↑↓/jk scroll • PageUp/PageDown • gg/G home/end • Esc/q close";

/** Rows the frame itself consumes, plus the host's surrounding layout. */
const FRAME_ROWS = 9;
/** Below this the frame is dropped entirely and only content is drawn. */
const COMPACT_ROWS = 8;

export interface PagerSource {
	/** Every line of the content, laid out for `width` columns. */
	lines(width: number): string[];
	/** Drop any cached layout; the host is about to re-render from scratch. */
	invalidate?(): void;
}

export interface PagerOptions {
	title: string;
	source: PagerSource;
	/** Extra footer chips shown before the key hint, e.g. `["~1234 tokens"]`. */
	footerChips?: string[];
	/** Printed verbatim when there is no TUI to draw into. */
	plainText: string;
}

const fit = (text: string, width: number): string =>
	truncateToWidth(text, Math.max(0, width), "", false);

const pad = (text: string, width: number): string => {
	const fitted = fit(text, width);
	return fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted)));
};

/** Wrap on spaces where possible, hard-cutting words longer than the width. */
function wrapPlainText(text: string, width: number): string[] {
	const out: string[] = [];

	for (const line of text.split("\n")) {
		if (visibleWidth(line) <= width) {
			out.push(line);
			continue;
		}

		let remaining = line;
		while (visibleWidth(remaining) > width) {
			let cut = width;
			for (let index = width; index > 0; index--) {
				if (remaining[index] === " ") {
					cut = index;
					break;
				}
			}
			out.push(remaining.slice(0, cut));
			remaining = remaining.slice(cut).trimStart();
		}
		if (remaining.length > 0) out.push(remaining);
	}

	return out;
}

/** Plain text, word-wrapped to the viewport. Layout is cached per width. */
export function textSource(content: string): PagerSource {
	let cachedWidth = -1;
	let cachedLines: string[] = [];

	return {
		lines(width) {
			if (cachedWidth !== width) {
				cachedLines = wrapPlainText(content, width);
				cachedWidth = width;
			}
			return cachedLines;
		},
		invalidate() {
			cachedWidth = -1;
		},
	};
}

/**
 * Markdown rendered through pi's built-in renderer. Cached per width.
 *
 * The renderer is built on first use, not on construction: `getMarkdownTheme()`
 * requires an initialized TUI theme, and a source may legitimately be created
 * in a non-TUI session where openPager only ever prints the plain text.
 */
export function markdownSource(content: string): PagerSource {
	let markdown: Markdown | undefined;
	let cachedWidth = -1;
	let cachedLines: string[] = [];

	return {
		lines(width) {
			markdown ??= new Markdown(content, 0, 0, getMarkdownTheme());
			if (cachedWidth !== width) {
				cachedLines = markdown.render(width);
				cachedWidth = width;
			}
			return cachedLines;
		},
		invalidate() {
			markdown?.invalidate();
			cachedWidth = -1;
		},
	};
}

export async function openPager(
	ctx: ExtensionCommandContext,
	options: PagerOptions,
): Promise<void> {
	if (ctx.mode !== "tui") {
		console.log(`\n=== ${options.title} ===\n`);
		console.log(options.plainText);
		console.log("");
		return;
	}

	await ctx.ui.custom((tui, theme, _kb, done) => {
		let allLines: string[] = [];
		let offset = 0;
		let viewportLines = 1;
		let pendingG = false;

		const render = (width: number): string[] => {
			const innerWidth = Math.max(1, width - 2);
			const contentWidth = Math.max(1, innerWidth - 2);
			const compact = tui.terminal.rows < COMPACT_ROWS;

			viewportLines = compact
				? Math.max(0, tui.terminal.rows - 1)
				: Math.max(1, tui.terminal.rows - FRAME_ROWS);

			allLines = options.source.lines(contentWidth);
			offset = Math.min(offset, Math.max(0, allLines.length - viewportLines));

			const title = fit(options.title, Math.max(0, innerWidth - 1));
			const titleLine = ` ${theme.fg("accent", theme.bold(title))}`;
			const visible = allLines.slice(offset, offset + viewportLines);
			const lines: string[] = [];

			if (compact) {
				if (tui.terminal.rows > 0) lines.push(pad(titleLine, innerWidth));
				return lines.concat(visible.map((line) => fit(line, innerWidth)));
			}

			const frame = (body: string) =>
				theme.fg("border", "│") + body + theme.fg("border", "│");

			lines.push(theme.fg("border", `╭${"─".repeat(innerWidth)}╮`));
			lines.push(
				frame(
					titleLine +
						" ".repeat(Math.max(0, innerWidth - 1 - visibleWidth(title))),
				),
			);
			lines.push(theme.fg("border", `├${"─".repeat(innerWidth)}┤`));

			for (const line of visible) {
				lines.push(frame(pad(line, innerWidth)));
			}
			for (let index = visible.length; index < viewportLines; index++) {
				lines.push(frame(" ".repeat(innerWidth)));
			}

			lines.push(theme.fg("border", `├${"─".repeat(innerWidth)}┤`));

			const footerParts: string[] = [];
			if (allLines.length > viewportLines) {
				footerParts.push(
					`${offset + 1}-${Math.min(offset + viewportLines, allLines.length)}/${allLines.length}`,
				);
			}
			footerParts.push(...(options.footerChips ?? []));
			footerParts.push(KEYMAP_HINT);
			lines.push(
				frame(pad(` ${theme.fg("dim", footerParts.join("  "))}`, innerWidth)),
			);

			lines.push(theme.fg("border", `╰${"─".repeat(innerWidth)}╯`));
			return lines;
		};

		return {
			render,
			invalidate: () => options.source.invalidate?.(),
			handleInput: (data: string) => {
				const maxOffset = Math.max(0, allLines.length - viewportLines);
				const halfPage = Math.max(1, Math.floor(viewportLines / 2));

				if (matchesKey(data, "escape") || data === "q" || data === "Q") {
					done(undefined);
					// Ensure the restored editor is painted after custom() releases it.
					tui.requestRender(true);
					return;
				}

				if (data === "g") {
					// Vim-style gg (go to top); wait for the second press.
					if (!pendingG) {
						pendingG = true;
						return;
					}
					offset = 0;
				} else if (data === "G" || matchesKey(data, "end")) {
					offset = maxOffset;
				} else if (data === "j" || data === "l" || matchesKey(data, "down")) {
					offset = Math.min(maxOffset, offset + 1);
				} else if (data === "k" || data === "h" || matchesKey(data, "up")) {
					offset = Math.max(0, offset - 1);
				} else if (matchesKey(data, "pageUp") || data === "\x15") {
					// Ctrl+u = half page up
					offset = Math.max(0, offset - halfPage);
				} else if (matchesKey(data, "pageDown") || data === "\x04") {
					// Ctrl+d = half page down
					offset = Math.min(maxOffset, offset + halfPage);
				} else if (matchesKey(data, "home")) {
					offset = 0;
				}

				pendingG = false;
				tui.requestRender();
			},
		};
	});
}
