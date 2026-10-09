export type Mode = "yolo" | "safe";

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
   * Extend the instance-owned blocked tools so SAFE mode also removes these names, e.g. a
   * remote-tool variant registered by another extension. Mutates the same
   * Set mask() reads, so it takes effect immediately.
   */
  addBlockedTools(names: readonly string[]): void;
  /**
   * Whether SAFE mode refuses this tool: the blocked built-ins, and any MCP
   * tool not annotated `readOnlyHint: true` (MCP's default is not read-only).
   * Use this as the tool_call guard, since codemode scripts reach MCP tools
   * without going through the active set.
   */
  isBlockedInSafe(name: string): boolean;
  /** Notified after any change that has been applied to pi. */
  onChange(listener: () => void): () => void;
}
