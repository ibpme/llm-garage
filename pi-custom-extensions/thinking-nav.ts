/**
 * Thinking Level Navigation Extension
 *
 * Shift+Left / Shift+Right step the thinking level backward/forward,
 * wrapping at both ends. Replaces the built-in Shift+Tab cycle, which is
 * disabled via "app.thinking.cycle": [] in ~/.pi/agent/keybindings.json so
 * Shift+Tab is free for the mode-toggle extension to claim instead.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"] as const;

export default function (pi: ExtensionAPI) {
	function step(delta: 1 | -1) {
		const current = THINKING_LEVELS.indexOf(pi.getThinkingLevel());
		const next = THINKING_LEVELS[(current + delta + THINKING_LEVELS.length) % THINKING_LEVELS.length];
		pi.setThinkingLevel(next);
	}

	pi.registerShortcut("shift+left", {
		description: "Previous thinking level",
		handler: () => step(-1),
	});

	pi.registerShortcut("shift+right", {
		description: "Next thinking level",
		handler: () => step(1),
	});
}
