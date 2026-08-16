/**
 * SAFE-mode context reminder.
 *
 * The active tool list normally communicates this state on its own. The extra
 * reminder matters when the user toggles mode part-way through an agent run,
 * since the model has already seen the old tool set in its context.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ToolSet } from "./state.ts";

const CUSTOM_TYPE = "safe-mode-context";

const REMINDER = `
<system-reminder>
  [SAFE MODE ACTIVE]
  The write, edit, and bash tools are not currently in your active toolset — they have been removed, not just blocked.
  Do not attempt to call them; retrying will not surface new information. grep, find, and ls are available in their place for read-only search and inspection.
  If a change is needed, call the change_mode tool with mode: "yolo" to request full tool access. The user can also run /yolo, /auto, or press shift+tab directly at any time.
</system-reminder>
`;

export function registerSafeContext(pi: ExtensionAPI, toolSet: ToolSet) {
	pi.on("context", async (event) => {
		const messages = event.messages.filter(
			(message) =>
				(message as AgentMessage & { customType?: string }).customType !==
				CUSTOM_TYPE,
		);
		const staleMessageRemoved = messages.length !== event.messages.length;

		if (toolSet.getMode() !== "safe") {
			return staleMessageRemoved ? { messages } : undefined;
		}

		return {
			messages: [
				// Keep this stable at the beginning of the context so later requests
				// remain append-only and can reuse the provider's cached prefix.
				{
					role: "user",
					customType: CUSTOM_TYPE,
					content: REMINDER,
					display: false,
					timestamp: 0,
				},
				...messages,
			],
		};
	});
}
