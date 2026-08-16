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
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { openPager, textSource } from "./shared/pager.ts";

function estimateTokens(text: string): number {
	return Math.ceil(Array.from(text).length / 4);
}

async function show(
	title: string,
	content: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	await openPager(ctx, {
		title,
		source: textSource(content),
		footerChips: [`~${estimateTokens(content)} tokens`],
		plainText: content,
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
				await show("Append System Prompt", appendPrompt, ctx);
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

			await show("System Prompt", display, ctx);
		},
	});
}
