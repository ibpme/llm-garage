/**
 * The single owner of pi's active tool set.
 *
 * Two things want to change which tools are active: the user's explicit
 * selection (via `/tools`) and the YOLO/SAFE mode mask. Modelling them as one
 * mutable list forces every writer to reconstruct the other's intent. Here they
 * are separate:
 *
 *   effective = mask(selection, mode)
 *
 * `selection` is the user's intent and is never touched by mode changes, so
 * leaving SAFE restores exactly what was selected before -- no bookkeeping of
 * "tools removed by SAFE" is needed. `pi.setActiveTools` is called from one
 * place, `apply()`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type Mode = "yolo" | "safe";

/** Removed from the active set while SAFE. */
export const BLOCKED_TOOLS = new Set(["write", "edit", "bash"]);
/** Read-only search tools added while SAFE. */
export const SAFE_EXTRA_TOOLS = ["grep", "find", "ls"] as const;
export const CHANGE_MODE_TOOL = "change_mode";
/** Only ever active while SAFE; stripped from the effective set in YOLO. */
export const SAFE_ONLY_TOOLS = new Set<string>([
	...SAFE_EXTRA_TOOLS,
	CHANGE_MODE_TOOL,
]);

export interface ToolSet {
	getMode(): Mode;
	setMode(next: Mode): void;
	toggleMode(): void;
	/**
	 * Drop per-session state without touching pi yet. Mode is in-memory only and
	 * every session starts YOLO; the caller restores the selection right after,
	 * which is what actually applies.
	 */
	beginSession(): void;
	/** The user's selection, with the mode mask *not* applied. */
	getSelection(): string[];
	setSelection(names: readonly string[]): void;
	/** Seed the selection from whatever pi currently has active. */
	adoptHostSelection(): void;
	/**
	 * Extend BLOCKED_TOOLS so SAFE mode also removes these names, e.g. a
	 * remote-tool variant registered by another extension. Mutates the same
	 * Set mask() reads, so it takes effect immediately.
	 */
	addBlockedTools(names: readonly string[]): void;
	/** Notified after any change that has been applied to pi. */
	onChange(listener: () => void): () => void;
}

export function createToolSet(pi: ExtensionAPI): ToolSet {
	let mode: Mode = "yolo";
	let selection: string[] = [];
	const listeners = new Set<() => void>();

	function mask(): string[] {
		if (mode === "yolo") {
			return selection.filter((name) => !SAFE_ONLY_TOOLS.has(name));
		}

		const available = new Set(pi.getAllTools().map((tool) => tool.name));
		const kept = selection.filter((name) => !BLOCKED_TOOLS.has(name));
		const extras = [...SAFE_ONLY_TOOLS].filter((name) => available.has(name));
		return [...new Set([...kept, ...extras])];
	}

	function apply() {
		pi.setActiveTools(mask());
		for (const listener of listeners) listener();
	}

	function switchMode(next: Mode) {
		mode = next;
		apply();
	}

	return {
		getMode: () => mode,

		setMode: switchMode,

		toggleMode() {
			switchMode(mode === "safe" ? "yolo" : "safe");
		},

		beginSession() {
			mode = "yolo";
			selection = [];
		},

		getSelection: () => [...selection],

		setSelection(names) {
			selection = [...new Set(names)];
			apply();
		},

		adoptHostSelection() {
			// Safe-only tools may already be active -- registered during startup or
			// restored by another extension -- and must not leak into the selection,
			// or YOLO would keep re-adding them.
			selection = pi
				.getActiveTools()
				.filter((name) => !SAFE_ONLY_TOOLS.has(name));
			apply();
		},

		addBlockedTools(names) {
			// Deliberately does NOT call apply(): callers (e.g. ssh.ts) do this
			// from their own session_start, which may run before this extension's
			// own session_start has restored the selection. Applying an empty
			// `selection` there makes adoptHostSelection()'s "seed from what pi
			// has active" fallback adopt that empty result, silently zeroing the
			// tool set for the session. mask() reads BLOCKED_TOOLS live, so the
			// next real apply() picks these up anyway.
			for (const name of names) BLOCKED_TOOLS.add(name);
		},

		onChange(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}
