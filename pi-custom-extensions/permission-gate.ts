/**
 * Permission Gate Extension
 *
 * Prompts for confirmation before running potentially dangerous bash commands.
 * Patterns checked: rm -rf, sudo, chmod/chown 777
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerToolGuard } from "./shared/tool-guard.ts";

const DANGEROUS_PATTERNS = [
  /\brm\s+(-rf?|--recursive)/i,
  /\bsudo\b/i,
  /\b(chmod|chown)\b.*777/i,
];

export default function(pi: ExtensionAPI) {
  registerToolGuard(pi, [
    {
      tools: ["bash"],
      check: (event) => {
        const command = event.input.command as string;
        if (!DANGEROUS_PATTERNS.some((pattern) => pattern.test(command))) {
          return undefined;
        }

        return {
          action: "confirm",
          prompt: `Dangerous command:\n\n  ${command}\n\nAllow?`,
          denyReason: "Blocked by user",
          noUIReason: "Dangerous command blocked (no UI for confirmation)",
        };
      },
    },
  ]);
}
