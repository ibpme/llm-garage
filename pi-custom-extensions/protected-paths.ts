/**
 * Protected Paths Extension
 *
 * Blocks write and edit operations to protected paths.
 * Useful for preventing accidental modifications to sensitive files.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerToolGuard } from "./shared/tool-guard.ts";

const PROTECTED_PATHS = [".git/", "node_modules/", ".venv"];

export default function(pi: ExtensionAPI) {
  registerToolGuard(pi, [
    {
      tools: ["write", "edit"],
      check: (event) => {
        const path = event.input.path as string;
        if (!PROTECTED_PATHS.some((p) => path.includes(p))) return undefined;

        return {
          action: "block",
          reason: `Path "${path}" is protected`,
          notify: `Blocked write to protected path: ${path}`,
        };
      },
    },
  ]);
}
