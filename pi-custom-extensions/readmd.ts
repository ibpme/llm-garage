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
import { extractTextParts } from "./shared/message-text.ts";
import { markdownSource, openPager } from "./shared/pager.ts";

function findLastAssistantText(ctx: ExtensionCommandContext): string | undefined {
	const branch = ctx.sessionManager.getBranch();

	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;

		const text = extractTextParts(entry.message.content).trim();
		if (text) return text;
	}

	return undefined;
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

			await openPager(ctx, {
				title: "Last Assistant Response",
				source: markdownSource(text),
				plainText: text,
			});
		},
	});
}
