import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { loadShortcutKeys } from "./shared/shortcut-config.ts";

export default function (pi: ExtensionAPI) {
  const keys = loadShortcutKeys(join(getAgentDir(), "keybindings.json"), "extensions.thinking.cycleBackward", [Key.shift("left")]);
  for (const key of keys) {
    pi.registerShortcut(key, {
      description: "Cycle thinking level backward",
      handler: (ctx) => {
        if (!ctx.model?.reasoning) {
          ctx.ui.notify("Current model does not support thinking", "info");
          return;
        }

        const levels = getSupportedThinkingLevels(ctx.model);
        if (levels.length === 0) return;
        const currentIndex = levels.indexOf(pi.getThinkingLevel());
        const previousIndex = currentIndex <= 0 ? levels.length - 1 : currentIndex - 1;
        pi.setThinkingLevel(levels[previousIndex]);
        ctx.ui.notify(`Thinking level: ${pi.getThinkingLevel()}`, "info");
      },
    });
  }
}
