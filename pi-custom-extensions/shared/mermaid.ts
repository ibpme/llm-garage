import { Marked, type Token, type Tokens } from "@earendil-works/pi-tui";
import { render } from "grok-mermaid";

interface MermaidTheme {
	fg(color: "accent" | "borderMuted" | "muted" | "text" | "warning", text: string): string;
	bold(text: string): string;
}

const markdownParser = new Marked();

function isMermaid(token: Token): token is Tokens.Code {
	return token.type === "code" && token.lang?.trim().split(/\s+/, 1)[0]?.toLowerCase() === "mermaid";
}

function codeSpan(line: string): string {
	const content = line || "\u00a0";
	const longestBacktickRun = Math.max(0, ...Array.from(content.matchAll(/`+/g), (match) => match[0].length));
	const fence = "`".repeat(longestBacktickRun + 1);
	const padding = content.startsWith("`") || content.endsWith("`") ? " " : "";
	return `${fence}${padding}${content}${padding}${fence}`;
}

function styleSpan(span: { cls: string; text: string }, theme: MermaidTheme): string {
	switch (span.cls) {
		case "border":
			return theme.fg("borderMuted", span.text);
		case "text":
			return theme.fg("text", span.text);
		case "edge":
			return theme.fg("accent", span.text);
		case "edgeLabel":
			return theme.fg("muted", span.text);
		case "title":
			return theme.fg("accent", theme.bold(span.text));
		default:
			return span.text;
	}
}

/**
 * Matches Pi's built-in Mermaid Markdown transformation for a finalized
 * response. The public Markdown component accepts the resulting Markdown.
 */
export function renderMermaidMarkdown(markdown: string, availableWidth: number, theme: MermaidTheme): string {
	return markdownParser
		.lexer(markdown)
		.map((token) => {
			if (!isMermaid(token)) return token.raw;

			const art = render(token.text);
			if (!art || art.width > availableWidth) return token.raw;

			if (art.warnings.length > 0) {
				const suffix = art.warnings.length > 1 ? ` (+${art.warnings.length - 1} more)` : "";
				const warning = theme.fg("warning", `Mermaid diagram not rendered: ${art.warnings[0]}${suffix}`);
				return `${token.raw}\n${codeSpan(warning)}  \n`;
			}

			const lines = art.styled.map((row) => row.map((span) => styleSpan(span, theme)).join(""));
			return `${lines.map(codeSpan).join("  \n")}\n`;
		})
		.join("");
}
