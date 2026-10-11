import { readFileSync } from "node:fs";
import type { KeyId } from "@earendil-works/pi-tui";

export const TOGGLE_ACTION = "extensions.suggestions.toggle";
const DEFAULT_KEYS: KeyId[] = ["ctrl+shift+s"];

export function loadToggleKeys(path: string): KeyId[] {
  try {
    const config: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!config || typeof config !== "object") return [...DEFAULT_KEYS];
    const value = (config as Record<string, unknown>)[TOGGLE_ACTION];
    const keys = typeof value === "string" ? [value] : value;
    if (Array.isArray(keys) && keys.every((key) => typeof key === "string" && key.trim().length > 0)) {
      return [...new Set(keys)] as KeyId[];
    }
  } catch {
    // Missing or malformed config must not prevent the extension from loading.
  }
  return [...DEFAULT_KEYS];
}
