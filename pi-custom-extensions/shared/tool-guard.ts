/**
 * Declarative `tool_call` guards.
 *
 * Owns the ceremony every guard repeats: filtering by tool name, branching on
 * `ctx.hasUI`, asking for confirmation, notifying, and shaping the
 * `{ block, reason }` return value. Callers supply only the policy.
 *
 * Stateless -- pi instantiates this module once per importing extension.
 */

import type {
	ExtensionAPI,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";

/** What a rule decides about a single tool call. `undefined` means "allow". */
export type GuardVerdict =
	| {
			action: "block";
			/** Sent back to the model. */
			reason: string;
			/** Shown to the user as a warning, when a UI is attached. */
			notify?: string;
	  }
	| {
			action: "confirm";
			/** Question shown to the user. */
			prompt: string;
			/** Sent back to the model when the user declines. */
			denyReason: string;
			/** Sent back to the model when there is no UI to ask through. */
			noUIReason: string;
	  };

/**
 * `ToolCallEvent` is a union discriminated on `toolName`, and the runner filters
 * by name rather than narrowing, so rules see the input untyped and cast the
 * fields they declared `tools` for.
 */
export interface GuardEvent {
	toolName: string;
	input: Record<string, unknown>;
}

export interface ToolGuardRule {
	/** Tool names this rule applies to. Empty means every tool. */
	tools: readonly string[];
	check(event: GuardEvent): GuardVerdict | undefined;
}

/**
 * Register one `tool_call` handler that runs `rules` in order. The first rule
 * returning a verdict decides the call; later rules are not consulted.
 */
export function registerToolGuard(
	pi: ExtensionAPI,
	rules: readonly ToolGuardRule[],
): void {
	pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult | undefined> => {
		for (const rule of rules) {
			if (rule.tools.length > 0 && !rule.tools.includes(event.toolName)) {
				continue;
			}

			const verdict = rule.check(event);
			if (!verdict) continue;

			if (verdict.action === "block") {
				if (verdict.notify && ctx.hasUI) {
					ctx.ui.notify(verdict.notify, "warning");
				}
				return { block: true, reason: verdict.reason };
			}

			if (!ctx.hasUI) {
				return { block: true, reason: verdict.noUIReason };
			}

			const choice = await ctx.ui.select(verdict.prompt, ["Yes", "No"]);
			if (choice !== "Yes") {
				return { block: true, reason: verdict.denyReason };
			}
		}

		return undefined;
	});
}
