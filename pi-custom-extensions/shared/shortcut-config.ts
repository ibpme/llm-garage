import { readFileSync } from "node:fs";
import type { KeyId } from "@earendil-works/pi-tui";

export function loadShortcutKeys(path: string, action: string, defaults: readonly KeyId[]): KeyId[] {
  try {
    const config: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (config && typeof config === "object") {
      const value = (config as Record<string, unknown>)[action];
      const keys = typeof value === "string" ? [value] : value;
      if (Array.isArray(keys) && keys.every((key) => typeof key === "string" && key.trim().length > 0)) {
        return [...new Set(keys)] as KeyId[];
      }
    }
  } catch {
    // Missing or malformed config must not prevent extension loading.
  }
  return [...defaults];
}
