import type { KeyId } from "@earendil-works/pi-tui";
import { loadShortcutKeys } from "../shared/shortcut-config.ts";

export const TOGGLE_ACTION = "extensions.suggestions.toggle";
const DEFAULT_KEYS: KeyId[] = ["ctrl+shift+s"];

export function loadToggleKeys(path: string): KeyId[] {
  return loadShortcutKeys(path, TOGGLE_ACTION, DEFAULT_KEYS);
}
